// 向量指纹：固定语料 → 取向量 → 存盘 / 与基线比对。
// 换 llama.cpp 版本、换量化档、换计算后端之前后各跑一次，判断向量是否等价。
//
// 为什么必须做：建库与查询必须用同一套向量（陷阱 34）。F16→Q8 那次余弦 0.9997
// 就已经要求整库重建了，所以「肉眼看着差不多」不是判据，要有数。
//
// 用法:
//   node embed-fingerprint.js save <输出.json>          在旧版上跑，存基线
//   node embed-fingerprint.js diff <基线.json>          在新版上跑，比对
const http = require('http');
const fs = require('fs');

const PORT = process.env.EMBED_PORT || 8081;
const TEXTS = [
  '雷达标定在低温环境下表现出明显漂移，需要在量产前完成三轮验证。',
  '域控制器与激光雷达之间存在握手超时，工程团队已提交整改单。',
  'The quick brown fox jumps over the lazy dog.',
  '智能驾驶域控制器的算力调度策略需要兼顾功耗与实时性两个约束。',
  '车身网关的故障码没有形成闭环，质量部门要求增加一组对照实验。',
  '1234567890',
  '这是一段较长的中文技术文本，用于检验分词与位置编码在长序列上的一致性。' .repeat(6),
];

function embed(text) {
  return new Promise((res, rej) => {
    const body = JSON.stringify({ model: 'e', input: text });
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/v1/embeddings', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { const j = JSON.parse(d); res(j.data[0].embedding); } catch (e) { rej(new Error('HTTP ' + r.statusCode + ' ' + d.slice(0, 120))); } });
    });
    req.on('error', rej); req.setTimeout(60000, () => req.destroy(new Error('timeout')));
    req.end(body);
  });
}

function cos(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb));
}

(async () => {
  const [, , mode, file] = process.argv;
  if (!mode || !file) { console.error('用法: embed-fingerprint.js save|diff <文件>'); process.exit(1); }

  const vecs = [];
  for (const t of TEXTS) vecs.push(await embed(t));

  if (mode === 'save') {
    fs.writeFileSync(file, JSON.stringify({ dim: vecs[0].length, n: vecs.length, vecs }));
    console.log('SAVED dim=' + vecs[0].length + ' n=' + vecs.length + ' -> ' + file);
    process.exit(0);
  }

  const base = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (base.dim !== vecs[0].length) {
    console.log('★ 维度变了: ' + base.dim + ' -> ' + vecs[0].length + '  必须整库重建');
    process.exit(1);
  }
  let worst = 1, worstIdx = -1, maxAbs = 0;
  for (let i = 0; i < vecs.length; i++) {
    const c = cos(base.vecs[i], vecs[i]);
    let m = 0;
    for (let k = 0; k < vecs[i].length; k++) m = Math.max(m, Math.abs(vecs[i][k] - base.vecs[i][k]));
    maxAbs = Math.max(maxAbs, m);
    if (c < worst) { worst = c; worstIdx = i; }
    console.log('  [' + i + '] 余弦 ' + c.toFixed(6) + '  单维最大差 ' + m.toExponential(2));
  }
  console.log('最差余弦 ' + worst.toFixed(6) + '（第 ' + worstIdx + ' 条），全局单维最大差 ' + maxAbs.toExponential(2));
  // 判据参照 A-88：F16→Q8 那次余弦 0.9997 / 单维差 5.6e-3，当时判定必须整库重建。
  if (worst >= 0.999999 && maxAbs < 1e-5) console.log('VERDICT 等价，知识库不必重建');
  else if (worst >= 0.9999) console.log('VERDICT 有微小差异（比 F16→Q8 那次小），建议重建或至少抽样验证检索质量');
  else console.log('★ VERDICT 差异显著，必须整库重建');
})().catch(e => { console.error('FAIL ' + e.message); process.exit(1); });
