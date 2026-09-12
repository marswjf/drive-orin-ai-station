#!/bin/sh
# 验证板上的 node 能真跑（不只是文件在）。
chmod 755 /var/lib/llm/bin/node 2>/dev/null
echo "=== 版本 ==="
/var/lib/llm/bin/node -v
echo "=== 动态库依赖（glibc 2.31 兼容性判据）==="
if ldd /var/lib/llm/bin/node 2>&1 | grep -q 'not found'; then
  echo "  ★ 有未解析的库："
  ldd /var/lib/llm/bin/node 2>&1 | grep 'not found'
else
  echo "  全部解析 ✓"
fi
ldd /var/lib/llm/bin/node 2>&1 | grep -E 'libc\.so|libstdc|libm\.so|libgcc' | sed 's/^/  /'
echo "=== 跑真代码 ==="
/var/lib/llm/bin/node -e 'const os=require("os");console.log("arch:",process.arch,"| node:",process.version,"| cpus:",os.cpus().length,"| mem:",(os.totalmem()/1073741824).toFixed(1)+"G")'
echo "=== 面板要用的内置模块 ==="
/var/lib/llm/bin/node -e 'for (const m of ["http","https","crypto","zlib","child_process","fs","net","os","url","stream"]) require(m); console.log("10 个内置模块全部可用 ✓")'
echo "=== HTTPS 出网能力（下模型要靠它）==="
/var/lib/llm/bin/node -e '
const https=require("https");
const req=https.get("https://modelscope.cn/", {timeout:12000}, r=>{
  console.log("  modelscope HTTP", r.statusCode, "✓ node 能出网下载");
  r.destroy(); process.exit(0);
});
req.on("timeout",()=>{console.log("  ★ 超时");process.exit(1)});
req.on("error",e=>{console.log("  ★ 出错",e.message);process.exit(1)});
'
