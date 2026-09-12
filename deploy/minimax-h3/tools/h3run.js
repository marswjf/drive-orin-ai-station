// 板上跑 H3 工作流并同时采样内存峰值。
// 用法: node h3run.js <api.json> <秒数> [超时秒] [megapixels]
// 帧数 = max(5, round(秒*24))，再向上取到 17k+5 网格（与板上 ComfyMathExpression 一致）
// megapixels 给了就改节点 115 的分辨率（1024 进制：0.2 → 608×352）。
// 降分辨率是换时长的主要手段：latent 变小 → 同样内存能放更多帧，
// 画面再用 SeedVR2 超分补回来（超分只要 78 秒、峰值 12.9 GB，很宽松）。
const fs = require('fs'), http = require('http');
const [, , wfPath, secArg, toArg, mpArg] = process.argv;
const sec = parseFloat(secArg || '0.5');
const TIMEOUT = (parseInt(toArg, 10) || 1800) * 1000;
const wf = JSON.parse(fs.readFileSync(wfPath, 'utf8'));
if (!wf['132']) { console.error('节点 132 (秒数) 不存在'); process.exit(2); }
wf['132'].inputs.value = sec;
let mpNote = '';
if (mpArg && wf['115']) {
  wf['115'].inputs.megapixels = parseFloat(mpArg);
  mpNote = '  分辨率 ' + mpArg + ' MP';
}
// 换种子，避免命中提示词缓存（陷阱：文件名不变就是缓存命中，那是假数据）
if (wf['129']) wf['129'].inputs.noise_seed = Math.floor(Math.random() * 1e15);
// ⚠ JS 的 % 对负数返回负数，Python 的取模返回非负——板上表达式是 Python 语义，
//   这里必须补 ((x % 17) + 17) % 17，否则算出来的帧数是错的（0.5 秒会显示成 5 帧）。
const b = Math.max(5, Math.round(sec * 24));
const frames = b + ((((5 - (b % 17)) % 17) + 17) % 17);
console.log('目标: ' + sec + ' 秒设定 -> ' + frames + ' 帧 (' + (frames / 24).toFixed(2) + ' 秒实际)' + mpNote);

function meminfo() {
  const o = {};
  const txt = fs.readFileSync('/proc/meminfo', 'utf8');
  for (const line of txt.split(String.fromCharCode(10))) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    o[line.slice(0, i)] = parseInt(line.slice(i + 1).trim(), 10) || 0;
  }
  return {
    total: o.MemTotal || 0, avail: o.MemAvailable || 0, free: o.MemFree || 0,
    cached: o.Cached || 0, mlocked: o.Mlocked || 0,
  };
}

const m0 = meminfo();
if (!m0.total) { console.error('⚠ /proc/meminfo 解析失败，内存采样将无效'); }
let peakUsed = 0, minAvail = m0.total || 1e9, peakMlocked = 0, samples = 0;
const sampler = setInterval(() => {
  const m = meminfo(); samples++;
  const used = m.total - m.avail;
  if (used > peakUsed) peakUsed = used;
  if (m.avail < minAvail) minAvail = m.avail;
  if (m.mlocked > peakMlocked) peakMlocked = m.mlocked;
}, 500);

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
const GiB = kb => (kb / 1048576).toFixed(2);

(async () => {
  const t0 = Date.now();
  const r = await req('POST', '/prompt', { prompt: wf, client_id: 'h3run' });
  if (r.status !== 200) {
    clearInterval(sampler);
    console.log('⛔ 提交被拒 HTTP ' + r.status);
    console.log(r.text().slice(0, 1500));
    process.exit(1);
  }
  const { prompt_id } = JSON.parse(r.text());
  console.log('已入队 ' + prompt_id + '，采样中…');
  const dl = Date.now() + TIMEOUT;
  let emptyPolls = 0;
  while (Date.now() < dl) {
    await sleep(3000);
    const h = await req('GET', '/history/' + prompt_id).catch(() => null);
    if (h && h.status === 200) {
      const rec = JSON.parse(h.text())[prompt_id];
      if (rec) {
        const st = rec.status || {};
        if (st.completed || st.status_str === 'success' || st.status_str === 'error') {
          clearInterval(sampler);
          const secs = ((Date.now() - t0) / 1000).toFixed(1);
          const ok = st.status_str !== 'error';
          console.log('');
          console.log((ok ? '✅ 完成' : '⛔ 出错') + '  用时 ' + secs + 's  status=' + st.status_str);
          for (const m of (st.messages || [])) {
            if (m[0] === 'execution_error') {
              console.log('   错误节点 ' + m[1].node_id + ' (' + m[1].node_type + ')');
              console.log('   ' + m[1].exception_type + ': ' + String(m[1].exception_message).slice(0, 600));
            }
          }
          const outs = [];
          for (const [nid, o] of Object.entries(rec.outputs || {})) {
            for (const k of ['images', 'video', 'audio', 'gifs']) {
              for (const f of (o[k] || [])) if (f.filename) outs.push(nid + ':' + f.filename);
            }
          }
          console.log('   产出: ' + (outs.join(', ') || '(无)'));
          console.log('   内存峰值 used ' + GiB(peakUsed) + ' GiB / 最低 avail ' + GiB(minAvail) + ' GiB');
          console.log('   Mlocked 峰值 ' + (peakMlocked / 1024).toFixed(0) + ' MiB  采样 ' + samples + ' 次');
          console.log('RESULT ' + frames + ' ' + secs + ' ' + GiB(peakUsed) + ' ' + GiB(minAvail) + ' ' + (ok ? 'OK' : 'FAIL'));
          process.exit(ok ? 0 : 1);
        }
      }
    }
    // 队列空 + history 无记录 = 进程中途没了（这块板上最常见的是内存打爆被 SIGKILL）
    const q = await req('GET', '/queue').catch(() => null);
    if (q && q.status === 200) {
      const qj = JSON.parse(q.text());
      if ((qj.queue_running || []).length === 0 && (qj.queue_pending || []).length === 0) {
        if (++emptyPolls >= 5) {
          clearInterval(sampler);
          console.log('');
          console.log('⛔ 队列已空但 history 无记录 —— 判定 ComfyUI 进程中途退出（多半是被 OOM killer 杀掉）');
          console.log('   内存峰值 used ' + GiB(peakUsed) + ' GiB / 最低 avail ' + GiB(minAvail) + ' GiB');
          console.log('RESULT ' + frames + ' - ' + GiB(peakUsed) + ' ' + GiB(minAvail) + ' KILLED');
          process.exit(1);
        }
      } else emptyPolls = 0;
    }
  }
  clearInterval(sampler);
  console.log('⏱ 超时');
  console.log('   内存峰值 used ' + GiB(peakUsed) + ' GiB / 最低 avail ' + GiB(minAvail) + ' GiB');
  console.log('RESULT ' + frames + ' - ' + GiB(peakUsed) + ' ' + GiB(minAvail) + ' TIMEOUT');
  process.exit(1);
})().catch(e => { clearInterval(sampler); console.error('✗ ' + (e.stack || e)); process.exit(1); });
