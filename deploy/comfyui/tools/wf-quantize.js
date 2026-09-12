#!/usr/bin/env node
/**
 * wf-quantize.js —— 把工作流里的全精度加载器批量换成量化加载器
 *
 * 本项目的默认原则（2026-08-15 定）：**能用量化就不用 fp16**。
 * 这块板子是统一内存，权重省下来的每一 GB 都直接变成采样时的可用余量，
 * 而余量决定了能跑多大分辨率、能不能挂 ControlNet。实测文本编码器
 * 从 fp16(7.7 G) 换到 Q8_0(4.4 G) 省 3.3 G，直接让 1664×928 从"被 SIGKILL"
 * 变成"128 秒出图"——没有任何调参能有这个效果。
 *
 * 量化档怎么选（按对量化的敏感度分）：
 *   · 文本编码器：**最不敏感**，Q8_0 起步，缺内存时 Q6_K / IQ4_XS 都可接受
 *   · UNet / DiT 主干：Q8_0 是安全档，再往下要实际比图
 *   · VAE：**不要量化**，它直接决定成像细节，而且本来就小（160 MB）
 *
 * 用法: node wf-quantize.js <工作流.json> [更多.json ...] [--dry]
 *       --dry 只报告不改写
 */
const fs = require('fs');

// 全精度文件 → 量化替代（板上已有的）
const SWAP = {
  'qwen_3_4b.safetensors': {
    newType: 'CLIPLoaderGGUF',
    file: 'Qwen_3_4b-Q8_0.gguf',
    dropWidgetsAfter: 2,   // CLIPLoaderGGUF 只有 clip_name + type，没有 device
    note: 'fp16 7.7 G → Q8_0 载入 4.4 G，省 3.3 G',
  },
};

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const files = argv.filter(a => a !== '--dry');
if (!files.length) { console.error('usage: node wf-quantize.js <工作流.json> [...] [--dry]'); process.exit(2); }

for (const f of files) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const nodes = j.nodes || [];
  let changed = 0;
  for (const n of nodes) {
    const w = n.widgets_values;
    if (!Array.isArray(w) || !w.length) continue;
    const swap = SWAP[w[0]];
    if (!swap) continue;
    const before = { type: n.type, w: JSON.stringify(w) };
    n.type = swap.newType;
    n.widgets_values = w.slice(0, swap.dropWidgetsAfter);
    n.widgets_values[0] = swap.file;
    // 换 loader 后，旧类型特有的 widget-input（device）留着会被当成未连接的必填项
    if (Array.isArray(n.inputs)) n.inputs = n.inputs.filter(i => i.name !== 'device');
    changed++;
    console.log(`  [${n.id}] ${before.type} → ${n.type}`);
    console.log(`        ${before.w} → ${JSON.stringify(n.widgets_values)}   (${swap.note})`);
  }
  if (!changed) { console.log(`○ ${f}：没有可替换的全精度加载器`); continue; }
  if (dry) { console.log(`● ${f}：${changed} 处可替换（--dry，未写入）`); continue; }
  fs.writeFileSync(f, JSON.stringify(j, null, 1), 'utf8');
  console.log(`✔ ${f}：已改 ${changed} 处并写回`);
}
