// 探测每个模型文件在哪个源可用、实际多大。在板上跑（板子的网络环境才是实际环境）。
// 起因：baseline/models.tsv 写着"国内走 ModelScope：把域名换成 modelscope.cn 即可"，
// 实测 404 —— ModelScope 与 HuggingFace 是两个独立平台，仓库名不保证同名同在。
// 判据：用 Range: bytes=0-0 拿 Content-Range 里的总大小，比 HEAD 可靠（HF 的 CDN 对 HEAD 行为不一致）。
const https = require('https');
const { URL } = require('url');

// [文件名, HF仓库, 期望字节数]
const FILES = [
  ['4x-UltraSharp.pth', 'lokCX/4x-Ultrasharp', 66961958],
  ['RealESRGAN_x4plus.pth', 'schwgHao/RealESRGAN_x4plus', 67040989],
  ['ae.safetensors', 'vpakarinen/zimage-vae-clip-lora', 335304388],
  ['Qwen3-Embedding-0.6B-Q8_0.gguf', 'Qwen/Qwen3-Embedding-0.6B-GGUF', 639150592],
  ['mmproj-F16.gguf', 'Youseff1987/Qwen3.6-35B-A3B-Claude-4.6-Opus-Reasoning-Distilled-GGUF-with-mmproj', 899283680],
  ['Qwen_3_4b-Q8_0.gguf', 'worstplayer/Z-Image_Qwen_3_4b_text_encoder_GGUF', 4280404704],
  ['z_image_turbo-Q8_0.gguf', 'jayn7/Z-Image-Turbo-GGUF', 7224707136],
  ['Qwen3.6-35B-A3B-UD-IQ4_XS.gguf', 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF', 18209036576],
];

const SOURCES = [
  ['modelscope', (repo, f) => `https://modelscope.cn/models/${repo}/resolve/master/${f}`],
  ['hf-mirror', (repo, f) => `https://hf-mirror.com/${repo}/resolve/main/${f}`],
  ['hf', (repo, f) => `https://huggingface.co/${repo}/resolve/main/${f}`],
];

function probe(url, redirects = 0) {
  return new Promise((resolve) => {
    if (redirects > 8) return resolve({ ok: false, note: 'too many redirects' });
    let o;
    try { o = new URL(url); } catch (e) { return resolve({ ok: false, note: 'bad url' }); }
    const req = https.get({
      host: o.hostname, path: o.pathname + o.search,
      headers: { 'user-agent': 'iecu-probe/1.0', range: 'bytes=0-0' },
    }, (res) => {
      const code = res.statusCode;
      if ([301, 302, 303, 307, 308].includes(code)) {
        res.resume();
        return resolve(probe(new URL(res.headers.location, url).href, redirects + 1));
      }
      res.resume();
      const cr = res.headers['content-range'];
      let total = null;
      if (cr) { const m = cr.match(/\/(\d+)$/); if (m) total = parseInt(m[1], 10); }
      else if (res.headers['content-length'] && code === 200) total = parseInt(res.headers['content-length'], 10);
      resolve({ ok: code === 200 || code === 206, code, total, note: '' });
    });
    req.on('error', (e) => resolve({ ok: false, note: e.message.slice(0, 40) }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ ok: false, note: 'timeout' }); });
  });
}

(async () => {
  console.log('文件'.padEnd(34), '源'.padEnd(12), '状态', '实际字节', '  与期望');
  console.log('-'.repeat(96));
  const usable = [];
  for (const [file, repo, want] of FILES) {
    let picked = null;
    for (const [sname, mk] of SOURCES) {
      const url = mk(repo, file);
      const r = await probe(url);
      const sizeStr = r.total != null ? String(r.total) : '-';
      let verdict;
      if (!r.ok) verdict = `✗ ${r.code || r.note}`;
      else if (r.total === want) verdict = '✓ 一致';
      else if (r.total == null) verdict = '? 大小未知';
      else verdict = `⚠ 差 ${r.total - want}`;
      console.log(file.slice(0, 33).padEnd(34), sname.padEnd(12), String(r.code || '-').padEnd(4), sizeStr.padEnd(12), verdict);
      if (r.ok && r.total === want && !picked) { picked = { file, repo, want, source: sname, url }; }
    }
    if (picked) usable.push(picked);
    else console.log('  ★ ' + file + ' 三个源都没有匹配期望字节数的版本');
    console.log('');
  }
  console.log('='.repeat(96));
  console.log('可用清单（源|期望字节|URL）:');
  for (const u of usable) console.log(`PICK|${u.source}|${u.want}|${u.url}`);
  console.log(`\n共 ${usable.length}/${FILES.length} 个文件找到可用源`);
})();
