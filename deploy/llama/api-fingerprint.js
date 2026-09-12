// 接口指纹：把 /metrics、/props、/slots 的**字段名**抓下来存盘或比对。
// 换 llama.cpp 版本时用它替代"应该没变"的猜测（陷阱 22：网上写的字段名板上一个都不存在）。
//
// 用法:
//   node api-fingerprint.js save <out.json>    在旧版上跑
//   node api-fingerprint.js diff <base.json>   在新版上跑
const http = require('http');
const fs = require('fs');
const PORT = process.env.LLM_PORT || 8080;

function get(path) {
  return new Promise(res => {
    http.get({ host: '127.0.0.1', port: PORT, path }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => res({ code: r.statusCode, body: d }));
    }).on('error', e => res({ code: 0, body: 'ERR ' + e.message }));
  });
}

// 递归收集 JSON 的键路径（不含值，只看结构）
function keys(o, prefix, acc) {
  if (o === null || typeof o !== 'object') return acc;
  if (Array.isArray(o)) { if (o.length) keys(o[0], prefix + '[]', acc); return acc; }
  for (const k of Object.keys(o)) { acc.push(prefix + '.' + k); keys(o[k], prefix + '.' + k, acc); }
  return acc;
}

(async () => {
  const [, , mode, file] = process.argv;
  if (!mode || !file) { console.error('用法: api-fingerprint.js save|diff <文件>'); process.exit(1); }

  const fp = {};

  // /metrics 是 Prometheus 文本，取指标名
  const m = await get('/metrics');
  fp.metrics = [...new Set((m.body.match(/^llamacpp:[a-z_0-9]+/gm) || []))].sort();

  for (const [name, path] of [['props', '/props'], ['slots', '/slots'], ['models', '/v1/models']]) {
    const r = await get(path);
    try { fp[name] = keys(JSON.parse(r.body), '', []).sort(); }
    catch (e) { fp[name] = ['<非 JSON, HTTP ' + r.code + '>']; }
  }

  if (mode === 'save') {
    fs.writeFileSync(file, JSON.stringify(fp, null, 1));
    for (const k of Object.keys(fp)) console.log('  ' + k + ': ' + fp[k].length + ' 项');
    console.log('SAVED -> ' + file);
    process.exit(0);
  }

  const base = JSON.parse(fs.readFileSync(file, 'utf8'));
  let bad = 0;
  for (const k of Object.keys(base)) {
    const a = new Set(base[k]), b = new Set(fp[k] || []);
    const gone = [...a].filter(x => !b.has(x));
    const add = [...b].filter(x => !a.has(x));
    console.log('== ' + k + ' ==  旧 ' + a.size + ' 新 ' + b.size);
    // ★ 消失的字段才是会打断面板的，新增的无害
    if (gone.length) { bad += gone.length; console.log('  ★ 消失（面板可能依赖）: ' + gone.join(', ')); }
    if (add.length) console.log('  + 新增: ' + add.slice(0, 12).join(', ') + (add.length > 12 ? ' …共' + add.length : ''));
    if (!gone.length && !add.length) console.log('  完全一致');
  }
  console.log(bad === 0 ? 'VERDICT 无字段消失，面板解析不会断' : '★ VERDICT 有 ' + bad + ' 个字段消失，先改 server.js 再升级');
})();
