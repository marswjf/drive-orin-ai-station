// /16 全网段 ARP 触发扫描：对每个地址发一个 TCP SYN，逼内核做 ARP 解析。
// 用完读系统 ARP 表（arp -a），凡是有 MAC 的地址就是在线设备——
// 即使它不开任何端口、不响应 ICMP，只要它应答 ARP 就能被发现。
// 用法: node arpsweep.js <前两段> [端口] [超时毫秒] [并发]
// 例:   node arpsweep.js 172.31 22 800 900
const net = require('net');

const PREFIX = process.argv[2] || '172.31';
const PORT = Number(process.argv[3] || 22);
const TIMEOUT = Number(process.argv[4] || 800);
const CONCURRENCY = Number(process.argv[5] || 900);

function probe(ip) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const finish = (open) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(open);
    };
    s.setTimeout(TIMEOUT);
    s.on('connect', () => finish(true));
    s.on('timeout', () => finish(false));
    s.on('error', () => finish(false));
    s.connect(PORT, ip);
  });
}

(async () => {
  const targets = [];
  for (let a = 0; a <= 255; a++) {
    for (let b = 1; b <= 254; b++) targets.push(`${PREFIX}.${a}.${b}`);
  }
  console.log(`对 ${PREFIX}.0.0/16 的 ${targets.length} 个地址发 SYN(:${PORT})，并发 ${CONCURRENCY}，超时 ${TIMEOUT}ms`);
  let idx = 0, openCount = 0;
  const t0 = Date.now();
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (idx < targets.length) {
      const ip = targets[idx++];
      if (await probe(ip)) { openCount++; console.log(`  ★ 端口开放: ${ip}:${PORT}`); }
    }
  });
  const tick = setInterval(() => {
    process.stdout.write(`  进度 ${idx}/${targets.length}\r`);
  }, 5000);
  await Promise.all(workers);
  clearInterval(tick);
  console.log(`\n完成，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，端口开放 ${openCount} 个。现在读 ARP 表找应答的地址。`);
})();
