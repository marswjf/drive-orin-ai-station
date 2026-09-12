// 局域网主机发现：并发 TCP connect 扫指定端口，顺带用连接尝试填充 ARP 表
// 用法: node lanscan.js [网段前缀] [端口,端口,...] [超时毫秒]
// 例:   node lanscan.js 192.168.1 22,9000,80,443 1500
const net = require('net');

const PREFIX = process.argv[2] || '192.168.1';
const PORTS = (process.argv[3] || '22').split(',').map(Number);
const TIMEOUT = Number(process.argv[4] || 1500);
const CONCURRENCY = 400;

function probe(ip, port) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const finish = (open, banner) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve({ ip, port, open, banner });
    };
    s.setTimeout(TIMEOUT);
    s.on('connect', () => {
      // SSH 服务端会主动先发 banner，等一小会儿拿到就能确认是什么
      if (port === 22) {
        let buf = '';
        s.on('data', (d) => {
          buf += d.toString('latin1');
          if (buf.includes('\n')) finish(true, buf.split('\n')[0].trim());
        });
        setTimeout(() => finish(true, buf.trim() || ''), 900);
      } else {
        finish(true, '');
      }
    });
    s.on('timeout', () => finish(false));
    s.on('error', () => finish(false));
    s.connect(port, ip);
  });
}

(async () => {
  const jobs = [];
  for (let i = 1; i <= 254; i++) {
    for (const p of PORTS) jobs.push([`${PREFIX}.${i}`, p]);
  }
  const results = [];
  let idx = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (idx < jobs.length) {
      const j = jobs[idx++];
      const r = await probe(j[0], j[1]);
      if (r.open) results.push(r);
    }
  });
  const t0 = Date.now();
  await Promise.all(workers);
  results.sort((a, b) => {
    const na = Number(a.ip.split('.')[3]), nb = Number(b.ip.split('.')[3]);
    return na - nb || a.port - b.port;
  });
  console.log(`扫描 ${PREFIX}.1-254 端口 [${PORTS.join(',')}]，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，开放 ${results.length} 项`);
  for (const r of results) {
    console.log(`${r.ip}:${r.port}\t${r.banner || ''}`);
  }
})();
