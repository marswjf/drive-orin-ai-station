// 把本地文件上传到板子（SFTP，带进度）
// 用法: node push.js <本地文件> <远程绝对路径> [--resume]
//   默认整传覆盖——push 的语义就是"让远端等于本地"。
//   --resume 才启用断点续传，只在传大模型中断后使用。
//
// ⚠️ 为什么默认不续传（2026-08-12 踩坑，代价是面板服务挂掉）：
//   旧版默认续传，判据只有文件大小。推一个改过的 server.js 时，远端已存在
//   同名旧文件，于是从旧文件末尾偏移开始写，结果前半段是旧内容、后半段是
//   新内容的尾巴，拼成语法错误的嵌合体，服务无限重启。
//   更隐蔽的是 size 相等就 SKIP：同样大小的不同文件会被静默跳过，
//   你以为推上去了，其实一个字节都没传。
//   两种都不报错，只在运行时才暴露。所以续传必须显式要求。
const fs = require('fs');
const { Client } = require('ssh2');

const HOST = process.env.IECU_HOST || '172.31.254.38';
const PORT = parseInt(process.env.IECU_PORT, 10) || 22;
const USER = process.env.IECU_USER || 'root';
const PASS = process.env.IECU_PASS || 'nvidia';

const args = process.argv.slice(2);
const FLAGS = ['--resume', '--force'];
const resume = args.includes('--resume');
const [local, remote] = args.filter((a) => !FLAGS.includes(a));
if (!local || !remote) { console.error('usage: node push.js <local> <remote> [--resume]'); process.exit(2); }

const size = fs.statSync(local).size;
const log = (s) => process.stderr.write(s + '\n');

const conn = new Client();
conn.on('error', (e) => { console.error('CONN:' + e.message); process.exit(1); });
conn.on('ready', () => {
  conn.sftp((err, sftp) => {
    if (err) { console.error('SFTP:' + err.message); process.exit(3); }

    sftp.stat(remote, (statErr, st) => {
      let offset = 0;
      // 记住远端原有权限：整传会按默认 umask 新建文件，脚本的 +x 会丢。
      // 实测代价——推 run-server.sh 后 systemd 报 203/EXEC Permission denied，服务起不来。
      const prevMode = (!statErr && st) ? (st.mode & 0o7777) : null;
      if (resume && !statErr && st) {
        if (st.size === size) {
          log(`SKIP  远端大小已一致 (${(size / 1048576).toFixed(1)} MiB)——注意这只比对了大小，未校验内容`);
          console.log(`OK ${local} -> ${HOST}:${remote}  already complete`);
          conn.end(); return process.exit(0);
        }
        if (st.size < size) { offset = st.size; log(`RESUME 从 ${(offset / 1073741824).toFixed(2)} GiB 断点续传`); }
        else log(`远端更大 (${st.size} > ${size})，整传覆盖`);
      }

      const started = Date.now();
      let transferred = offset, last = Date.now(), lastB = offset;
      const ws = sftp.createWriteStream(remote, offset > 0
        ? { flags: 'r+', start: offset, highWaterMark: 1 << 20 }
        : { flags: 'w', highWaterMark: 1 << 20 });
      const rs = fs.createReadStream(local, { start: offset, highWaterMark: 1 << 20 });

      rs.on('data', (chunk) => {
        transferred += chunk.length;
        const now = Date.now();
        if (now - last > 3000) {
          const inst = (transferred - lastB) / 1048576 / ((now - last) / 1000);
          log(`  ${(transferred / size * 100).toFixed(1)}%  ${(transferred / 1073741824).toFixed(2)}/${(size / 1073741824).toFixed(2)} GiB  ${inst.toFixed(1)} MiB/s`);
          last = now; lastB = transferred;
        }
      });
      const fail = (e) => { console.error('PUT_FAIL: ' + e.message); process.exit(4); };
      rs.on('error', fail);
      ws.on('error', fail);
      ws.on('close', () => {
        const secs = (Date.now() - started) / 1000;
        const moved = (size - offset) / 1048576;
        // 恢复权限：原来有就照原样；原来没有而本地是脚本(.sh)则给 755
        const wantMode = prevMode !== null ? prevMode : (/\.sh$/i.test(remote) ? 0o755 : null);
        const done = () => {
          // 传后校验：远端大小必须等于本地。挡住截断和续传拼接这类静默损坏。
          sftp.stat(remote, (e2, st2) => {
            if (e2 || !st2 || st2.size !== size) {
              console.error(`VERIFY_FAIL 远端 ${st2 ? st2.size : '?'} != 本地 ${size} 字节，文件可能损坏`);
              conn.end(); return process.exit(5);
            }
            const m = wantMode !== null ? `，权限 ${wantMode.toString(8)}` : '';
            console.log(`OK ${local} -> ${HOST}:${remote}  传输 ${moved.toFixed(1)} MiB in ${secs.toFixed(1)}s (${(moved / secs).toFixed(1)} MiB/s)，远端已校验 ${size} 字节${m}`);
            conn.end(); process.exit(0);
          });
        };
        if (wantMode !== null) sftp.chmod(remote, wantMode, done); else done();
      });
      rs.pipe(ws);
    });
  });
});
conn.connect({ host: HOST, port: PORT, username: USER, password: PASS, readyTimeout: 20000, keepaliveInterval: 5000, keepaliveCountMax: 60 });
