#!/usr/bin/env node
/**
 * cap-refresh.js —— 刷新板上能力快照，并如实报告"这一轮板子变了什么"
 *
 * 为什么需要它：wf-doctor 的判断**全部**建立在 capability/iecu-capability.json 上，
 * 而这份快照会以两个方向骗人——
 *   · 装了新东西不刷新 → 报你"缺"刚装好的
 *   · **别人删了东西不刷新 → 报"模型全部就位"，实际一跑就缺**
 * 后一种在 2026-09-01 真实发生过：拿 8-14 的快照体检，四张工作流全绿，
 * 而板上的 ControlNet 与蒸馏 LoRA 早被清理掉了。**"全绿"因此是假象。**
 *
 * 它取代了 skill 里原来那套「板上跑 43-export-capability.sh → 归拢 → pull → 再单独拉
 * object_info」的四步流程（那个脚本其实并不存在，照着做第一步就失败）。
 * 现在一步：拉 /object_info，就地算出快照，并把差异打出来。
 *
 * 用法:
 *   node cap-refresh.js                    # 用 IECU_HOST，默认这块板
 *   node cap-refresh.js --host __BOARD_LAN_IP__
 *   node cap-refresh.js --quiet            # 只在有变化时输出
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const argv = process.argv.slice(2);
const o = {
  // 与 exec.js / push.js 统一走 IECU_HOST，避免"exec 连对了、这个连错了"
  host: process.env.IECU_HOST || '172.31.254.38',
  port: +(process.env.IECU_PANEL_PORT || 9000),
  prefix: '/comfy',
  quiet: false,
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--host') o.host = argv[++i];
  else if (a === '--port') o.port = +argv[++i];
  else if (a === '--prefix') { const v = argv[++i]; o.prefix = (v === 'none' || v === undefined) ? '' : v; }
  else if (a === '--quiet') o.quiet = true;
  else if (a === '-h' || a === '--help') {
    console.log('usage: node cap-refresh.js [--host H] [--port P] [--prefix /comfy] [--quiet]');
    process.exit(0);
  }
}

const capDir = path.join(__dirname, '..', 'capability');
const oiPath = path.join(capDir, 'object_info.json');
const capPath = path.join(capDir, 'iecu-capability.json');

const EXT = /\.(safetensors|gguf|ckpt|pt|pth|bin|onnx|sft|npz)$/i;

function get(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: o.host, port: o.port, path: urlPath, timeout: 120000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('超时（120 秒）')); });
  });
}

// 从 object_info 提取模型字段：字段值是 COMBO 且选项里有模型文件名
function extractModelFields(oi) {
  const modelFields = {};
  for (const [type, def] of Object.entries(oi)) {
    const inputs = (def && def.input) || {};
    for (const group of ['required', 'optional']) {
      const g = inputs[group];
      if (!g) continue;
      for (const [field, spec] of Object.entries(g)) {
        if (!Array.isArray(spec)) continue;
        let opts = spec[0];
        // 新旧两种 COMBO 表示法都要认：["a","b"] 与 {type:"COMBO",options:["a","b"]}
        if (opts && !Array.isArray(opts) && typeof opts === 'object' && Array.isArray(opts.options)) opts = opts.options;
        if (!Array.isArray(opts)) continue;
        const files = opts.filter(v => typeof v === 'string' && EXT.test(v));
        if (files.length) modelFields[type + '.' + field] = files;
      }
    }
  }
  return modelFields;
}

function flatModels(modelFields) {
  const s = new Set();
  for (const list of Object.values(modelFields)) for (const m of list) s.add(m);
  return s;
}

function ageText(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!isFinite(ms)) return '未知';
  const h = ms / 3600000;
  if (h < 1) return Math.round(ms / 60000) + ' 分钟前';
  if (h < 48) return h.toFixed(1) + ' 小时前';
  return (h / 24).toFixed(1) + ' 天前';
}

(async () => {
  const url = o.prefix + '/object_info';
  let raw;
  try {
    raw = await get(url);
  } catch (e) {
    console.error('✗ 拉取失败 http://' + o.host + ':' + o.port + url + ' —— ' + e.message);
    console.error('');
    console.error('  按这个顺序查（从最常见的开始）：');
    console.error('  1. 板子在不在生图模式？ComfyUI 在推理/车机模式下是停着的。');
    console.error('       node ../../.claude/skills/iecu/scripts/exec.js "systemctl is-active comfyui"');
    console.error('  2. 服务刚重启过？ComfyUI 要 20~40 秒才开始监听，systemd 说 active 不算数，');
    console.error('     判据是端口能应答（陷阱 51）。');
    console.error('  3. 连的是哪块板？当前 IECU_HOST=' + (process.env.IECU_HOST || '(未设置，用默认 172.31.254.38)'));
    console.error('     两块板不能同时上电，另一块此刻多半是关着的。');
    process.exit(1);
  }

  let oi;
  try {
    oi = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    console.error('✗ 返回的不是 JSON（' + raw.length + ' 字节）。多半是面板的登录页或错误页，不是 ComfyUI 的响应。');
    process.exit(1);
  }
  if (!oi || typeof oi !== 'object' || !Object.keys(oi).length) {
    console.error('✗ object_info 是空的，快照不会写入——宁可用旧的，也不要写一份空快照进去。');
    process.exit(1);
  }

  const old = fs.existsSync(capPath) ? JSON.parse(fs.readFileSync(capPath, 'utf8')) : null;
  const nodeTypes = Object.keys(oi).sort();
  const modelFields = extractModelFields(oi);
  const out = {
    generatedAt: new Date().toISOString(),
    source: 'http://' + o.host + ':' + o.port + url,
    nodeTypeCount: nodeTypes.length,
    nodeTypes,
    modelFields,
  };

  fs.writeFileSync(oiPath, raw);
  fs.writeFileSync(capPath, JSON.stringify(out, null, 2));

  // ── 差异报告：这一轮板子变了什么 ──────────────────────────
  const lines = [];
  if (old) {
    const oldTypes = new Set(old.nodeTypes || []);
    const newTypes = new Set(nodeTypes);
    const addedT = nodeTypes.filter(t => !oldTypes.has(t));
    const goneT = (old.nodeTypes || []).filter(t => !newTypes.has(t));
    const oldM = flatModels(old.modelFields || {});
    const newM = flatModels(modelFields);
    const addedM = [...newM].filter(m => !oldM.has(m)).sort();
    const goneM = [...oldM].filter(m => !newM.has(m)).sort();

    if (addedT.length) lines.push('  + 节点类型 ' + addedT.length + ' 个: ' + addedT.slice(0, 12).join(', ') + (addedT.length > 12 ? ' …' : ''));
    if (goneT.length) lines.push('  - 节点类型 ' + goneT.length + ' 个: ' + goneT.slice(0, 12).join(', ') + (goneT.length > 12 ? ' …' : ''));
    if (addedM.length) lines.push('  + 模型 ' + addedM.length + ' 个: ' + addedM.join(', '));
    if (goneM.length) {
      lines.push('  - 模型 ' + goneM.length + ' 个: ' + goneM.join(', '));
      lines.push('    ⚠ 少了模型：引用它们的工作流现在跑不了。是被清理了，还是别人挪走了？');
    }
    if (!o.quiet) lines.unshift('上一份快照 ' + ageText(old.generatedAt) + '（' + (old.generatedAt || '?') + '）');
  }

  if (o.quiet && !lines.length) process.exit(0);

  console.log('✅ 快照已刷新  节点类型 ' + nodeTypes.length + ' 种，模型 ' + flatModels(modelFields).size + ' 个');
  console.log('   来源 ' + out.source);
  if (lines.length) {
    console.log('--- 与上一份的差异 ---');
    for (const l of lines) console.log(l);
  } else if (old) {
    console.log('   与上一份快照无差异');
  }
  console.log('--- 板上当前可用模型 ---');
  const seen = new Set();
  for (const [k, v] of Object.entries(modelFields)) {
    const sig = v.join('|');
    if (seen.has(sig)) continue;
    seen.add(sig);
    console.log('   ' + k + ' => ' + v.join(', '));
  }
})();
