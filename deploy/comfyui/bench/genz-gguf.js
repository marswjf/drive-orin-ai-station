// Z-Image Turbo 走 GGUF 量化权重出图与测速。
// 与 genz.js 的唯一区别：UNETLoader -> UnetLoaderGGUF（ComfyUI-GGUF 节点）。
// 目的：把 DiT 从 bf16 的 11.46 GB 压到 Q8_0 的 6.73 GB，
//       让模型总量装得下、免掉 lowvram 的逐层搬运（那才是 13.79 秒/步的主因）。
const http = require("http");

const HOST = "127.0.0.1", PORT = 8188;
const UNET = process.argv[2] || "z_image_turbo-Q8_0.gguf";
const W = parseInt(process.argv[3] || "1024", 10);
const H = parseInt(process.argv[4] || "1024", 10);
const STEPS = parseInt(process.argv[5] || "8", 10);
const LABEL = process.argv[6] || "";
const SEED = Date.now() % 2147483647;   // 陷阱 46：seed 固定会命中 execution_cached

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({
      host: HOST, port: PORT, path, method, timeout: 900000,
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

const wf = {
  "1": { class_type: "UnetLoaderGGUF", inputs: { unet_name: UNET } },
  "2": { class_type: "CLIPLoader", inputs: {
      clip_name: "qwen_3_4b.safetensors", type: "lumina2", device: "default" } },
  "3": { class_type: "VAELoader", inputs: { vae_name: "ae.safetensors" } },
  "4": { class_type: "CLIPTextEncode", inputs: {
      text: "一只银渐层英短小猫戴着宇航头盔漂浮在太空中，地球在背景里，电影感光照，超高细节",
      clip: ["2", 0] } },
  "5": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["2", 0] } },
  "6": { class_type: "EmptySD3LatentImage", inputs: { width: W, height: H, batch_size: 1 } },
  "7": { class_type: "KSampler", inputs: {
      seed: SEED, steps: STEPS, cfg: 1.0, sampler_name: "euler", scheduler: "simple",
      denoise: 1.0, model: ["1", 0], positive: ["4", 0], negative: ["5", 0],
      latent_image: ["6", 0] } },
  "8": { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["3", 0] } },
  "9": { class_type: "SaveImage", inputs: { filename_prefix: "zgguf", images: ["8", 0] } },
};

(async () => {
  const tag = LABEL || `${UNET} ${W}x${H} ${STEPS}步`;
  console.log("  === " + tag + " ===");
  const t0 = Date.now();
  const sub = await req("POST", "/prompt", { prompt: wf });
  if (sub.code !== 200) {
    console.log("  ✗ 提交失败 HTTP " + sub.code);
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
          (j[pid].outputs[k].images || []).forEach((im) => imgs.push(im.filename));
        }
        let cached = false;
        for (const m of st.messages || []) {
          if (m[0] === "execution_cached" && (m[1].nodes || []).indexOf("7") >= 0) cached = true;
        }
        console.log("  ★ 完成 " + dt.toFixed(1) + " 秒  (" + (dt / STEPS).toFixed(2) + " 秒/步)"
          + (cached ? "   ⚠ 采样器命中缓存，数据无效" : "") + "  " + imgs.join(","));
        return;
      }
      if (st && st.status_str === "error") {
        console.log("  ✗ 执行失败");
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
  console.log("  ✗ 超时");
})();
