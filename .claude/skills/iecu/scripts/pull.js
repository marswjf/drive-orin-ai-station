// 从板子递归拉取目录到本机（SFTP，只读操作，断点续传：大小一致则跳过）
// 用法: node pull.js <远程目录> <本地目录> [--exclude <子串>]... [--max-size <GiB>]
// 目标默认 172.31.254.38 root/nvidia，可用 IECU_HOST/IECU_USER/IECU_PASS 覆盖。
// 安全性：全程只读远端。绝不写板子，绝不碰 /dev/vblkdev*。
//
// ⚠ 稀疏文件陷阱（2026-08-10 实际踩过）：
//   /var/lib/docker/devicemapper/devicemapper/data 的 apparent size 是 100 GiB，
//   但磁盘实占几乎为 0。SFTP 没有稀疏语义，会把空洞逐字节填成真实的 0 写到本地，
//   一个文件就吃掉 100 GB 本地磁盘。默认排除列表已含 docker/devicemapper。
//   判据：远端整个分区 df 才 807 MB，单文件却报 100 GiB → 一定是稀疏文件。
const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');

const HOST = process.env.IECU_HOST || '172.31.254.38';
const PORT = parseInt(process.env.IECU_PORT, 10) || 22;
const USER = process.env.IECU_USER || 'root';
const PASS = process.env.IECU_PASS || 'nvidia';

const argv = process.argv.slice(2);
const positional = [];
const excludes = ['docker/devicemapper', 'lost+found'];  // 默认排除
let maxSizeB = Infinity;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--exclude') { excludes.push(argv[++i]); }
  else if (argv[i] === '--max-size') { maxSizeB = parseFloat(argv[++i]) * 1073741824; }
  else positional.push(argv[i]);
}
const remoteRoot = positional[0];
const localRoot = positional[1];
if (!remoteRoot || !localRoot) {
  console.error('usage: node pull.js <remoteDir> <localDir> [--exclude <substr>]... [--max-size <GiB>]');
  process.exit(2);
}
const isExcluded = (p) => excludes.some((e) => p.includes(e));

// ⚠ 跨平台文件名陷阱（2026-08-10 实际踩过）：
//   板上大量文件/目录名含冒号（日志 sensor_service.log.2026-08-07_17:59:48…、
//   标定目录 epica-calib-result-1970-01-01-00:00:39），而 Windows 禁止 < > : " | ? *
//   和控制字符。直接 mkdir 会 ENOENT，整个备份中断。
//   这里做可逆的百分号编码，原始路径全量记在 _manifest.json 里，恢复时可还原。
const WIN_BAD = /[<>:"|?*\x00-\x1f]/g;
const encodeSeg = (s) => s.replace(WIN_BAD, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
let renamed = 0;
function safeRel(relPath) {
  const parts = relPath.split('/').map((seg) => {
    const e = encodeSeg(seg);
    if (e !== seg) renamed++;
    return e;
  });
  return parts.join(path.sep);
}

const log = (s) => process.stderr.write(s + '\n');
let totalBytes = 0, doneBytes = 0, skipped = 0, copied = 0, failed = [], excludedList = [];
const startedAll = Date.now();

function connect() {
  return new Promise((resolve, reject) => {
    const c = new Client();
    let settled = false;
    c.on('ready', () => { settled = true; resolve(c); });
    c.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    c.connect({ host: HOST, port: PORT, username: USER, password: PASS, readyTimeout: 20000, keepaliveInterval: 5000, keepaliveCountMax: 12 });
  });
}
const sftpOf = (conn) => new Promise((res, rej) => conn.sftp((e, s) => e ? rej(e) : res(s)));
const readdir = (sftp, p) => new Promise((res, rej) => sftp.readdir(p, (e, l) => e ? rej(e) : res(l)));

// 先遍历，建立文件清单（含 mode/uid/gid/size/mtime，写 manifest 供恢复参考）
async function walk(sftp, rp, acc) {
  let list;
  try { list = await readdir(sftp, rp); }
  catch (e) { log(`  SKIP_DIR ${rp}: ${e.message}`); return; }
  for (const it of list) {
    const full = rp + '/' + it.filename;
    const a = it.attrs;
    const isDir = (a.mode & 0o170000) === 0o040000;
    const isLink = (a.mode & 0o170000) === 0o120000;
    if (isExcluded(full)) { excludedList.push({ path: full, size: a.size, why: 'exclude' }); continue; }
    if (isLink) { acc.push({ type: 'l', path: full, mode: a.mode, size: 0 }); continue; }
    if (isDir) { acc.push({ type: 'd', path: full, mode: a.mode, uid: a.uid, gid: a.gid, size: 0 }); await walk(sftp, full, acc); }
    else {
      if (a.size > maxSizeB) { excludedList.push({ path: full, size: a.size, why: 'over --max-size' }); continue; }
      acc.push({ type: 'f', path: full, mode: a.mode, uid: a.uid, gid: a.gid, size: a.size, mtime: a.mtime });
      totalBytes += a.size;
    }
  }
}

function fastGet(sftp, r, l, size) {
  return new Promise((res, rej) => {
    let last = Date.now(), lastB = 0;
    sftp.fastGet(r, l, {
      concurrency: 16, chunkSize: 32768,
      step: (t) => {
        const now = Date.now();
        if (now - last > 3000) {
          const inst = (t - lastB) / 1048576 / ((now - last) / 1000);
          const pct = size ? (t / size * 100).toFixed(1) : '?';
          const overall = (doneBytes + t) / 1048576 / ((now - startedAll) / 1000);
          log(`    ${pct}%  ${(t / 1073741824).toFixed(2)}/${(size / 1073741824).toFixed(2)} GiB  now ${inst.toFixed(1)} MiB/s  avg ${overall.toFixed(1)} MiB/s`);
          last = now; lastB = t;
        }
      },
    }, (e) => e ? rej(e) : res());
  });
}

(async () => {
  let conn = await connect(); log('CONNECTED');
  let sftp = await sftpOf(conn);

  log(`WALK ${remoteRoot} ...`);
  const items = [];
  await walk(sftp, remoteRoot, items);
  const files = items.filter(i => i.type === 'f');
  log(`FOUND ${files.length} files, ${items.filter(i => i.type === 'd').length} dirs, total ${(totalBytes / 1073741824).toFixed(2)} GiB`);
  if (excludedList.length) {
    // 不静默截断：被跳过的东西必须报出来，否则会被误读成"全备份了"
    log(`EXCLUDED ${excludedList.length} 项，合计 ${(excludedList.reduce((s, e) => s + e.size, 0) / 1073741824).toFixed(2)} GiB apparent:`);
    excludedList.forEach(e => log(`  - ${e.path}  ${(e.size / 1073741824).toFixed(2)} GiB  (${e.why})`));
  }

  fs.mkdirSync(localRoot, { recursive: true });
  fs.writeFileSync(path.join(localRoot, '_manifest.json'),
    JSON.stringify({ host: HOST, remoteRoot, generated: new Date(startedAll).toISOString(), excluded: excludedList, items }, null, 1), 'utf8');
  log(`MANIFEST -> ${path.join(localRoot, '_manifest.json')}`);

  const rel = (p) => safeRel(p.slice(remoteRoot.length).replace(/^\//, ''));
  for (const d of items.filter(i => i.type === 'd')) {
    try { fs.mkdirSync(path.join(localRoot, rel(d.path)), { recursive: true }); }
    catch (e) { log(`  MKDIR_FAIL ${d.path}: ${e.message}`); failed.push(d.path); }
  }
  if (renamed) log(`NOTE: ${renamed} 个路径片段含 Windows 非法字符，已做百分号编码（原名见 _manifest.json）`);

  let idx = 0;
  for (const f of files) {
    idx++;
    const lp = path.join(localRoot, rel(f.path));
    try { fs.mkdirSync(path.dirname(lp), { recursive: true }); }
    catch (e) { log(`[${idx}/${files.length}] MKDIR_FAIL ${f.path}: ${e.message}`); failed.push(f.path); continue; }
    if (fs.existsSync(lp) && fs.statSync(lp).size === f.size) {
      skipped++; doneBytes += f.size;
      log(`[${idx}/${files.length}] SKIP  ${rel(f.path)}  (${(f.size / 1048576).toFixed(1)} MiB, already complete)`);
      continue;
    }
    log(`[${idx}/${files.length}] GET   ${rel(f.path)}  ${(f.size / 1048576).toFixed(1)} MiB`);
    let ok = false;
    for (let retry = 0; retry < 3 && !ok; retry++) {
      try { await fastGet(sftp, f.path, lp, f.size); ok = true; }
      catch (e) {
        log(`    FAIL(${retry + 1}/3): ${e.message}`);
        try { conn.end(); } catch (x) {}
        await new Promise(r => setTimeout(r, 3000));
        try { conn = await connect(); sftp = await sftpOf(conn); log('    RECONNECTED'); } catch (x) { log('    reconnect fail: ' + x.message); }
      }
    }
    if (ok) { copied++; doneBytes += f.size; } else { failed.push(f.path); }
  }

  const secs = (Date.now() - startedAll) / 1000;
  log(`\nDONE  copied=${copied} skipped=${skipped} failed=${failed.length}  ${(doneBytes / 1073741824).toFixed(2)} GiB in ${(secs / 60).toFixed(1)} min (${(doneBytes / 1048576 / secs).toFixed(1)} MiB/s)`);
  if (failed.length) { log('FAILED FILES:'); failed.forEach(f => log('  ' + f)); }
  conn.end();
  process.exit(failed.length ? 5 : 0);
})().catch(e => { log('FATAL: ' + e.message); process.exit(1); });
