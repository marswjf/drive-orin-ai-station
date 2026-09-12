// 车载协议探测：对不开任何 TCP 端口的车载 ECU 用 DoIP / SOME/IP 问身份。
// DoIP = ISO 13400-2，UDP/TCP 13400。车辆识别请求会换回 VIN、逻辑地址、EID、GID。
// SOME/IP-SD = 车载服务发现，UDP 30490，设备周期性主动广播 offer。
// 用法: node vehicle-probe.js [监听秒数] [目标IP...]
const dgram = require('dgram');

const SECONDS = Number(process.argv[2] || 25);
const TARGETS = process.argv.slice(3);
const DEFAULT_TARGETS = ['172.31.254.38', '172.31.251.38', '172.31.8.9', '172.31.200.9',
  '172.31.255.255', '255.255.255.255'];
const targets = TARGETS.length ? TARGETS : DEFAULT_TARGETS;

// DoIP 车辆识别请求：版本 0x02 / 反版本 0xFD / payload type 0x0001 / 长度 0
function vir(version) {
  const b = Buffer.alloc(8);
  b[0] = version;
  b[1] = 0xff ^ version;
  b.writeUInt16BE(0x0001, 2);
  b.writeUInt32BE(0, 4);
  return b;
}

const PAYLOAD_TYPES = {
  0x0000: '通用否定响应', 0x0001: '车辆识别请求', 0x0002: '车辆识别请求(EID)',
  0x0003: '车辆识别请求(VIN)', 0x0004: '车辆announcement/识别响应',
  0x0005: '路由激活请求', 0x0006: '路由激活响应', 0x0007: '存活检测请求',
  0x0008: '存活检测响应', 0x4001: '实体状态请求', 0x4002: '实体状态响应',
  0x4003: '诊断电源模式请求', 0x4004: '诊断电源模式响应',
  0x8001: '诊断报文', 0x8002: '诊断报文正响应', 0x8003: '诊断报文负响应',
};

function parseDoIP(msg, from) {
  if (msg.length < 8) return null;
  const ver = msg[0], inv = msg[1];
  if ((ver ^ inv) !== 0xff) return null;
  const type = msg.readUInt16BE(2);
  const len = msg.readUInt32BE(4);
  const out = [`  DoIP 版本 0x${ver.toString(16)}  类型 0x${type.toString(16).padStart(4, '0')} (${PAYLOAD_TYPES[type] || '未知'})  payload ${len} 字节`];
  if (type === 0x0004 && msg.length >= 8 + 32) {
    const p = msg.slice(8);
    const vin = p.slice(0, 17);
    out.push(`  VIN: "${vin.toString('latin1').replace(/[^\x20-\x7e]/g, '.')}"  (hex ${vin.toString('hex')})`);
    out.push(`  逻辑地址: 0x${p.readUInt16BE(17).toString(16).padStart(4, '0')}`);
    out.push(`  EID: ${p.slice(19, 25).toString('hex').match(/../g).join(':')}`);
    out.push(`  GID: ${p.slice(25, 31).toString('hex').match(/../g).join(':')}`);
    out.push(`  需进一步动作: 0x${p[31].toString(16)}`);
  } else if (len > 0) {
    out.push(`  payload hex: ${msg.slice(8, 8 + Math.min(len, 48)).toString('hex')}`);
  }
  return out.join('\n');
}

const hits = [];

// ---- DoIP socket：既发请求也收主动通告 ----
const doip = dgram.createSocket({ type: 'udp4', reuseAddr: true });
doip.on('error', (e) => console.log(`[DoIP socket 错误] ${e.message}`));
doip.on('message', (msg, r) => {
  console.log(`[DoIP 回应] 来自 ${r.address}:${r.port}  ${msg.length} 字节`);
  const parsed = parseDoIP(msg, r.address);
  console.log(parsed || `  非 DoIP 格式  hex: ${msg.slice(0, 32).toString('hex')}`);
  hits.push(`DoIP ${r.address}`);
});
doip.bind(13400, () => {
  doip.setBroadcast(true);
  let round = 0;
  const send = () => {
    round++;
    for (const v of [0x02, 0x03, 0x01]) {          // 2012 / 2019 / 早期草案版本都试
      for (const t of targets) {
        doip.send(vir(v), 13400, t, () => {});
      }
    }
    if (round === 1) console.log(`已向 ${targets.length} 个目标发出 DoIP 车辆识别请求（3 个协议版本）`);
  };
  send();
  setInterval(send, 5000);
});

// ---- SOME/IP-SD：被动监听 ----
for (const port of [30490, 30491]) {
  const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  s.on('error', () => {});
  s.on('message', (msg, r) => {
    console.log(`[SOME/IP :${port}] 来自 ${r.address}  ${msg.length} 字节  hex:${msg.slice(0, 32).toString('hex')}`);
    hits.push(`SOMEIP ${r.address}`);
  });
  s.bind(port, () => {
    s.setBroadcast(true);
    try { s.addMembership('224.244.224.245'); } catch (e) {}
  });
}

console.log(`监听 ${SECONDS} 秒...`);
setTimeout(() => {
  console.log('--- 汇总 ---');
  console.log(hits.length ? [...new Set(hits)].join('\n') : '没有收到任何 DoIP / SOME-IP 回应');
  process.exit(0);
}, SECONDS * 1000);
