#!/bin/sh
# 新板上验证 llama.cpp 二进制可用，然后起推理服务。
# 判据不是"文件在"，而是 ① --version 能跑 ② ldd 无 not found ③ 端口真的在听
# ④ /v1/models 有响应（陷阱 51：systemctl active 不算数）
set -u
D=/var/lib/llm

echo "############ 1. 目录结构 ############"
ls -la "$D/llama/" | sed 's/^/  /'

echo
echo "############ 2. 启动脚本必须在 llama/ 下（unit 的 ExecStart 指那里）############"
for f in run-server.sh run-embedding.sh; do
  if [ -x "$D/llama/$f" ]; then
    echo "  ✓ $D/llama/$f"
  elif [ -f "$D/$f" ]; then
    echo "  修正位置: $D/$f → $D/llama/$f"
    cp "$D/$f" "$D/llama/$f" && chmod 755 "$D/llama/$f" && echo "    ✓ 已复制"
  else
    echo "  ★ 两处都没有 $f"
  fi
done

echo
echo "############ 3. 二进制自检 ############"
for b in "$D/llama/bin-cuda/llama-server" "$D/llama/bin/llama-server"; do
  echo "--- $b ---"
  if [ ! -e "$b" ]; then echo "    不存在"; continue; fi
  chmod 755 "$b" 2>/dev/null
  ls -l "$b" | sed 's/^/    /'
  echo "    --- ldd 未解析的库 ---"
  if ldd "$b" 2>&1 | grep -q 'not found'; then
    ldd "$b" 2>&1 | grep 'not found' | sed 's/^/      ★ /'
  else
    echo "      全部解析 ✓"
  fi
  echo "    --- libcuda 来自哪里（必须是板子自己的驱动）---"
  ldd "$b" 2>&1 | grep -i 'libcuda' | sed 's/^/      /'
  echo "    --- --version ---"
  "$b" --version 2>&1 | head -3 | sed 's/^/      /'
done

echo
echo "############ 4. 装 unit 并启动向量服务（小、快，先验证链路）############"
systemctl daemon-reload
systemctl enable llm-embedding 2>&1 | tail -1
systemctl restart llm-embedding
i=0
while [ $i -lt 60 ]; do ss -lnt 2>/dev/null | grep -q ':8081' && break; sleep 2; i=$((i+1)); done
echo "  8081 监听耗时 $((i*2)) 秒"
systemctl is-active llm-embedding
echo "--- 日志 ---"
journalctl -u llm-embedding -n 12 --no-pager 2>/dev/null | sed 's/.*run-embedding\.sh\[[0-9]*\]: //' | tail -12

echo
echo "############ 5. 起主推理服务（18.2G 模型 mmap，可能要一两分钟）############"
systemctl enable llm-server 2>&1 | tail -1
systemctl restart llm-server
T0=$(date +%s)
i=0
while [ $i -lt 300 ]; do ss -lnt 2>/dev/null | grep -q ':8080' && break; sleep 3; i=$((i+1)); done
T1=$(date +%s)
echo "  8080 监听耗时 $((T1-T0)) 秒（基线板 MTP 档 78~95 秒）"
systemctl is-active llm-server

echo
echo "############ 6. 真实 HTTP 判据 ############"
"$D/bin/node" - <<'JS'
const http = require('http');
function get(port, path, label) {
  return new Promise(res => {
    const r = http.get({host:'127.0.0.1', port, path, timeout:20000}, x => {
      let b=''; x.on('data',d=>b+=d); x.on('end',()=>{ console.log(`  ${label} HTTP ${x.statusCode}  ${b.length} 字节`); if(b.length<400) console.log('    '+b.trim().slice(0,300)); res(); });
    });
    r.on('error', e=>{ console.log(`  ${label} 失败 ${e.message}`); res(); });
    r.on('timeout', ()=>{ r.destroy(); console.log(`  ${label} 超时`); res(); });
  });
}
(async()=>{
  await get(8080,'/health','llm-server /health   ');
  await get(8080,'/props','llm-server /props    ');
  await get(8081,'/health','embedding /health    ');
  await get(9000,'/v1/models','面板 /v1/models      ');
})();
JS

echo
echo "############ 7. 内存归因（nvmap 不计入 RSS）############"
free -m | head -2
cat /sys/kernel/debug/nvmap/iovmm/clients 2>/dev/null | tail -6
echo "--- 端口全景 ---"
ss -lntp 2>/dev/null | grep -E ':(8080|8081|8188|9000)' | awk '{print "  "$4"  "$6}'
