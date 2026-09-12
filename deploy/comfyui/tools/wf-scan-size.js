#!/usr/bin/env node
/**
 * wf-scan-size.js —— 扫出工作流里所有"写死尺寸"的节点
 *
 * 存在理由（2026-08-15 踩过）：`ImageScale` 带 `crop=disabled` 时是**强制拉伸**，
 * 不保持宽高比。老照片修复工作流里写死 1024×1024，把任何 16:9 输入压成正方形，
 * 人物明显变形，而且因为一直用方图测试，这个 bug 藏了很久。
 *
 * 尺寸相关节点分三类风险：
 *   · 高危：ImageScale + crop=disabled  → 强制拉伸，必然变形
 *   · 中危：EmptyLatentImage / EmptySD3LatentImage 写死宽高 → 输出尺寸固定，
 *          作者按自己的机器定的，未必适合本板（内存/比例）
 *   · 安全：ImageScaleToTotalPixels / ImageScaleBy → 等比缩放
 *
 * 用法: node wf-scan-size.js <工作流.json|目录>
 */
const fs = require('fs');
const path = require('path');

const target = process.argv[2];
if (!target) { console.error('usage: node wf-scan-size.js <工作流.json|目录>'); process.exit(2); }

const files = fs.statSync(target).isDirectory()
  ? fs.readdirSync(target).filter(f => f.endsWith('.json')).map(f => path.join(target, f))
  : [target];

const SAFE = ['ImageScaleToTotalPixels', 'ImageScaleBy', 'GetImageSize'];

for (const f of files) {
  let j;
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
  const nodes = j.nodes || [];
  const hits = [];
  for (const n of nodes) {
    const w = n.widgets_values || [];
    const t = n.type;
    if (t === 'ImageScale') {
      const crop = w[3];
      hits.push({
        risk: crop === 'disabled' ? '高危' : '中危',
        node: n.id, type: t,
        detail: `${w[1]}×${w[2]} crop=${crop}` + (crop === 'disabled' ? '  ← 强制拉伸，非方图必变形' : ''),
      });
    } else if (/^Empty(SD3)?LatentImage$/.test(t)) {
      const [wid, hgt] = w;
      const linked = (n.inputs || []).some(i => ['width', 'height'].includes(i.name) && i.link != null);
      hits.push({
        risk: linked ? '安全' : '中危',
        node: n.id, type: t,
        detail: linked ? '宽高由连线提供（跟随输入图）' : `写死 ${wid}×${hgt}（${((wid * hgt) / 1048576).toFixed(2)} MP）`,
      });
    } else if (SAFE.includes(t)) {
      hits.push({ risk: '安全', node: n.id, type: t, detail: JSON.stringify(w) });
    }
  }
  console.log('='.repeat(76));
  console.log('■ ' + path.basename(f));
  if (!hits.length) { console.log('   没有尺寸相关节点'); continue; }
  for (const h of hits) {
    const mark = h.risk === '高危' ? '⛔' : h.risk === '中危' ? '⚠ ' : '✓ ';
    console.log(`   ${mark} [${h.node}] ${h.type}  ${h.detail}`);
  }
}
console.log('='.repeat(76));
console.log('⛔高危：强制拉伸，非方图必变形，应换成 ImageScaleToTotalPixels');
console.log('⚠ 中危：尺寸写死，是作者按自己机器定的——检查是否超本板内存、是否符合你要的比例');
