// 带完整性校验与重试的模型下载器。
// 之前用简易 pipe 写文件，遇到 HPE_CLOSED_CONNECTION 时 error 与 finish 会同时触发，
// 结果落下一个被截断的文件、还报了 OK。这里改成：先看 content-length，
// 写完比对字节数，不一致就删掉重来。
const http = require("http");
const fs = require("fs");
const path = require("path");

const HOST = "__FRPS_LAN_IP__", PORT = 18082;
const MAX_RETRY = 3;

function download(name, dest, expectSize) {
  return new Promise((resolve) => {
    const tmp = dest + ".part";
    try { fs.unlinkSync(tmp); } catch (e) {}
    const t0 = Date.now();
    const req = http.get(
      { host: HOST, port: PORT, path: "/" + encodeURIComponent(name), timeout: 900000 },
      (res) => {
        if (res.statusCode !== 200) {
          console.log("    HTTP " + res.statusCode);
          res.resume();
          return resolve(false);
        }
        const len = parseInt(res.headers["content-length"] || "0", 10);
        if (expectSize && len && len !== expectSize) {
          console.log("    content-length " + len + " 与预期 " + expectSize + " 不符");
        }
        const ws = fs.createWriteStream(tmp);
        let got = 0, failed = false;
        res.on("data", (c) => { got += c.length; });
        res.on("error", (e) => { failed = true; console.log("    响应错误 " + e.code); });
        ws.on("error", (e) => { failed = true; console.log("    写入错误 " + e.code); });
        res.pipe(ws);
        ws.on("close", () => {
          const size = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
          const want = expectSize || len;
          const dt = (Date.now() - t0) / 1000;
          if (failed || (want && size !== want)) {
            console.log("    不完整: 收到 " + size + " / 期望 " + want + "，丢弃");
            try { fs.unlinkSync(tmp); } catch (e) {}
            return resolve(false);
          }
          fs.renameSync(tmp, dest);
          console.log("    ✓ " + (size / 1073741824).toFixed(2) + " GB  " +
                      dt.toFixed(1) + "s  " + (size / 1048576 / dt).toFixed(0) + " MB/s");
          resolve(true);
        });
      }
    );
    req.on("error", (e) => { console.log("    连接错误 " + e.code); resolve(false); });
    req.on("timeout", () => { console.log("    超时"); req.destroy(); resolve(false); });
  });
}

(async () => {
  // [远程文件名, 落地路径, 精确字节数]
  const jobs = JSON.parse(process.argv[2]);
  for (const [name, dest, size] of jobs) {
    console.log("  " + name + " → " + dest);
    if (fs.existsSync(dest) && fs.statSync(dest).size === size) {
      console.log("    已存在且大小正确，跳过");
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let ok = false;
    for (let i = 1; i <= MAX_RETRY && !ok; i++) {
      if (i > 1) console.log("    第 " + i + " 次尝试");
      ok = await download(name, dest, size);
    }
    if (!ok) console.log("    ✗ " + MAX_RETRY + " 次均失败");
  }
})();
