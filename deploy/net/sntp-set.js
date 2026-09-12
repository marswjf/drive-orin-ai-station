// 直连 SNTP 兜底校时。timesyncd 不肯干活时用它。
// 用法: node sntp-set.js [--apply] [server1 server2 ...]
//   不带 --apply 只查询并打印偏差，不改系统时间。
// 退出码: 0 成功拿到时间（--apply 时已设置）；1 全部服务器失败。
//
// 为什么不用 ntpdate：板上没有。为什么不用 curl 的 Date 头：板上没有 curl，
// 而且 HTTPS 在时间错的时候本身就连不上（证书尚未生效），这正是要解决的死锁。
// UDP/123 不涉及证书，是唯一在时间错乱时仍然可用的校时通道。
const dgram = require('dgram');
const { execFileSync } = require('child_process');

const NTP_EPOCH_OFFSET = 2208988800; // 1900-01-01 到 1970-01-01 的秒数
const TIMEOUT_MS = 5000;

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const servers = argv.filter(a => a !== '--apply');
const LIST = servers.length ? servers
  : ['ntp.aliyun.com', 'ntp1.aliyun.com', 'ntp.tencent.com', 'cn.pool.ntp.org'];

function query(host) {
  return new Promise(resolve => {
    const sock = dgram.createSocket('udp4');
    const pkt = Buffer.alloc(48);
    pkt[0] = 0x1b; // LI=0 VN=3 Mode=3(client)
    let done = false;
    const finish = (r) => { if (done) return; done = true; try { sock.close(); } catch (e) {} resolve(r); };
    const timer = setTimeout(() => finish(null), TIMEOUT_MS);
    const t0 = Date.now();
    sock.on('message', msg => {
      clearTimeout(timer);
      if (msg.length < 48) return finish(null);
      // Transmit Timestamp: 字节 40..47（秒 + 小数）
      const sec = msg.readUInt32BE(40);
      const frac = msg.readUInt32BE(44);
      if (!sec) return finish(null);
      const epochMs = (sec - NTP_EPOCH_OFFSET) * 1000 + Math.round(frac / 4294967296 * 1000);
      finish({ host, epochMs, rttMs: Date.now() - t0, stratum: msg[1] });
    });
    sock.on('error', () => { clearTimeout(timer); finish(null); });
    sock.send(pkt, 0, 48, 123, host, err => { if (err) { clearTimeout(timer); finish(null); } });
  });
}

(async () => {
  for (const h of LIST) {
    const r = await query(h);
    if (!r) { console.log('MISS ' + h); continue; }
    // RTT 的一半补偿单程延迟
    const trueMs = r.epochMs + Math.round(r.rttMs / 2);
    const driftSec = Math.round((trueMs - Date.now()) / 1000);
    console.log('OK ' + h + ' stratum=' + r.stratum + ' rtt=' + r.rttMs + 'ms'
      + ' 系统时间偏差=' + driftSec + 's');
    if (!apply) { console.log('DRY_RUN 未修改系统时间'); process.exit(0); }
    if (Math.abs(driftSec) < 2) { console.log('SKIP 偏差小于 2 秒，不动'); process.exit(0); }
    // date -s 用 @秒 形式，避免任何本地化格式歧义
    execFileSync('/bin/date', ['-s', '@' + Math.round(trueMs / 1000)], { stdio: 'pipe' });
    console.log('APPLIED 已设为 ' + new Date(trueMs).toISOString() + '（原偏差 ' + driftSec + 's）');
    process.exit(0);
  }
  console.log('FATAL 所有 NTP 服务器都不通');
  process.exit(1);
})();
