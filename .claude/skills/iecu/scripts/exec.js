// 在板子上执行一条命令，实时流式输出（适合 llama-bench / 模型加载这类长任务）
// 用法: node exec.js "<命令>" [超时秒数，默认 600]
//       node exec.js --file <本地脚本文件> [超时秒数]   # 把脚本内容作为 stdin 喂给远端 bash，避免引号套娃
// 目标默认 172.31.254.38:22 root/nvidia，可用 IECU_HOST/IECU_PORT/IECU_USER/IECU_PASS 覆盖。
// 在家网内：IECU_HOST=__BOARD_LAN_IP__（走局域网，比隧道快一个量级）
// 人不在家网：先起 LXC 跳板隧道，再 IECU_HOST=127.0.0.1 IECU_PORT=<PANEL_JUMP_PORT>（命令见 iecu skill）
// ⚠ 板子的 SSH 没有公网转发，也不该有（root+弱口令）。
const fs = require('fs');
const { Client } = require('ssh2');

const HOST = process.env.IECU_HOST || '172.31.254.38';
const PORT = parseInt(process.env.IECU_PORT, 10) || 22;
const USER = process.env.IECU_USER || 'root';
const PASS = process.env.IECU_PASS || 'nvidia';

let cmd, scriptBody = null, timeoutArgIdx = 2;
if (process.argv[2] === '--file') {
  const f = process.argv[3];
  if (!f || !fs.existsSync(f)) { console.error('script file not found: ' + f); process.exit(2); }
  // CRLF -> LF，否则远端 bash 会报 $'\r': command not found
  scriptBody = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
  cmd = 'bash -s';
  timeoutArgIdx = 4;
} else {
  cmd = process.argv[2];
  if (!cmd) { console.error('usage: node exec.js "<cmd>" [timeoutSec]   |   node exec.js --file <script> [timeoutSec]'); process.exit(2); }
}
const TIMEOUT = (parseInt(process.argv[timeoutArgIdx], 10) || 600) * 1000;

const conn = new Client();
conn.on('ready', () => {
  conn.exec(cmd, { pty: false }, (err, stream) => {
    if (err) { console.error('EXEC:' + err.message); process.exit(3); }
    const killer = setTimeout(() => {
      process.stderr.write(`\n[exec.js] TIMEOUT after ${TIMEOUT / 1000}s, closing stream\n`);
      try { stream.close(); } catch (e) {}
    }, TIMEOUT);
    stream.on('close', (code) => {
      clearTimeout(killer);
      process.stderr.write(`\n[exec.js] exit=${code}\n`);
      conn.end();
      process.exit(typeof code === 'number' ? code : 0);
    });
    stream.on('data', (d) => process.stdout.write(d));
    stream.stderr.on('data', (d) => process.stderr.write(d));
    if (scriptBody !== null) { stream.write(scriptBody); stream.end(); }
  });
});
conn.on('error', (e) => { console.error('CONN:' + e.message); process.exit(1); });
conn.connect({ host: HOST, port: PORT, username: USER, password: PASS, readyTimeout: 20000, keepaliveInterval: 5000, keepaliveCountMax: 240 });
