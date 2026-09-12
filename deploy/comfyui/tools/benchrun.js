// 板上跑生图 bench 并记录耗时。遵守 bench/README.md 的四条守则。
// 用法: node benchrun.js <warmup|bench> <a.json> [b.json ...]
//   warmup —— 只跑第一份，结果丢弃（守则 1：重启后首张含模型载入，不算数）
//   bench  —— 依次跑每份，每次换种子（守则 2：比耗时必须换种子，否则是缓存命中）
const fs = require('fs'), http = require('http');
const mode = process.argv[2];
const files = process.argv.slice(3);
if (!mode || !files.length) { console.error('usage: node benchrun.js <warmup|bench> <json...>'); process.exit(2); }

function req(method, path, body) {
  return new Promise((res, rej) => {
    const d = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({
      host: '127.0.0.1', port: 8188, path, method,
      headers: d ? { 'Content-Type': 'application/json', 'Content-Length': d.length } : {},
    }, x => {
      const c = []; x.on('data', b => c.push(b));
      x.on('end', () => { const buf = Buffer.concat(c); res({ status: x.statusCode, text: () => buf.toString('utf8') }); });
    });
    r.on('error', rej); if (d) r.write(d); r.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function meminfo() {
  const o = {};
  for (const line of fs.readFileSync('/proc/meminfo', 'utf8').split(String.fromCharCode(10))) {
    const i = line.indexOf(':'); if (i < 0) continue;
    o[line.slice(0, i)] = parseInt(line.slice(i + 1).trim(), 10) || 0;
  }
  return { total: o.MemTotal || 0, avail: o.MemAvailable || 0 };
}

async function runOne(f, label) {
  const wf = JSON.parse(fs.readFileSync(f, 'utf8'));
  // 找 KSampler 类节点改种子
  let seedNode = null;
  for (const [id, n] of Object.entries(wf)) {
    if (n.inputs && typeof n.inputs.seed === 'number') { seedNode = id; break; }
  }
  const newSeed = Math.floor(Math.random() * 1e9);
  if (seedNode) wf[seedNode].inputs.seed = newSeed;

  const m0 = meminfo();
  let peakUsed = 0;
  const sampler = setInterval(() => {
    const m = meminfo(); const u = m.total - m.avail;
    if (u > peakUsed) peakUsed = u;
  }, 500);

  const t0 = Date.now();
  const r = await req('POST', '/prompt', { prompt: wf, client_id: 'benchrun' });
  if (r.status !== 200) {
    clearInterval(sampler);
    console.log(label + '  ⛔ 提交被拒 HTTP ' + r.status + ' ' + r.text().slice(0, 300));
    return null;
  }
  const { prompt_id } = JSON.parse(r.text());
  const dl = Date.now() + 900000;
  while (Date.now() < dl) {
    await sleep(1000);
    const h = await req('GET', '/history/' + prompt_id).catch(() => null);
    if (h && h.status === 200) {
      const rec = JSON.parse(h.text())[prompt_id];
      if (rec) {
        const st = rec.status || {};
        if (st.completed || st.status_str === 'success' || st.status_str === 'error') {
          clearInterval(sampler);
          const secs = ((Date.now() - t0) / 1000).toFixed(1);
          const ok = st.status_str !== 'error';
          const imgs = [];
          for (const o of Object.values(rec.outputs || {})) for (const im of (o.images || [])) imgs.push(im.filename);
          let err = '';
          for (const m of (st.messages || [])) if (m[0] === 'execution_error') err = m[1].exception_type + ': ' + String(m[1].exception_message).slice(0, 200);
          console.log(label + '  ' + (ok ? '✅' : '⛔') + '  ' + secs + 's  seed=' + newSeed
            + '  峰值used=' + (peakUsed / 1048576).toFixed(2) + 'GiB  文件=' + (imgs.join(',') || '(无)') + (err ? '  ' + err : ''));
          return { secs: parseFloat(secs), ok, files: imgs };
        }
      }
    }
  }
  clearInterval(sampler);
  console.log(label + '  ⏱ 超时');
  return null;
}

(async () => {
  if (mode === 'warmup') {
    console.log('--- 预热（守则 1：首张含模型载入，结果丢弃）---');
    await runOne(files[0], '预热  ');
    console.log('');
    return;
  }
  console.log('--- 正式测（守则 2：每次换种子，文件名必须每次不同）---');
  const out = [];
  for (const f of files) {
    const name = f.split('/').pop().replace('.json', '');
    const r = await runOne(f, name.padEnd(12));
    if (r) out.push(name + ' ' + r.secs);
  }
  console.log('');
  console.log('BENCHRESULT ' + out.join(' | '));
})().catch(e => { console.error('✗ ' + (e.stack || e)); process.exit(1); });
