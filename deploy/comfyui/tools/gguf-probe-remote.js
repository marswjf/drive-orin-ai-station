#!/usr/bin/env node
/**
 * gguf-probe-remote.js —— 下载整个模型之前，先隔着网络看清这个 GGUF 是给谁打的包
 *
 * 解决的问题（2026-09-01 在 MiniMax-H3 上踩到才写的）：
 *   GGUF 是容器不是标准。同一个模型给 stable-diffusion.cpp / llama.cpp / ComfyUI
 *   打出来的包**互不通用**，而三者的文件名、体积、量化档看起来一模一样。
 *   下错一次的代价是十几分钟和十几 GB 磁盘；探一次是十几秒、几十 MB。
 *
 * 判据（ComfyUI-GGUF 的 loader.py 就按这两条拦）：
 *   ① `general.architecture` 必须存在。metadata 被剥光的包（kv=0）会在
 *      loader.py 抛 "This gguf file is incompatible with llama.cpp!" ——
 *      注意这句话有误导性，抛错的是 ComfyUI-GGUF 不是 llama.cpp，
 *      而且文件大小可能完全正确、内容也完好。
 *   ② 文本编码器要给 ComfyUI 用，视觉塔必须和语言层在同一个文件里。
 *      llama.cpp 风格的包会把视觉塔拆成独立 mmproj，而 ComfyUI 的
 *      CLIPLoader / CLIPLoaderGGUF 只有一个文件输入口，没有 mmproj 输入。
 *
 * 原理：GGUF 的 metadata 与张量表都在文件头，一个 HTTP Range 请求就够，
 *       不必下载权重本体。
 *
 * 用法:
 *   node gguf-probe-remote.js <URL> [<URL> ...] [--mb 48]
 * 例:
 *   node gguf-probe-remote.js https://huggingface.co/Abiray/MiniMax-H3-GGUF/resolve/main/text_encoders/qwen3vl_32b_minimax_h3-Q4_K_M.gguf
 *   node gguf-probe-remote.js https://modelscope.cn/models/unsloth/MiniMax-H3-GGUF/resolve/master/minimax_h3_ref2va_pruned-Q4_K.gguf
 */
const https = require('https');
const http = require('http');

const args = process.argv.slice(2);
let HEAD_MB = 48;
const urls = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--mb') HEAD_MB = parseInt(args[++i], 10);
  else urls.push(args[i]);
}
if (!urls.length) {
  console.error('usage: node gguf-probe-remote.js <URL> [<URL> ...] [--mb 48]');
  process.exit(2);
}
const HEAD = HEAD_MB * 1024 * 1024;

function fetchHead(url, depth = 0) {
  return new Promise((res, rej) => {
    if (depth > 6) return rej(new Error('redirect loop'));
    const mod = url.startsWith('http://') ? http : https;
    const chunks = []; let got = 0;
    const r = mod.get(url, { headers: { 'user-agent': 'curl/8', Range: 'bytes=0-' + (HEAD - 1) } }, x => {
      if (x.statusCode >= 300 && x.statusCode < 400 && x.headers.location) {
        x.destroy(); return fetchHead(new URL(x.headers.location, url).href, depth + 1).then(res, rej);
      }
      if (x.statusCode !== 206 && x.statusCode !== 200) { x.destroy(); return rej(new Error('HTTP ' + x.statusCode)); }
      const cr = x.headers['content-range'];
      const totalSize = cr ? parseInt(cr.split('/')[1], 10) : null;
      x.on('data', c => { chunks.push(c); got += c.length; if (got >= HEAD) x.destroy(); });
      x.on('close', () => res({ buf: Buffer.concat(chunks), totalSize }));
      x.on('error', rej);
    });
    r.on('error', rej);
    r.setTimeout(90000, () => { r.destroy(); rej(new Error('timeout')); });
  });
}

function parse(buf) {
  let p = 0;
  if (buf.toString('ascii', 0, 4) !== 'GGUF') throw new Error('不是 GGUF 文件（magic 不匹配）');
  p = 4;
  const ver = buf.readUInt32LE(p); p += 4;
  const nT = Number(buf.readBigUInt64LE(p)); p += 8;
  const nKV = Number(buf.readBigUInt64LE(p)); p += 8;
  const rdStr = () => { const n = Number(buf.readBigUInt64LE(p)); p += 8; const s = buf.toString('utf8', p, p + n); p += n; return s; };
  function skip(t) {
    switch (t) {
      case 0: case 1: case 7: p += 1; break;
      case 2: case 3: p += 2; break;
      case 4: case 5: case 6: p += 4; break;
      case 8: { const n = Number(buf.readBigUInt64LE(p)); p += 8 + n; break; }
      case 9: { const et = buf.readUInt32LE(p); p += 4; const n = Number(buf.readBigUInt64LE(p)); p += 8; for (let i = 0; i < n; i++) skip(et); break; }
      case 10: case 11: case 12: p += 8; break;
      default: throw new Error('未知 metadata 类型 ' + t);
    }
  }
  const meta = {};
  for (let i = 0; i < nKV; i++) {
    const k = rdStr(); const t = buf.readUInt32LE(p); p += 4;
    if (t === 8) meta[k] = rdStr();
    else { const at = p; skip(t); if (t === 4) meta[k] = buf.readUInt32LE(at); else if (t === 10) meta[k] = Number(buf.readBigUInt64LE(at)); }
  }
  const names = [];
  let truncated = false;
  for (let i = 0; i < nT; i++) {
    if (p + 16 > buf.length) { truncated = true; break; }
    const nm = rdStr(); const nd = buf.readUInt32LE(p); p += 4;
    for (let d = 0; d < nd; d++) p += 8;
    p += 4 + 8;
    names.push(nm);
  }
  return { ver, nT, nKV, meta, names, truncated };
}

// ComfyUI-GGUF loader.py 的两张白名单（照抄自 loader.py 第 12~14 行）
// ⚠ 文本编码器查 TXT_ARCH、扩散模型查 IMG_ARCH，用错表会得出反的结论。
const TXT_ARCH = ['t5', 't5encoder', 'llama', 'qwen2vl', 'qwen3', 'qwen3vl', 'gemma3'];
const IMG_ARCH = ['flux', 'sd1', 'sdxl', 'sd3', 'aura', 'hidream', 'cosmos', 'ltxv', 'hyvid', 'wan', 'lumina2', 'qwen_image'];

(async () => {
  for (const url of urls) {
    const short = url.split('/').slice(-1)[0];
    try {
      const { buf, totalSize } = await fetchHead(url);
      const r = parse(buf);
      const arch = r.meta['general.architecture'];
      const llamaStyle = r.names.filter(n => /^blk\.|^token_embd/.test(n)).length;
      const hfStyle = r.names.filter(n => /^model\.layers|^model\.embed/.test(n)).length;
      const vis = r.names.filter(n => /visual|^v\.|vision/.test(n)).length;

      console.log('==== ' + short);
      console.log('   体积        ' + (totalSize ? (totalSize / 1073741824).toFixed(2) + ' GiB' : '未知'));
      console.log('   GGUF        v' + r.ver + '  张量 ' + r.nT + '  metadata 键 ' + r.nKV + (r.truncated ? '  (张量表未读全，加大 --mb)' : ''));
      console.log('   architecture ' + JSON.stringify(arch));
      console.log('   张量命名     llama.cpp风格 ' + llamaStyle + ' / HF风格 ' + hfStyle);
      console.log('   视觉塔张量   ' + vis);
      if (r.names.length) console.log('   样例         ' + r.names.slice(0, 3).join(' , '));

      // 先判断这是文本编码器还是扩散模型：有 HF/llama 风格的层命名才是文本模型
      const isText = (hfStyle + llamaStyle) > 0;
      const kind = isText ? '文本编码器' : '扩散模型(DiT/UNet)';
      console.log('   类型         ' + kind);

      const problems = [];
      if (!arch) {
        problems.push('metadata 里没有 general.architecture —— ComfyUI-GGUF 的 loader.py 会拒绝：'
          + (isText ? '文本模型直接抛 "incompatible with llama.cpp"' : '扩散模型退到 detect_arch 兜底，认不出就抛 "Unknown model architecture!"')
          + '（这种包多半是给 stable-diffusion.cpp 打的）');
      } else if (isText && !TXT_ARCH.includes(arch)) {
        problems.push('architecture=' + arch + ' 不在 ComfyUI-GGUF 的 TXT_ARCH_LIST 里');
      } else if (!isText && !IMG_ARCH.includes(arch)) {
        problems.push('architecture=' + arch + ' 不在 ComfyUI-GGUF 的 IMG_ARCH_LIST 里 '
          + '（该表只有 flux/sd1/sdxl/sd3/aura/hidream/cosmos/ltxv/hyvid/wan/lumina2/qwen_image；'
          + '新架构的包常借用其中一个名字混过检查，比如 MiniMax-H3 的 DiT 借 "wan"）');
      }
      if (isText && vis === 0) {
        problems.push('没有视觉塔张量 —— 若用于 I2V/参考图链路，ComfyUI 的 CLIPLoader 只有一个文件输入口，配不上独立的 mmproj 文件');
      }
      console.log('   判定         ' + (problems.length ? '⚠ ' + problems.join('；') : '✅ 可被 ComfyUI-GGUF 作为' + kind + '加载'));
      console.log('');
    } catch (e) {
      console.log('==== ' + short);
      console.log('   ERR ' + e.message + '\n');
    }
  }
})();
