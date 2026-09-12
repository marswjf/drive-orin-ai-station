#!/usr/bin/env node
/**
 * wf-to-api.js —— 把 UI 格式工作流（前端保存的 .json）转成 API 格式（POST /prompt 的 body）
 *
 * 为什么要它：从网上下载、前端导出的都是 UI 格式（有 nodes/links/位置信息）；
 * 而 ComfyUI 的 /prompt 接口只吃 API 格式（扁平的 {nodeId: {class_type, inputs}}）。
 * 没有这一步就只能靠人在浏览器里点"运行"，无法脚本化验证——而"没验证过的安装"
 * 正是本项目反复吃亏的地方。
 *
 * 三个必须处理对的细节（每个都会让转换结果静默出错）：
 *   1. **widgets_values 与输入名的对应**：widgets_values 只包含"不是连线"的输入，
 *      顺序按 /object_info 的 required 声明顺序。必须拿真实的 object_info 来对，
 *      不能靠猜——同名节点在不同版本里参数顺序会变。
 *   2. **seed 的隐藏伴随值**：INT 类型的 seed/noise_seed 后面会多一个
 *      control_after_generate（"randomize"/"fixed"…），它不是模型参数，要跳过。
 *      不跳的话后面所有参数集体错位，报的错会指向完全无关的字段。
 *   3. **bypass 节点要穿透**：mode=4 的节点在 API 格式里不存在，下游要直接连到它的
 *      上游同类型输入上。简单删掉会让下游变成"缺输入"。mode=2(mute) 则整条链断开。
 *
 * 用法: node wf-to-api.js <ui.json> <api输出.json> --object-info <object_info.json>
 */
const fs = require('fs');

const argv = process.argv.slice(2);
let oiPath = null;
const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--object-info') oiPath = argv[++i];
  else pos.push(argv[i]);
}
const [inPath, outPath] = pos;
if (!inPath || !outPath || !oiPath) {
  console.error('usage: node wf-to-api.js <ui.json> <api.json> --object-info <object_info.json>');
  process.exit(2);
}

const wf = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const OI = JSON.parse(fs.readFileSync(oiPath, 'utf8'));

const nodes = new Map(wf.nodes.map(n => [n.id, n]));
// links: [id, originNode, originSlot, targetNode, targetSlot, type]
const linkById = new Map((wf.links || []).map(l => [l[0], l]));

// ⚠ 2026-09-02 补两种 ComfyUI 新类型（H3 工作流上踩到）：
//   COMFY_DYNAMICCOMBO_V3 —— 值随选项联动的下拉（如 SaveVideo.codec），**是 widget，占 widgets_values 一格**。
//     漏了它 SaveVideo 就少一个必填参数，提交时报
//     `SaveVideo.execute() missing 1 required positional argument: 'codec'`，
//     而转换阶段的"无悬空引用"自检一路绿灯 —— 那个自检只查引用不查参数。
//   ⚠ 不要把 COMFY_AUTOGROW_V3 也加进来：它是**可增长的输入组**（如 ComfyMathExpression.values），
//     走的是连线，API 格式里正确展开为 `values.a` / `values.b`，不占 widgets_values。
//     把它当 widget 会让后面所有参数错位。
const WIDGET_PRIMS = ['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO', 'COMFY_DYNAMICCOMBO_V3'];
const isLinkType = (spec) => {
  // required 里，形如 ["MODEL"] / ["IMAGE"] 的是连线输入；其余是 widget。
  // ⚠ COMBO 在 ComfyUI 0.33 里有**两种写法并存**，都必须认：
  //     老式  sampler_name: [["euler","er_sde",...]]        ← 第 0 项是选项数组
  //     新式  sampler_name: ["COMBO", {options:[...]}]      ← 第 0 项是字符串 "COMBO"
  //   只认老式的话，新式 COMBO 会被当成连线输入而跳过，后面所有 widget 依次错位。
  //   错位的后果极其隐蔽：ComfyUI 不报错，任务 3 秒"成功"结束但一张图都不产出
  //   （实测 BasicScheduler 拿到 steps="sgm_uniform"、denoise=8 就是这么来的）。
  if (!Array.isArray(spec)) return false;
  const t = spec[0];
  if (Array.isArray(t)) return false;                 // 老式 COMBO
  return !WIDGET_PRIMS.includes(t);
};

function widgetNames(classType) {
  const def = OI[classType];
  if (!def) return null;
  const req = (def.input && def.input.required) || {};
  const opt = (def.input && def.input.optional) || {};
  const names = [];
  for (const [k, spec] of Object.entries(req)) {
    if (isLinkType(spec)) continue;
    names.push(k);
    // seed / noise_seed 这类带 control_after_generate 的，要在 widgets 数组里占两格
    const meta = Array.isArray(spec) && spec[1] ? spec[1] : {};
    if (meta.control_after_generate) names.push('__control__');
  }
  for (const [k, spec] of Object.entries(opt)) {
    if (isLinkType(spec)) continue;
    names.push(k);
  }
  return names;
}

// bypass 穿透：给定节点与输入名，找到真正的上游 [nodeId, slot]
function resolveUpstream(linkId, depth = 0) {
  if (linkId == null || depth > 32) return null;
  const l = linkById.get(linkId);
  if (!l) return null;
  const [, origin, originSlot] = l;
  const on = nodes.get(origin);
  if (!on) return null;
  if (on.mode === 2) return null;                       // mute：链断
  if (on.mode === 4) {
    // bypass：找这个节点上同类型的输入，继续往上追
    const outType = (on.outputs && on.outputs[originSlot] && on.outputs[originSlot].type) || null;
    const cand = (on.inputs || []).find(i => i.type === outType && i.link != null);
    if (!cand) return null;
    return resolveUpstream(cand.link, depth + 1);
  }
  return [String(origin), originSlot];
}

const api = {};
const warn = [];
for (const n of wf.nodes) {
  if (n.mode === 4 || n.mode === 2) continue;           // bypass/mute 节点不进 API
  const ct = n.type;
  if (ct === 'Note' || ct === 'MarkdownNote' || ct === 'Reroute') continue;
  if (!OI[ct]) { warn.push(`节点 ${n.id} 的类型 ${ct} 在 object_info 里不存在，已跳过`); continue; }

  const inputs = {};
  // 1) 连线输入
  for (const inp of (n.inputs || [])) {
    if (inp.link == null) continue;
    const up = resolveUpstream(inp.link);
    if (up) inputs[inp.name] = up;
  }
  // 2) widget 输入
  const names = widgetNames(ct) || [];
  const vals = n.widgets_values || [];
  const linked = new Set(Object.keys(inputs));
  let vi = 0;
  for (const nm of names) {
    if (vi >= vals.length) break;
    if (nm === '__control__') { vi++; continue; }       // 跳过 control_after_generate
    // ⚠ 已由连线提供的输入：**位置仍然占一格**，必须推进下标再 continue。
    //   前端把一个 widget 转成 input（例如用 rgthree 的 Seed 节点驱动 KSampler.seed）之后，
    //   widgets_values 数组里那一格的旧值**并不会被删掉**。不推进下标的话，
    //   后面所有参数集体错位一格——实测表现为 steps 收到 "randomize"、
    //   scheduler 收到 "euler"、denoise 收到 "simple"。
    if (linked.has(nm)) { vi++; continue; }
    inputs[nm] = vals[vi++];
  }
  api[String(n.id)] = { class_type: ct, inputs, _meta: { title: n.title || ct } };
}

fs.writeFileSync(outPath, JSON.stringify(api, null, 1), 'utf8');
console.log(`已生成 API 格式: ${outPath}（${Object.keys(api).length} 个节点）`);
for (const w of warn) console.log('  ⚠ ' + w);

// 自检：所有连线输入都指向存在的节点
let dangling = 0;
for (const [id, n] of Object.entries(api)) {
  for (const [k, v] of Object.entries(n.inputs)) {
    if (Array.isArray(v) && !api[v[0]]) { console.log(`  ⚠ 节点 ${id}.${k} 指向不存在的 ${v[0]}`); dangling++; }
  }
}
console.log(dangling ? `  ⚠ 悬空引用 ${dangling} 处` : '  自检通过：无悬空引用');
