#!/bin/sh
# 面板部署后的验证。
# ★ 陷阱 39 的判据：server.js 的 ROOT = __dirname，静态文件从 panel/ 根提供，
#   dist/ 子目录不在服务路径上。所以必须核对 index.html 引用的 JS 文件名
#   与 assets/ 里实际存在的文件一致 —— 上一块板曾因此跑了 13 小时的旧界面。
set -u
P=/var/lib/llm/panel

echo "############ 1. panel 目录结构（产物必须摊平在根，不能留在 dist/）############"
ls -la "$P" | sed 's/^/  /'
echo "--- assets/ ---"
ls -la "$P/assets" 2>/dev/null | sed 's/^/  /'
if [ -d "$P/dist" ]; then
  echo "  ★ 还存在 dist/ 子目录 —— 里面的东西不会被提供，检查是否摊平漏了"
  ls -1 "$P/dist" | sed 's/^/    /'
fi

echo
echo "############ 2. ★ index.html 引用的资源 vs 实际文件（陷阱 39）############"
REF_JS=$(grep -oE 'index-[A-Za-z0-9_-]+\.js' "$P/index.html" 2>/dev/null | head -1)
REF_CSS=$(grep -oE 'index-[A-Za-z0-9_-]+\.css' "$P/index.html" 2>/dev/null | head -1)
echo "  index.html 引用: JS=$REF_JS  CSS=$REF_CSS"
echo "  assets/ 实际有: $(ls -1 "$P/assets" 2>/dev/null | tr '\n' ' ')"
OK=1
[ -n "$REF_JS" ] && { [ -f "$P/assets/$REF_JS" ] && echo "  ✓ JS 对得上" || { echo "  ★ JS 引用的文件不存在"; OK=0; }; }
[ -n "$REF_CSS" ] && { [ -f "$P/assets/$REF_CSS" ] && echo "  ✓ CSS 对得上" || { echo "  ★ CSS 引用的文件不存在"; OK=0; }; }

echo
echo "############ 3. 配置与模板 ############"
for f in /var/lib/llm/config.json /var/lib/llm/3.6_chat_template-v10.jinja /var/lib/llm/panel-auth.json; do
  if [ -f "$f" ]; then echo "  ✓ $f  $(stat -c '%s 字节 权限 %a' "$f")"; else echo "  ★ 缺 $f"; fi
done
echo "--- config.json 里的关键路径 ---"
grep -E '"(model|mmproj|embeddingModel)"' /var/lib/llm/config.json 2>/dev/null | sed 's/^/    /'
echo "--- 这些模型文件在不在 ---"
for m in $(grep -oE '/opt/m/llm/[A-Za-z0-9._-]+\.gguf' /var/lib/llm/config.json 2>/dev/null | sort -u); do
  if [ -f "$m" ]; then echo "    ✓ $(basename "$m") $(stat -c %s "$m") 字节"; else echo "    ★ 缺 $m"; fi
done

echo
echo "############ 4. 启动面板 ############"
systemctl daemon-reload
systemctl enable iecu-panel 2>&1 | tail -1
systemctl restart iecu-panel
i=0
while [ $i -lt 30 ]; do
  ss -lnt 2>/dev/null | grep -q ':9000' && break
  sleep 1; i=$((i + 1))
done
echo "  9000 监听: $(ss -lnt 2>/dev/null | grep -c ':9000') 处，耗时 ${i} 秒"
systemctl is-active iecu-panel
systemctl is-enabled iecu-panel

echo
echo "############ 5. 判据：探端口 + 打真实 HTTP 请求（不看 systemctl）############"
/var/lib/llm/bin/node - <<'JS'
const http = require('http');
const tests = [
  ['/', '面板首页'],
  ['/api/auth/state', '登录状态（Caddy 健康检查打的就是这个）'],
  ['/api/status', '状态接口'],
];
let i = 0;
function next() {
  if (i >= tests.length) return;
  const [path, name] = tests[i++];
  const req = http.get({ host: '127.0.0.1', port: 9000, path, timeout: 8000 }, (res) => {
    let n = 0;
    res.on('data', d => n += d.length);
    res.on('end', () => { console.log(`  ${path.padEnd(20)} HTTP ${res.statusCode}  ${n} 字节  (${name})`); next(); });
  });
  req.on('error', e => { console.log(`  ${path.padEnd(20)} 失败: ${e.message}`); next(); });
  req.on('timeout', () => { req.destroy(); console.log(`  ${path.padEnd(20)} 超时`); next(); });
}
next();
JS

echo
echo "############ 6. 日志 ############"
journalctl -u iecu-panel -n 12 --no-pager 2>/dev/null | sed 's/.*node\[[0-9]*\]: //' | tail -12

echo
echo "############ 7. 模型下载进度 ############"
grep -E '^(OK|FAIL|BEGIN)' /var/lib/llm/tmp/models-dl.log 2>/dev/null | tail -3
grep PROGRESS /var/lib/llm/tmp/models-dl.log 2>/dev/null | tail -1
systemctl is-active iecu-model-dl
