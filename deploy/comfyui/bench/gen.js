// 用 ComfyUI 的 HTTP API 跑一张图并计时。
// 走 /prompt 提交、轮询 /history 拿结果，不依赖 WebSocket。
const http = require("http");

const HOST = "127.0.0.1", PORT = 8188;
const CKPT = process.argv[2] || "v1-5-pruned-emaonly.safetensors";
const W = parseInt(process.argv[3] || "512", 10);
const H = parseInt(process.argv[4] || "512", 10);
const STEPS = parseInt(process.argv[5] || "20", 10);
const LABEL = process.argv[6] || "";
// seed 必须每次不同：ComfyUI 会按节点输入做缓存，同参数重跑会直接命中
// execution_cached 秒回，测出来的"复跑 2 秒"是假的。
const SEED = parseInt(process.argv[7] || "0", 10) || (Date.now() % 2147483647);

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

const workflow = {
  "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: CKPT } },
  "2": { class_type: "CLIPTextEncode", inputs: { text: "a photograph of a red sports car on a mountain road, golden hour, highly detailed", clip: ["1", 1] } },
  "3": { class_type: "CLIPTextEncode", inputs: { text: "blurry, low quality, watermark", clip: ["1", 1] } },
  "4": { class_type: "EmptyLatentImage", inputs: { width: W, height: H, batch_size: 1 } },
  "5": { class_type: "KSampler", inputs: {
      seed: SEED, steps: STEPS, cfg: 7.0, sampler_name: "euler", scheduler: "normal",
      denoise: 1.0, model: ["1", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0] } },
  "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
  "7": { class_type: "SaveImage", inputs: { filename_prefix: "iecu_bench", images: ["6", 0] } },
};

(async () => {
  const tag = LABEL || (CKPT.split(".")[0] + " " + W + "x" + H + " " + STEPS + "步");
  console.log("  === " + tag + " ===");
  const t0 = Date.now();
  const sub = await req("POST", "/prompt", { prompt: workflow });
  if (sub.code !== 200) {
    console.log("  提交失败 HTTP " + sub.code + ": " + sub.body.slice(0, 400));
    return;
  }
  const pid = JSON.parse(sub.body).prompt_id;
  console.log("  已提交 " + pid.slice(0, 8));

  let last = 0;
  for (let i = 0; i < 900; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const h = await req("GET", "/history/" + pid);
    if (h.code === 200 && h.body.length > 10) {
      const j = JSON.parse(h.body);
      if (j[pid] && j[pid].status && j[pid].status.completed) {
        const dt = (Date.now() - t0) / 1000;
        const imgs = [];
        for (const k of Object.keys(j[pid].outputs || {})) {
          (j[pid].outputs[k].images || []).forEach((im) => imgs.push(im.filename));
        }
        // 看 KSampler 有没有被缓存跳过——被跳过的话这个耗时不能当成生成速度
        let cachedSampler = false;
        for (const msg of j[pid].status.messages || []) {
          if (msg[0] === "execution_cached" && (msg[1].nodes || []).indexOf("5") >= 0) {
            cachedSampler = true;
          }
        }
        console.log("  ★ 完成 " + dt.toFixed(1) + " 秒" +
                    (STEPS ? "  (" + (dt / STEPS).toFixed(2) + " 秒/步)" : "") +
                    (cachedSampler ? "   ⚠ 采样器命中缓存，此数据无效" : ""));
        console.log("  产出: " + imgs.join(", ") + "   seed=" + SEED);
        return;
      }
      if (j[pid] && j[pid].status && j[pid].status.status_str === "error") {
        console.log("  执行出错:");
        console.log(JSON.stringify(j[pid].status.messages).slice(0, 700));
        return;
      }
    }
    const el = (Date.now() - t0) / 1000;
    if (el - last >= 30) { last = el; console.log("    ... 已用 " + el.toFixed(0) + " 秒"); }
  }
  console.log("  超时未完成");
})();
