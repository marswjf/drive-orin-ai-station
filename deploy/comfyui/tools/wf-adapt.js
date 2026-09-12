#!/usr/bin/env node
/**
 * wf-adapt.js —— 把社区工作流改写成本板能跑的版本
 *
 * 设计原则（踩过坑总结出来的）：
 *   1. **只改必须改的**，其余原样保留。作者调过的 shift / dishonesty_factor /
 *      提示词都是作品的一部分，不要"顺手优化"。
 *   2. **换 loader 要连 widget 一起换**。UNETLoader 有 2 个 widget
 *      (unet_name, weight_dtype)，UnetLoaderGGUF 只有 1 个。多留一个会让
 *      ComfyUI 把 weight_dtype 当成第二个参数塞进去，报的错跟模型完全无关。
 *   3. **模型没有就 bypass，不要删节点**。mode=4 是 bypass，输入直通输出，
 *      链路不断；删节点会把下游连线全断掉，就是截图里那种"一堆断线"。
 *   4. 每条改动都写进 _iecu_adapt 记录，出图不对时能一眼看出改了什么。
 *
 * 用法: node wf-adapt.js <输入.json> <输出.json> --rules <规则.json>
 */
const fs = require('fs');

const argv = process.argv.slice(2);
let rulesPath = null;
const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--rules') rulesPath = argv[++i];
  else pos.push(argv[i]);
}
const [inPath, outPath] = pos;
if (!inPath || !outPath || !rulesPath) {
  console.error('usage: node wf-adapt.js <in.json> <out.json> --rules <rules.json>');
  process.exit(2);
}

const wf = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
const log = [];

const byId = new Map(wf.nodes.map(n => [String(n.id), n]));

for (const r of rules.changes) {
  const n = byId.get(String(r.node));
  if (!n) { log.push(`⚠ 找不到节点 ${r.node}，跳过：${r.why}`); continue; }
  const before = { type: n.type, widgets: JSON.parse(JSON.stringify(n.widgets_values || [])), mode: n.mode || 0 };

  if (r.newType && r.newType !== n.type) n.type = r.newType;
  if (r.widgets) n.widgets_values = r.widgets;
  if (r.bypass) n.mode = 4;                       // 4 = bypass，输入直通输出
  if (r.mute) n.mode = 2;                         // 2 = mute（不执行，输出为空）
  if (r.unbypass) n.mode = 0;
  // 换 loader 类型时，节点自带的 inputs 里可能残留旧类型的 widget-input（如 weight_dtype），
  // 留着会让前端把它当未连接的必填输入 → 报"缺少输入"
  if (r.dropInputs && Array.isArray(n.inputs)) {
    n.inputs = n.inputs.filter(i => !r.dropInputs.includes(i.name));
  }

  log.push(`节点 ${r.node} [${before.type}] → [${n.type}]  mode ${before.mode}→${n.mode || 0}\n` +
           `      widgets: ${JSON.stringify(before.widgets)} → ${JSON.stringify(n.widgets_values || [])}\n` +
           `      理由: ${r.why}`);
}

wf._iecu_adapt = {
  source: inPath.split(/[\\/]/).pop(),
  adaptedFor: rules.target || 'IECU 3.1 / Z-Image Turbo GGUF Q8_0',
  note: rules.note || '',
  changes: log,
};

fs.writeFileSync(outPath, JSON.stringify(wf, null, 1), 'utf8');
console.log('已生成 ' + outPath);
console.log('--- 改动清单 ---');
for (const l of log) console.log('  ' + l);
