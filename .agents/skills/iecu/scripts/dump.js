// 把 probe.js 的 out.json 按 group 拆成可读文本文件，并列出空/失败命令
// 用法: node dump.js <out.json> <输出目录>
const fs = require('fs');
const path = require('path');
const src = process.argv[2];
const outDir = process.argv[3];
const data = JSON.parse(fs.readFileSync(src, 'utf8'));
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const byGroup = {};
for (const r of data.collected) {
  (byGroup[r.group] = byGroup[r.group] || []).push(r);
}
const summary = [];
for (const [g, items] of Object.entries(byGroup)) {
  let txt = '';
  for (const r of items) {
    txt += `\n${'='.repeat(70)}\n## [${r.name}]  exit=${r.code}  ${r.ms}ms\n$ ${r.cmd}\n${'-'.repeat(70)}\n`;
    txt += (r.stdout || '').trimEnd() || '(no stdout)';
    if (r.stderr && r.stderr.trim()) txt += `\n--- stderr ---\n${r.stderr.trim()}`;
    txt += '\n';
  }
  const f = path.join(outDir, `${g}.txt`);
  fs.writeFileSync(f, txt, 'utf8');
  summary.push(`${g.padEnd(12)} items=${String(items.length).padStart(3)}  bytes=${String(txt.length).padStart(7)}  -> ${f}`);
}
console.log(summary.join('\n'));
console.log('\nEmpty/failed commands:');
for (const r of data.collected) {
  if (r.code !== 0 || !(r.stdout || '').trim()) console.log(`  ${r.group}/${r.name} exit=${r.code} outlen=${(r.stdout||'').length}`);
}
