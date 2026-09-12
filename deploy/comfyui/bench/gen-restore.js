// 老照片修复工作流的 API 版（与 workflows/老照片修复.json 的节点图一致）：
//   读入 → 缩到 1024² → Z-Image Q8_0 低重绘（denoise 0.40）→ 4 倍超分 → 存图（4096²）
// 用途：切换 py3.10 环境时复测这条链路的耗时，与 py3.8 基线（约 100 秒 / 4096²）对比。
//
// 用法（板上）：node gen-restore.js [输入图] [denoise] [超分模型]
//   node /var/lib/llm/gen-restore.js testphoto.png 0.40 4x-UltraSharp.pth
// 端口用环境变量 PORT 覆盖（默认 8188），输出目录用 OUTDIR 覆盖。
const http = require("http");
const fs = require("fs");
const path = require("path");

const HOST = "127.0.0.1", PORT = parseInt(process.env.PORT || "8188", 10);
const OUTDIR = process.env.OUTDIR || "/var/lib/llm/comfyui310/output";
const IMG = process.argv[2] || "example.png";
const DENOISE = parseFloat(process.argv[3] || "0.40");
const UPS = process.argv[4] || "4x-UltraSharp.pth";
const SEED = Date.now() % 2147483647;   // 固定 seed 会命中 execution_cached，数据作废

function req(method, path_, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({
      host: HOST, port: PORT, path: path_, method, timeout: 900000,
      headers: data ? { "Content-Type": "application/json", "Content-Length": data.length } : {},
    }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ code: res.statusCode, body: d }));
    });
    r.on("error", reject);
    r.on("timeout", () => { r.destroy(); reject(new Error("timeout")); });
    if (data) r.write(data);
    r.end();
  });
}

// PNG 的 IHDR 固定在 16~23 字节：宽高各 4 字节大端
function pngSize(f) {
  try {
    const fd = fs.openSync(f, "r");
    const b = Buffer.alloc(24);
    fs.readSync(fd, b, 0, 24, 0);
    fs.closeSync(fd);
    return b.readUInt32BE(16) + "x" + b.readUInt32BE(20);
  } catch (e) { return "?"; }
}

const wf = {
  "1": { class_type: "LoadImage", inputs: { image: IMG } },
  "2": { class_type: "ImageScale", inputs: {
      upscale_method: "lanczos", width: 1024, height: 1024, crop: "disabled", image: ["1", 0] } },
  "3": { class_type: "UnetLoaderGGUF", inputs: { unet_name: "z_image_turbo-Q8_0.gguf" } },
  "4": { class_type: "CLIPLoader", inputs: {
      clip_name: "qwen_3_4b.safetensors", type: "lumina2", device: "default" } },
  "5": { class_type: "VAELoader", inputs: { vae_name: "ae.safetensors" } },
  "6": { class_type: "CLIPTextEncode", inputs: {
      text: "一张修复完好的老照片，人物面部清晰自然，皮肤纹理真实，衣物褶皱清晰，胶片质感，柔和自然光，画面干净无划痕无污渍，高清",
      clip: ["4", 0] } },
  "7": { class_type: "CLIPTextEncode", inputs: {
      text: "划痕，污渍，霉斑，噪点，模糊，过度锐化，塑料感，油画感", clip: ["4", 0] } },
  "8": { class_type: "VAEEncode", inputs: { pixels: ["2", 0], vae: ["5", 0] } },
  "9": { class_type: "KSampler", inputs: {
      seed: SEED, steps: 8, cfg: 1.0, sampler_name: "euler", scheduler: "simple",
      denoise: DENOISE, model: ["3", 0], positive: ["6", 0], negative: ["7", 0],
      latent_image: ["8", 0] } },
  "11": { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["5", 0] } },
  "12": { class_type: "UpscaleModelLoader", inputs: { model_name: UPS } },
  "13": { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["12", 0], image: ["11", 0] } },
  "14": { class_type: "SaveImage", inputs: { filename_prefix: "restored", images: ["13", 0] } },
};

(async () => {
  console.log(`  === 老照片修复 ${IMG} denoise=${DENOISE} 超分=${UPS} 端口=${PORT} ===`);
  const t0 = Date.now();
  const sub = await req("POST", "/prompt", { prompt: wf });
  if (sub.code !== 200) {
    console.log("  x 提交失败 HTTP " + sub.code);
    console.log("  " + sub.body.slice(0, 900));
    return;
  }
  const pid = JSON.parse(sub.body).prompt_id;
  for (let i = 0; i < 900; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const h = await req("GET", "/history/" + pid);
    if (h.code === 200 && h.body.length > 10) {
      const j = JSON.parse(h.body);
      const st = j[pid] && j[pid].status;
      if (st && st.completed) {
        const dt = (Date.now() - t0) / 1000;
        const imgs = [];
        for (const k of Object.keys(j[pid].outputs || {})) {
          (j[pid].outputs[k].images || []).forEach((im) => imgs.push(im));
        }
        const desc = imgs.map((im) => {
          const f = path.join(OUTDIR, im.subfolder || "", im.filename);
          return im.filename + "(" + pngSize(f) + ")";
        }).join(",");
        let cached = false;
        for (const m of st.messages || []) {
          if (m[0] === "execution_cached" && (m[1].nodes || []).indexOf("9") >= 0) cached = true;
        }
        console.log("  * 完成 " + dt.toFixed(1) + " 秒"
          + (cached ? "   ! 采样器命中缓存，数据无效" : "") + "  " + desc);
        return;
      }
      if (st && st.status_str === "error") {
        console.log("  x 执行失败");
        for (const m of st.messages || []) {
          if (m[0] === "execution_error") {
            console.log("    " + (m[1].exception_type || "") + ": "
              + String(m[1].exception_message || "").slice(0, 400));
          }
        }
        return;
      }
    }
  }
  console.log("  x 超时");
})();
