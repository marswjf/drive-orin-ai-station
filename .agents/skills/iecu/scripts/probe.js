// IECU 3.1 (DRIVE AGX Orin Guest) 只读诊断采集器 — 断点续跑 + 增量落盘 + 断线重连
// 用法: node probe.js <cmdset.json> <out.json>
// 目标默认 172.31.254.38 root/nvidia，可用 IECU_HOST/IECU_USER/IECU_PASS 覆盖。
// cmdset 格式见 ../references/probe-recipes.md。改了命令内容记得删旧 out.json 或换 name。
const fs = require('fs');
const { Client } = require('ssh2');

const HOST = process.env.IECU_HOST || '172.31.254.38';
const PORT = parseInt(process.env.IECU_PORT, 10) || 22;
const USER = process.env.IECU_USER || 'root';
const PASS = process.env.IECU_PASS || 'nvidia';

const cmdFile = process.argv[2];
const outFile = process.argv[3];
const cmds = JSON.parse(fs.readFileSync(cmdFile, 'utf8'));

// 已有结果 -> 断点续跑（只跳过成功项 code 0/1）
let done = {};
if (fs.existsSync(outFile)) {
  try {
    const prev = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    (prev.collected || []).forEach(r => { if (r.code === 0 || r.code === 1) done[r.name] = r; });
    process.stderr.write(`RESUME: ${Object.keys(done).length} already collected\n`);
  } catch (e) { process.stderr.write('prev parse fail: ' + e.message + '\n'); }
}

const results = [];
function flush() {
  const map = {};
  Object.values(done).forEach(r => { map[r.name] = r; });
  results.forEach(r => { map[r.name] = r; });
  const ordered = cmds.map(c => map[c.name]).filter(Boolean);
  fs.writeFileSync(outFile, JSON.stringify({ host: HOST, collected: ordered }, null, 1), 'utf8');
}

function log(s) { process.stderr.write(s + '\n'); }

function connect() {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    conn.on('ready', () => { settled = true; resolve(conn); });
    conn.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    conn.connect({
      host: HOST, port: PORT, username: USER, password: PASS,
      readyTimeout: 20000, keepaliveInterval: 5000, keepaliveCountMax: 6,
    });
  });
}

function runOne(conn, item) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let finished = false;
    const fail = (msg) => { if (!finished) { finished = true; reject(new Error(msg)); } };
    conn.once('error', (e) => fail('CONN:' + e.message));
    conn.exec(item.cmd, { pty: false }, (err, stream) => {
      if (err) return fail('EXEC:' + err.message);
      let out = '', errOut = '';
      const killer = setTimeout(() => { try { stream.close(); } catch (e) {} }, (item.timeout || 20) * 1000);
      stream.on('close', (c) => {
        clearTimeout(killer);
        if (finished) return;
        finished = true;
        resolve({
          group: item.group, name: item.name, cmd: item.cmd,
          code: typeof c === 'number' ? c : 0,
          stdout: out.slice(0, 200000), stderr: errOut.slice(0, 20000),
          ms: Date.now() - started,
        });
      });
      stream.on('data', d => { out += d.toString('utf8'); });
      stream.stderr.on('data', d => { errOut += d.toString('utf8'); });
    });
  });
}

(async () => {
  let conn = null;
  let attempts = 0;
  for (let i = 0; i < cmds.length; i++) {
    const item = cmds[i];
    if (done[item.name]) { continue; }
    let ok = false;
    for (let retry = 0; retry < 3 && !ok; retry++) {
      if (!conn) {
        try { conn = await connect(); log('CONNECTED'); attempts = 0; }
        catch (e) {
          attempts++;
          log('CONNECT_FAIL ' + e.message);
          if (attempts > 6) { flush(); log('GIVE_UP'); process.exit(3); }
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }
      }
      try {
        log(`[${i + 1}/${cmds.length}] ${item.name}`);
        const r = await runOne(conn, item);
        results.push(r); flush(); ok = true;
      } catch (e) {
        log('  LOST: ' + e.message + ' -> reconnect');
        try { conn.end(); } catch (x) {}
        conn = null;
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    if (!ok) {
      results.push({ group: item.group, name: item.name, cmd: item.cmd, code: -1, stdout: '', stderr: 'FAILED_AFTER_RETRIES', ms: 0 });
      flush();
    }
  }
  flush();
  log('DONE -> ' + outFile);
  if (conn) conn.end();
  process.exit(0);
})();
