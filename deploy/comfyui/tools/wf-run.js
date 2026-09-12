#!/usr/bin/env node
/**
 * wf-run.js —— 把 API 格式工作流真正提交给板上 ComfyUI 跑一遍，并如实报告结果
 *
 * 这一步是整套流程里最不能省的：装完包、改完模型名，工作流在前端能打开、
 * 不飘红，都**不等于能出图**。只有真的跑完拿到图片文件名，才算验证通过。
 *
 * 三种失败会被分别报出来（它们的处理方式完全不同）：
 *   · 提交就 400 —— 参数/连线层面的错，ComfyUI 的 node_errors 会明确指出是哪个节点
 *     的哪个字段。这类错在秒级返回，最容易修。
 *   · 提交成功但执行中断 —— 多半是显存不够或算子不支持，要看 status.messages。
 *   · 执行完成但没有输出图 —— 工作流里没有 SaveImage/PreviewImage 之类的终端节点。
 *
 * 用法:
 *   node wf-run.js <api.json> [--host __BOARD_LAN_IP__] [--port 9000] [--prefix /comfy]
 *                             [--timeout 600] [--save 输出目录]
 *   host 默认取环境变量 IECU_HOST，没设才用 __BOARD_LAN_IP__（这块板，现役主力）
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const argv = process.argv.slice(2);
// ★ host 默认读 IECU_HOST，与 exec.js / push.js / cap-refresh.js 统一。
//   原本写死 __BOARD_LAN_IP__，而现役主力早已是这块板 .16——两块板不能同时上电，
//   忘了加 --host 就会连到一块关着的板子，报出来的是连接超时，看不出根因。
//   一处设置全局生效，才不会出现"exec 连对了、wf-run 连错了"。
const o = {
  host: process.env.IECU_HOST || '172.31.254.38',
  port: +(process.env.IECU_PANEL_PORT || 9000),
  prefix: '/comfy', timeout: 600, save: null,
};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--host') o.host = argv[++i];
  else if (a === '--port') o.port = +argv[++i];
  // ⚠ 这里原本写成 `argv[++i] === 'none' ? '' : argv[++i - 1 + 1] || ''`，
  //   ++i 出现两次 → **消费两个参数并取第二个**当 prefix。
  //   于是 `--prefix /comfy --timeout 600` 解析出的 prefix 是 "--timeout"，
  //   请求路径变成 http://host:port--timeout/prompt，报 HTTP 400 且提示看不懂。
  //   2026-08-16 修。直连 ComfyUI（不经面板）用 `--prefix none`。
  else if (a === '--prefix') { const v = argv[++i]; o.prefix = (v === 'none' || v === undefined) ? '' : v; }
  else if (a === '--timeout') o.timeout = +argv[++i];
  else if (a === '--save') o.save = argv[++i];
  else pos.push(a);
}
const apiPath = pos[0];
if (!apiPath) { console.error('usage: node wf-run.js <api.json> [--host H] [--port P] [--save DIR]'); process.exit(2); }

const prompt = JSON.parse(fs.readFileSync(apiPath, 'utf8'));

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({
      host: o.host, port: o.port, path: o.prefix + p, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
      timeout: 120000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, body: buf, text: () => buf.toString('utf8') });
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    if (data) r.write(data);
    r.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log(`提交到 http://${o.host}:${o.port}${o.prefix}/prompt  （${Object.keys(prompt).length} 个节点）`);
  const t0 = Date.now();
  const res = await req('POST', '/prompt', { prompt, client_id: 'iecu-wf-run' });

  if (res.status !== 200) {
    console.log(`\n⛔ 提交被拒绝 HTTP ${res.status}`);
    let j = null;
    try { j = JSON.parse(res.text()); } catch { }
    if (j) {
      if (j.error) console.log(`   错误: ${j.error.type} — ${j.error.message}\n   ${j.error.details || ''}`);
      for (const [nid, e] of Object.entries(j.node_errors || {})) {
        console.log(`   节点 ${nid} (${e.class_type}):`);
        for (const err of e.errors || []) {
          console.log(`      · ${err.message}`);
          if (err.details) console.log(`        ${err.details}`);
        }
      }
    } else console.log('   ' + res.text().slice(0, 800));
    process.exit(1);
  }

  const { prompt_id } = JSON.parse(res.text());
  console.log(`已入队 prompt_id=${prompt_id}，等待执行…`);

  const deadline = Date.now() + o.timeout * 1000;
  let last = '', emptyPolls = 0;
  while (Date.now() < deadline) {
    await sleep(3000);
    const h = await req('GET', '/history/' + prompt_id);
    if (h.status === 200) {
      const hist = JSON.parse(h.text());
      const rec = hist[prompt_id];
      if (rec) {
        const st = rec.status || {};
        if (st.completed || st.status_str === 'success' || st.status_str === 'error') {
          const secs = ((Date.now() - t0) / 1000).toFixed(1);
          const ok = st.status_str !== 'error';
          console.log(`\n${ok ? '✅ 执行完成' : '⛔ 执行出错'}  用时 ${secs}s  status=${st.status_str}`);
          for (const m of (st.messages || [])) {
            const [kind, payload] = m;
            if (kind === 'execution_error') {
              console.log(`   错误节点 ${payload.node_id} (${payload.node_type})`);
              console.log(`   ${payload.exception_type}: ${String(payload.exception_message).slice(0, 400)}`);
            }
            if (kind === 'execution_interrupted') console.log('   执行被中断');
          }
          const imgs = [];
          for (const [nid, out] of Object.entries(rec.outputs || {})) {
            for (const im of (out.images || [])) imgs.push({ nid, ...im });
          }
          if (imgs.length) {
            console.log(`   产出 ${imgs.length} 张图:`);
            for (const im of imgs) console.log(`      节点 ${im.nid}: ${im.filename}  (${im.type}/${im.subfolder || '-'})`);
            if (o.save) {
              fs.mkdirSync(o.save, { recursive: true });
              for (const im of imgs) {
                const q = `/view?filename=${encodeURIComponent(im.filename)}&type=${im.type}&subfolder=${encodeURIComponent(im.subfolder || '')}`;
                const d = await req('GET', q);
                if (d.status === 200) {
                  const fp = path.join(o.save, im.filename);
                  fs.writeFileSync(fp, d.body);
                  console.log(`      已下载 ${fp}  ${(d.body.length / 1024).toFixed(0)} KB`);
                }
              }
            }
          } else if (ok) {
            console.log('   ⚠ 执行成功但没有输出图片——工作流里可能没有 SaveImage/PreviewImage 终端节点');
          }
          process.exit(ok && imgs.length ? 0 : 1);
        }
      }
    }
    // 队列进度
    const q = await req('GET', '/queue').catch(() => null);
    if (q && q.status === 200) {
      const qj = JSON.parse(q.text());
      const running = (qj.queue_running || []).length, pending = (qj.queue_pending || []).length;
      const line = `   运行中 ${running} / 排队 ${pending}  已等 ${((Date.now() - t0) / 1000).toFixed(0)}s`;
      if (line !== last) { console.log(line); last = line; }
      // 队列已空、history 里却查不到这个任务 —— 说明 ComfyUI 进程中途没了
      // （内存打爆被 SIGKILL 是这块板子上最常见的原因，systemd 会把它拉起来，
      //  于是队列干净、历史全无，看起来像"还在跑"）。不早停就要傻等到超时。
      if (running === 0 && pending === 0) {
        emptyPolls++;
        if (emptyPolls >= 5) {
          console.log(`\n⛔ 队列已空但 history 里没有这个任务的记录，判定为**执行进程中途退出**。`);
          console.log(`   这块板子上最常见的原因是内存打爆被 SIGKILL。去板上确认：`);
          console.log(`   journalctl -u comfyui --since '-10 min' | grep -E 'code=killed|Main process exited'`);
          console.log(`   若确认是被杀，按 A-137 的思路降分辨率、或换更小的量化档给模型腾地方。`);
          process.exit(1);
        }
      } else emptyPolls = 0;
    }
  }
  console.log(`\n⏱ 超时（${o.timeout}s）仍未完成，任务可能还在跑。用 /queue 或面板查看。`);
  process.exit(1);
})().catch((e) => {
  // 连不上是最常见的失败，报错要说人话——原来这里会抛一整屏 node 栈，
  // 看不出到底是板子没开、服务没起，还是连错了板子。
  const net = /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|ECONNRESET|timeout|EAI_AGAIN|ENOTFOUND/i.test(e && (e.code || e.message) || '');
  if (!net) { console.error('✗ ' + (e && e.stack || e)); process.exit(1); }
  console.error('✗ 连不上 http://' + o.host + ':' + o.port + o.prefix + ' —— ' + (e.code || e.message));
  console.error('');
  console.error('  按这个顺序查（从最常见的开始）：');
  console.error('  1. 连的是哪块板？当前 IECU_HOST=' + (process.env.IECU_HOST || '(未设置，用默认 ' + o.host + ')'));
  console.error('     ⚠ 两块板不能同时上电，另一块此刻多半是关着的。');
  console.error('  2. 板子在生图模式吗？ComfyUI 在推理/车机模式下是停着的：');
  console.error('       node .claude/skills/iecu/scripts/exec.js "systemctl is-active comfyui"');
  console.error('  3. 刚重启过？ComfyUI 要 20~40 秒才开始监听，systemd 说 active 不算数（陷阱 51）。');
  console.error('  4. 别的会话正占着板子？内存互斥，同一时刻只能有一边提交任务。');
  process.exit(1);
});
