// 被动发现：监听广播/组播 UDP，打印源 IP。用于找不响应 ARP/ICMP 的设备。
// 只绑 >1024 端口，不需要管理员权限。
// 用法: node udplisten.js [监听秒数]
const dgram = require('dgram');

const SECONDS = Number(process.argv[2] || 30);

// SOME/IP-SD 是车载以太网的服务发现协议，DRIVE 平台厂商栈会周期性发它
const PORTS = [30490, 30491, 30501, 30502, 1900, 3702, 5353, 5355, 5678,
  6771, 8888, 9999, 10000, 17500, 27036, 32412, 32414, 47808, 54321];
// 常见组播组：SOME/IP-SD、mDNS、SSDP、WS-Discovery、LLMNR
const GROUPS = ['224.244.224.245', '224.0.0.251', '239.255.255.250', '239.255.255.253', '224.0.0.252'];

const seen = new Map();
const socks = [];

for (const port of PORTS) {
  const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  s.on('error', () => { try { s.close(); } catch (e) {} });
  s.on('message', (msg, rinfo) => {
    const key = `${rinfo.address}:${port}`;
    const rec = seen.get(key) || { count: 0, bytes: 0, sample: '' };
    rec.count++;
    rec.bytes += msg.length;
    if (!rec.sample) rec.sample = msg.slice(0, 24).toString('hex');
    seen.set(key, rec);
    if (rec.count === 1) {
      console.log(`[收到] 源 ${rinfo.address} → 本机端口 ${port}  ${msg.length} 字节  hex:${rec.sample}`);
    }
  });
  s.bind(port, () => {
    try { s.setBroadcast(true); } catch (e) {}
    for (const g of GROUPS) { try { s.addMembership(g); } catch (e) {} }
  });
  socks.push(s);
}

console.log(`监听 ${PORTS.length} 个 UDP 端口 ${SECONDS} 秒，等待任何广播/组播...`);
setTimeout(() => {
  console.log('--- 汇总 ---');
  if (seen.size === 0) {
    console.log('没有收到任何广播/组播包');
  } else {
    for (const [k, v] of [...seen.entries()].sort()) {
      console.log(`${k}\t${v.count} 包\t${v.bytes} 字节\thex:${v.sample}`);
    }
  }
  for (const s of socks) { try { s.close(); } catch (e) {} }
  process.exit(0);
}, SECONDS * 1000);
