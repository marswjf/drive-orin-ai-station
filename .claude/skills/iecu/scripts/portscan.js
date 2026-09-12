// 单主机端口扫描：并发 TCP connect，抓取服务 banner
// 用法: node portscan.js <IP> [端口范围] [超时毫秒]
//   端口范围: "1-65535" 或 "22,80,443" 或 "common"（默认）
// 例:   node portscan.js __SWITCH_IP__41 common
//       node portscan.js __SWITCH_IP__41 1-65535 800
const net = require('net');

const HOST = process.argv[2];
if (!HOST) { console.error('用法: node portscan.js <IP> [端口范围] [超时毫秒]'); process.exit(1); }
const SPEC = process.argv[3] || 'common';
const TIMEOUT = Number(process.argv[4] || 1200);
const CONCURRENCY = 600;

const COMMON = [21, 22, 23, 25, 53, 80, 111, 139, 443, 445, 502, 554, 623, 830, 902, 1080,
  1883, 2049, 2375, 2376, 3000, 3128, 3306, 3389, 4840, 5000, 5001, 5060, 5432, 5555, 5900,
  5901, 6379, 7000, 7001, 8000, 8006, 8008, 8080, 8081, 8088, 8090, 8188, 8443, 8554, 8888,
  9000, 9001, 9090, 9100, 9200, 10000, 11434, 27017, 30003, 30490, 30491, 30501, 47808];

function parsePorts(spec) {
  if (spec === 'common') return COMMON;
  const out = [];
  for (const part of spec.split(',')) {
    const m = part.match(/^(\d+)-(\d+)$/);
    if (m) { for (let p = +m[1]; p <= +m[2]; p++) out.push(p); }
    else out.push(Number(part));
  }
  return out;
}

function probe(port) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false, buf = '';
    const finish = (open) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve({ port, open, banner: buf.replace(/[\r\n].*$/s, '').replace(/[^\x20-\x7e]/g, '.').slice(0, 90) });
    };
    s.setTimeout(TIMEOUT);
    s.on('connect', () => {
      s.on('data', (d) => { buf += d.toString('latin1'); if (buf.length > 200) finish(true); });
      // 部分服务要客户端先说话；等一小会儿拿主动 banner，没有就直接算开放
      setTimeout(() => finish(true), 700);
    });
    s.on('timeout', () => finish(false));
    s.on('error', () => finish(false));
    s.connect(port, HOST);
  });
}

(async () => {
  const ports = parsePorts(SPEC);
  const open = [];
  let idx = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, ports.length) }, async () => {
    while (idx < ports.length) {
      const r = await probe(ports[idx++]);
      if (r.open) { open.push(r); console.log(`  开放 ${HOST}:${r.port}\t${r.banner}`); }
    }
  });
  const t0 = Date.now();
  await Promise.all(workers);
  console.log(`--- ${HOST} 扫 ${ports.length} 个端口，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，开放 ${open.length} 个 ---`);
})();
