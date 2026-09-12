// 只读 GGUF 头部元数据，不加载模型、不占显存、不依赖 python。
// 用法: node gguf-head.js <file.gguf> [键名过滤正则]
//   node gguf-head.js model.gguf                 打印全部键值
//   node gguf-head.js model.gguf 'attention|ssm'  只打印匹配的
//
// 为什么需要它：板上没有 python，也没有 gguf-py；而"这个模型的 KV 每 token 多少字节"
// 这类问题必须看模型自己的元数据，不能套用另一个模型的经验值。
const fs = require('fs');
const [, , file, filter] = process.argv;
if (!file) { console.error('用法: gguf-head.js <file.gguf> [键名过滤正则]'); process.exit(1); }
const re = filter ? new RegExp(filter, 'i') : null;

const fd = fs.openSync(file, 'r');
const CAP = 16 * 1024 * 1024;          // 头部（含 tokenizer 词表）可能几 MB
const buf = Buffer.alloc(CAP);
const n = fs.readSync(fd, buf, 0, CAP, 0);
fs.closeSync(fd);

let o = 0;
if (buf.toString('ascii', 0, 4) !== 'GGUF') { console.log('NOT_GGUF'); process.exit(1); }
o = 4;
const ver = buf.readUInt32LE(o); o += 4;
const nTensor = buf.readBigUInt64LE(o); o += 8;
const nKV = buf.readBigUInt64LE(o); o += 8;
console.log('gguf_version=' + ver + '  tensors=' + nTensor + '  kv=' + nKV);

function str() { const L = Number(buf.readBigUInt64LE(o)); o += 8; const s = buf.toString('utf8', o, o + L); o += L; return s; }
function val(t) {
  switch (t) {
    case 0: { const v = buf.readUInt8(o); o += 1; return v; }
    case 1: { const v = buf.readInt8(o); o += 1; return v; }
    case 2: { const v = buf.readUInt16LE(o); o += 2; return v; }
    case 3: { const v = buf.readInt16LE(o); o += 2; return v; }
    case 4: { const v = buf.readUInt32LE(o); o += 4; return v; }
    case 5: { const v = buf.readInt32LE(o); o += 4; return v; }
    case 6: { const v = buf.readFloatLE(o); o += 4; return v; }
    case 7: { const v = buf.readUInt8(o); o += 1; return !!v; }
    case 8: return str();
    case 9: { const et = buf.readUInt32LE(o); o += 4; const L = Number(buf.readBigUInt64LE(o)); o += 8;
              const a = []; for (let i = 0; i < L; i++) { const v = val(et); if (a.length < 16) a.push(v); }
              return L > 16 ? a.concat(['…共' + L + ' 项']) : a; }
    case 10: { const v = buf.readBigUInt64LE(o); o += 8; return v.toString(); }
    case 11: { const v = buf.readBigInt64LE(o); o += 8; return v.toString(); }
    case 12: { const v = buf.readDoubleLE(o); o += 8; return v; }
    default: throw new Error('未知值类型 ' + t);
  }
}

const kv = {};
for (let i = 0; i < Number(nKV); i++) {
  if (o > n - 16) { console.log('★ 头部超出预读窗口，第 ' + i + ' 项起未解析'); break; }
  const k = str(); const t = buf.readUInt32LE(o); o += 4;
  try { kv[k] = val(t); } catch (e) { console.log('★ 解析 ' + k + ' 失败: ' + e.message); break; }
}
for (const k of Object.keys(kv)) {
  if (re && !re.test(k)) continue;
  let v = kv[k];
  if (Array.isArray(v)) v = '[' + v.join(',') + ']';
  if (typeof v === 'string' && v.length > 160) v = v.slice(0, 160) + '…';
  console.log('  ' + k + ' = ' + v);
}
