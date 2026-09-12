#!/usr/bin/env node
/**
 * wf-doctor.js —— ComfyUI 工作流体检器
 *
 * 回答三个问题（全部基于事实，不靠猜）：
 *   1. 这个工作流用到的节点类型，板上**已注册**的有哪些、缺哪些？
 *      —— 依据 43-export-capability.sh 从运行中 ComfyUI 的 /object_info 导出的快照，
 *         而不是"custom_nodes 目录里有哪些文件夹"。包装了但 import 失败等于没装。
 *   2. 缺的节点属于哪个包、仓库在哪？
 *      —— 依据 ComfyUI-Manager 官方维护的 extension-node-map.json 反向索引，
 *         不靠包名猜测（"CR Text 听起来像 comfyroll" 这种推断经常错）。
 *   3. 这个工作流引用的模型，板上有没有？没有的话同类里有什么能替代？
 *      —— 依据 /object_info 里各 loader 下拉的真实取值。
 *
 * 用法:
 *   node wf-doctor.js <工作流.json|目录> [--cap capability/iecu-capability.json]
 *                                        [--map capability/extension-node-map.json]
 *                                        [--json 输出报告.json]
 */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const opt = { cap: null, map: null, json: null };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--cap') opt.cap = argv[++i];
  else if (argv[i] === '--map') opt.map = argv[++i];
  else if (argv[i] === '--json') opt.json = argv[++i];
  else positional.push(argv[i]);
}
if (!positional.length) {
  console.error('usage: node wf-doctor.js <工作流.json|目录> [--cap ...] [--map ...] [--json ...]');
  process.exit(2);
}

const here = __dirname;
const capPath = opt.cap || path.join(here, '..', 'capability', 'iecu-capability.json');
const mapPath = opt.map || path.join(here, '..', 'capability', 'extension-node-map.json');

const cap = JSON.parse(fs.readFileSync(capPath, 'utf8'));
const haveTypes = new Set(cap.nodeTypes);

// ── 快照新鲜度：这份体检的全部结论都建立在快照上，快照旧了结论就不可信 ──────
// 2026-09-01 的真实教训：拿 8-14 的快照体检，四张工作流全绿，
// 而板上的 ControlNet 与蒸馏 LoRA 早被清理掉了——**"全绿"是假象**。
// 快照会以两个方向骗人：装了不刷新报"缺"，别人删了不刷新报"有"。后者更阴险。
const capAgeH = (Date.now() - new Date(cap.generatedAt).getTime()) / 3600000;
const STALE_H = 6;
if (!(capAgeH >= 0)) {
  console.log('⚠ 快照没有可用的时间戳，无法判断新鲜度。建议先跑 cap-refresh.js。\n');
} else if (capAgeH > STALE_H) {
  const age = capAgeH > 48 ? (capAgeH / 24).toFixed(1) + ' 天' : capAgeH.toFixed(1) + ' 小时';
  console.log('⚠ 能力快照是 ' + age + '前的（' + cap.generatedAt + '）。');
  console.log('  这中间板子可能被动过——尤其有别的会话在用同一块板时。');
  console.log('  下面的"缺/不缺"结论以这份快照为准，先刷新再看：');
  console.log('      node ' + path.relative(process.cwd(), path.join(here, 'cap-refresh.js')).replace(/\\/g, '/') + '\n');
}

// 板上可用模型：字段名 -> [文件名]，以及一个扁平集合
const modelsByField = cap.modelFields || {};
const haveModels = new Set();
for (const list of Object.values(modelsByField)) for (const m of list) haveModels.add(m);

// 反向索引：节点类型 -> {repo, title}
const nodeToPack = new Map();
if (fs.existsSync(mapPath)) {
  const raw = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  for (const [repo, val] of Object.entries(raw)) {
    const types = Array.isArray(val) ? val[0] : [];
    const meta = Array.isArray(val) && val[1] ? val[1] : {};
    for (const t of types) {
      if (!nodeToPack.has(t)) nodeToPack.set(t, { repo, title: meta.title_aux || '' });
    }
  }
}

const MODEL_RE = /\.(safetensors|gguf|ckpt|pth|pt|bin|onnx|sft)$/i;

// ── 纯前端节点：不在 /object_info 里，但界面上完全可用 ──────────────────────
// 这类节点只由前端 js 注册，Python 侧没有对应实现，所以快照里查不到它们——
// 但它们既不在数据流上、也不参与执行，转 API 格式时会被自动跳过，出图不受影响。
// 不列进白名单的后果是**误报**：2026-09-01 体检「文生图4K极速版」时，
// Label 与 Fast Groups Bypasser 被判成"缺节点类型"，差点为此去装一个早就装好的包。
// rgthree 的这 15 个是实测差集：web/comfyui/constants.js 登记 36 个，
// 板上 /object_info 只注册 24 个（判据见 iecu skill 的 rgthree 那条）。
const FRONTEND_ONLY = new Set([
  'Note', 'MarkdownNote', 'Reroute', 'PrimitiveNode',
  'Bookmark (rgthree)', 'Dynamic Context (rgthree)', 'Dynamic Context Switch (rgthree)',
  'Fast Actions Button (rgthree)', 'Fast Bypasser (rgthree)', 'Fast Groups Bypasser (rgthree)',
  'Fast Groups Muter (rgthree)', 'Fast Muter (rgthree)', 'Label (rgthree)',
  'Mute / Bypass Relay (rgthree)', 'Mute / Bypass Repeater (rgthree)', 'Node Collector (rgthree)',
  'Power Conductor (rgthree)', 'Random Unmuter (rgthree)', 'Reroute (rgthree)',
]);

// 模型按类别归类，便于给替代建议
function categoryOf(field) {
  const f = field.toLowerCase();
  if (f.includes('lora')) return 'lora';
  if (f.includes('vae')) return 'vae';
  if (f.includes('unet') || f.includes('diffusion')) return 'unet/diffusion';
  if (f.includes('clip') || f.includes('text_encoder')) return 'clip/text_encoder';
  if (f.includes('control')) return 'controlnet';
  if (f.includes('upscale')) return 'upscale';
  if (f.includes('ckpt') || f.includes('checkpoint')) return 'checkpoint';
  return 'other';
}
const haveByCat = {};
for (const [field, list] of Object.entries(modelsByField)) {
  const c = categoryOf(field);
  (haveByCat[c] = haveByCat[c] || new Set());
  for (const m of list) haveByCat[c].add(m);
}

function guessCategory(name) {
  const n = name.toLowerCase();
  if (n.includes('lora') || n.includes('_lora')) return 'lora';
  if (n.includes('vae') || n === 'ae.safetensors') return 'vae';
  if (n.includes('controlnet') || n.includes('control')) return 'controlnet';
  if (n.includes('upscale') || n.endsWith('.pth')) return 'upscale';
  if (n.includes('clip') || n.includes('qwen_') || n.includes('_te') || n.includes('text_enc')) return 'clip/text_encoder';
  if (n.endsWith('.gguf')) return 'unet/diffusion';
  return 'unknown';
}

function analyze(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const nodes = j.nodes || [];
  const isApiFormat = !j.nodes && typeof j === 'object' &&
    Object.values(j).some(v => v && typeof v === 'object' && v.class_type);

  let types = new Map(), models = new Set(), bypassed = [], bypassedMissing = new Set();
  if (isApiFormat) {
    for (const n of Object.values(j)) {
      if (!n || !n.class_type) continue;
      types.set(n.class_type, (types.get(n.class_type) || 0) + 1);
      for (const v of Object.values(n.inputs || {}))
        if (typeof v === 'string' && MODEL_RE.test(v.trim())) models.add(v.trim());
    }
  } else {
    for (const n of nodes) {
      if (FRONTEND_ONLY.has(n.type)) continue;
      // mode 4 = bypass（输入直通输出）、2 = mute（不执行）——这两种节点不会真的加载模型，
      // 它们引用的模型缺失不影响能跑。不排除的话，一个 bypass 掉的 LoRA 会让整张工作流
      // 被误判成"不能跑"，正是这种误判让人反复去找根本不需要的模型。
      // ⚠ 但**类型**缺失要另算：前端只查类型注册与否，不看 mode，
      //   所以一个 bypass 掉的未注册类型照样在界面上飘红。单列出来提醒，不计入"不能跑"。
      if (n.mode === 4 || n.mode === 2) {
        bypassed.push(n.type);
        if (!haveTypes.has(n.type)) bypassedMissing.add(n.type);
        continue;
      }
      types.set(n.type, (types.get(n.type) || 0) + 1);
      const walk = (w) => {
        if (typeof w === 'string' && MODEL_RE.test(w.trim())) models.add(w.trim());
        else if (Array.isArray(w)) w.forEach(walk);
        else if (w && typeof w === 'object') Object.values(w).forEach(walk);
      };
      (n.widgets_values || []).forEach(walk);
    }
  }

  const missingTypes = [...types.keys()].filter(t => !haveTypes.has(t)).sort();
  const missingModels = [...models].filter(m => !haveModels.has(m)).sort();

  // 缺失节点按包归组
  const packs = new Map();
  const unknownTypes = [];
  for (const t of missingTypes) {
    const p = nodeToPack.get(t);
    if (!p) { unknownTypes.push(t); continue; }
    const key = p.repo;
    if (!packs.has(key)) packs.set(key, { title: p.title, types: [] });
    packs.get(key).types.push(t);
  }

  return {
    file: path.basename(file),
    format: isApiFormat ? 'API(prompt)' : 'UI(workflow)',
    nodeCount: isApiFormat ? types.size : nodes.length,
    typeCount: types.size,
    okTypes: types.size - missingTypes.length,
    missingTypes, packs: [...packs.entries()], unknownTypes,
    models: [...models].sort(), missingModels, bypassed,
    bypassedMissing: [...bypassedMissing].sort(),
  };
}

const target = positional[0];
const files = fs.statSync(target).isDirectory()
  ? fs.readdirSync(target).filter(f => f.endsWith('.json')).map(f => path.join(target, f))
  : [target];

const reports = [];
for (const f of files) {
  let r;
  try { r = analyze(f); } catch (e) { console.log('!! 解析失败 ' + path.basename(f) + ': ' + e.message); continue; }
  reports.push(r);
  const runnable = r.missingTypes.length === 0 && r.missingModels.length === 0;
  console.log('='.repeat(76));
  console.log((runnable ? '✅ 可直接跑  ' : '⛔ 还不能跑  ') + r.file);
  console.log(`   格式 ${r.format} | 节点 ${r.nodeCount} | 类型 ${r.typeCount}（板上已有 ${r.okTypes}）`);
  if (r.missingTypes.length) {
    console.log(`   --- 缺节点类型 ${r.missingTypes.length} 个，装这些包即可 ---`);
    for (const [repo, v] of r.packs)
      console.log(`       ${v.title || repo.split('/').pop()}\n         ${repo}\n         提供: ${v.types.join(', ')}`);
    if (r.unknownTypes.length)
      console.log(`       ⚠ 官方映射里查不到来源的类型: ${r.unknownTypes.join(', ')}`);
  }
  if (r.missingModels.length) {
    console.log(`   --- 缺模型 ${r.missingModels.length} 个 ---`);
    for (const m of r.missingModels) {
      const c = guessCategory(m);
      const alt = haveByCat[c] ? [...haveByCat[c]] : [];
      console.log(`       ${m}`);
      console.log(`         推测类别 ${c}｜板上同类: ${alt.length ? alt.join(', ') : '（无，必须下载）'}`);
    }
  }
  if (r.models.length && !r.missingModels.length) console.log('   模型全部就位');
  if (r.bypassed.length) console.log(`   （已 bypass/mute ${r.bypassed.length} 个节点，不参与判定: ${r.bypassed.join(', ')}）`);
  if (r.bypassedMissing.length) {
    console.log(`   ⚠ 其中 ${r.bypassedMissing.length} 个类型板上没有注册: ${r.bypassedMissing.join(', ')}`);
    console.log('     不影响出图（它们是 bypass 状态），但**前端打开会飘红**——前端只查类型注册与否，不看 mode。');
    console.log('     要么装上对应节点包，要么把这些节点从工作流里删掉。');
  }
}

console.log('='.repeat(76));
console.log('板上可用模型总览：');
for (const [c, s] of Object.entries(haveByCat)) console.log(`   ${c}: ${[...s].join(', ')}`);
console.log(`板上已注册节点类型：${cap.nodeTypeCount} 种（快照时间 ${cap.generatedAt}）`);

if (opt.json) { fs.writeFileSync(opt.json, JSON.stringify(reports, null, 1)); console.log('报告已写 ' + opt.json); }
