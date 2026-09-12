#!/usr/bin/env node
/**
 * wf-verify-api.js —— 转换后的验收闸：API 格式里每个节点的**必填参数**齐不齐
 *
 * 为什么要独立于 wf-to-api.js：转换器会随 ComfyUI 出新参数类型而不断出现盲区，
 * 修掉一个还会有下一个。2026-09-01 的实例——ComfyUI 给 `SaveVideo` 加了必填的 `codec`，
 * 类型是新的 `COMFY_DYNAMICCOMBO_V3`，转换器不认识就**静默漏掉**，
 * 提交时报的是 400 而不是"少了个参数"，很难一眼定位。
 *
 * 与其追着修转换器，不如加一道**与转换器无关**的闸：拿 /object_info 的 required 定义，
 * 逐个节点核对 API json 里的 inputs。转换器将来再出什么新盲区，这道闸都拦得住。
 *
 * 判据（缺一不可）：
 *   1. 每个 class_type 在板上确实注册过
 *   2. 该类型 required 里的每个字段，在 inputs 里都有值（字面值或 ["节点id", 槽位]）
 *   3. 引用的上游节点 id 确实存在（悬空引用）
 *
 * 用法:
 *   node wf-verify-api.js <api.json> [--object-info capability/object_info.json]
 */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
let apiPath = null, oiPath = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--object-info') oiPath = argv[++i];
  else apiPath = argv[i];
}
if (!apiPath) {
  console.error('usage: node wf-verify-api.js <api.json> [--object-info object_info.json]');
  process.exit(2);
}
oiPath = oiPath || path.join(__dirname, '..', 'capability', 'object_info.json');

const api = JSON.parse(fs.readFileSync(apiPath, 'utf8'));
const oi = JSON.parse(fs.readFileSync(oiPath, 'utf8'));

// ComfyUI 会自动注入、工作流里不必显式给的字段
const AUTO = new Set(['control_after_generate']);

let errs = 0, warns = 0;
const ids = new Set(Object.keys(api));

for (const [id, node] of Object.entries(api)) {
  if (!node || !node.class_type) {
    console.log('  [错] 节点 ' + id + ' 没有 class_type');
    errs++;
    continue;
  }
  const def = oi[node.class_type];
  if (!def) {
    console.log('  [错] 节点 ' + id + ' 的类型 ' + node.class_type + ' 板上没有注册');
    errs++;
    continue;
  }
  const req = (def.input && def.input.required) || {};
  const inputs = node.inputs || {};

  for (const field of Object.keys(req)) {
    if (AUTO.has(field)) continue;

    // ── 可增长输入组：同名键本来就不该存在 ─────────────────────
    // `COMFY_AUTOGROW_V3` 与 `COMFY_DYNAMICCOMBO_V3` 形似而性质相反：
    //   · DYNAMICCOMBO 是 widget，占 widgets_values 一格，键名就是字段名（codec）
    //   · AUTOGROW 是走连线的输入组，展开成 `values.a` / `values.b`，**没有 `values` 这个键**
    // 板上实测（ComfyMathExpression#131）：inputs 里只有 `values.a`: ["132",0]。
    // 早先这里按"同名键必须存在"判，把一张**已经真跑出视频**的工作流报成缺参数——
    // 闸门自己也要分清"缺参数"和"参数换了个表示形式"，否则会拦下能跑的东西。
    const spec0 = Array.isArray(req[field]) ? req[field][0] : null;
    if (spec0 === 'COMFY_AUTOGROW_V3') {
      const opts = (Array.isArray(req[field]) && req[field][1]) || {};
      const min = (opts.template && typeof opts.template.min === 'number') ? opts.template.min : 1;
      const got = Object.keys(inputs).filter(k => k.startsWith(field + '.')).length;
      if (got < min) {
        console.log('  [错] ' + node.class_type + '#' + id + ' 的输入组 `' + field + '` 只有 ' + got + ' 项，至少要 ' + min + ' 项');
        console.log('        它展开成 `' + field + '.a` / `' + field + '.b` 这种键，不是同名的 `' + field + '`。');
        errs++;
      }
      continue;
    }

    if (!(field in inputs)) {
      // 这正是 SaveVideo.codec 那类问题：转换器不认识新类型就静默漏掉
      const spec = req[field];
      let t = Array.isArray(spec) ? spec[0] : spec;
      if (t && typeof t === 'object' && !Array.isArray(t)) t = t.type || 'COMBO';
      else if (Array.isArray(t)) t = 'COMBO';
      console.log('  [错] ' + node.class_type + '#' + id + ' 缺必填参数 `' + field + '`（类型 ' + t + '）');
      console.log('        转换器多半不认识这个类型就跳过了。提交时会报 400，而不是说少了什么。');
      errs++;
    }
  }

  // 悬空引用
  for (const [field, v] of Object.entries(inputs)) {
    if (Array.isArray(v) && v.length === 2 && (typeof v[0] === 'string' || typeof v[0] === 'number')) {
      if (!ids.has(String(v[0]))) {
        console.log('  [错] ' + node.class_type + '#' + id + '.' + field + ' 指向不存在的节点 ' + v[0]);
        errs++;
      }
    }
  }
}

// 有没有终端输出节点——没有的话会"执行成功但没有图"
const OUTPUT_RE = /^(SaveImage|PreviewImage|SaveAnimated|SaveVideo|SaveAudio|VHS_)/;
const hasOutput = Object.values(api).some(n => n && n.class_type && (OUTPUT_RE.test(n.class_type) || (oi[n.class_type] && oi[n.class_type].output_node)));
if (!hasOutput) {
  console.log('  [警] 没有找到终端输出节点（SaveImage/PreviewImage 之类）——');
  console.log('        执行会"成功"但一张图都不产出，这是四个假成功之一。');
  warns++;
}

const name = path.basename(apiPath);
if (!errs && !warns) console.log('✅ ' + name + '：' + Object.keys(api).length + ' 个节点，必填参数齐全、无悬空引用、有输出节点');
else console.log((errs ? '⛔ ' : '⚠ ') + name + '：错 ' + errs + '，警 ' + warns);
process.exit(errs ? 1 : 0);
