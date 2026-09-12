#!/bin/sh
# 在 bin-test/ 的测试二进制上做 A/B，全程不碰 bin-cuda/ 与 config.json。
# 用法: SPEC='--spec-type draft-mtp --spec-draft-n-max 2' TAG=new-mtp sh test-bin-test.sh
#
# 为什么要有 MTP 对照组：测试二进制比生产版新 143 个提交，
# 「DFlash2 快了多少」必须和「新版 llama.cpp 本身快了多少」分开，
# 否则把版本红利记到 DFlash2 头上（或反过来）。
set -u
D=/var/lib/llm/llama/bin-test
N=/var/lib/llm/bin/node
TAG=${TAG:-test}
SPEC=${SPEC:-}
PORT=8080

[ -x "$D/llama-server" ] || { echo "★ $D/llama-server 不存在"; exit 1; }

echo "=== A. 停生产服务（两个大模型不能同时占内存）==="
systemctl stop llm-server 2>/dev/null
sleep 3
grep MemAvailable /proc/meminfo | sed 's/^/  /'

echo
echo "=== B. 起测试二进制（transient unit，跑完即弃）==="
systemctl reset-failed iecu-test-llm 2>/dev/null
systemd-run --unit=iecu-test-llm --collect \
  --setenv=LD_LIBRARY_PATH="$D:/usr/lib" \
  "$D/llama-server" \
    --model /opt/update/llm/Qwen3.8-27B-IQ4_XS.gguf \
    --host 127.0.0.1 --port $PORT \
    --ctx-size 65536 --threads 10 --parallel 1 --cache-ram 1024 \
    --alias qwen3.8-27b --metrics \
    --batch-size 2048 --ubatch-size 1024 --n-gpu-layers 99 \
    --flash-attn on --cache-type-k q8_0 --cache-type-v q8_0 \
    --reasoning-format deepseek-legacy \
    $SPEC \
    --temp 1.0 --top-p 0.95 --top-k 20 --min-p 0 --presence-penalty 0.0 2>&1 | sed 's/^/  /'

echo "  等端口真可用（不看 systemctl active，陷阱 51）"
i=0; ok=0
while [ $i -lt 120 ]; do
  if $N -e 'require("http").get({host:"127.0.0.1",port:8080,path:"/health"},r=>{process.exit(r.statusCode===200?0:1)}).on("error",()=>process.exit(1))' 2>/dev/null; then ok=1; break; fi
  systemctl is-active iecu-test-llm >/dev/null 2>&1 || { echo "  ★ 单元已退出"; break; }
  i=$((i+1)); sleep 5
done
echo "  等待 $((i*5))s  health=$ok"
if [ "$ok" != "1" ]; then
  echo "  --- 日志 ---"
  journalctl -u iecu-test-llm --no-pager -n 60 2>/dev/null | tail -40 | sed 's/^/    /'
  systemctl stop iecu-test-llm 2>/dev/null
  exit 1
fi

echo
echo "=== C. 启动日志里的投机实现与告警 ==="
journalctl -u iecu-test-llm --no-pager -n 400 2>/dev/null \
  | grep -iE 'dflash|dspark|spec|block_size|selector|conv|target_layer|not supported|disabled|error|warn' \
  | tail -20 | sed 's/^/  /'

echo
echo "=== D. 版本核对 ==="
$N -e 'require("http").get({host:"127.0.0.1",port:8080,path:"/props"},r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>{try{const j=JSON.parse(d);console.log("  build="+j.build_info+"  alias="+j.model_alias+"  n_ctx="+(j.default_generation_settings||{}).n_ctx);}catch(e){console.log("  props 解析失败");}});}).on("error",e=>console.log("  "+e.message))'

echo
echo "=== E. 热身（不计入）==="
$N /var/lib/llm/tmp/mtpbench.js warm '[["warm",1500,[1]]]' 2>&1 | tail -1

echo
echo "=== F. 正式测（与历次基线同法同长度）==="
$N /var/lib/llm/tmp/mtpbench.js "$TAG" '[["2k",2000,[1]],["8k",8000,[1]]]'

echo
echo "=== G. 内存 ==="
grep MemAvailable /proc/meminfo | sed 's/^/  /'
awk '/llama-server/ {print "  nvmap: "$4}' /sys/kernel/debug/nvmap/iovmm/clients 2>/dev/null

echo
echo "=== H. 收尾：停测试实例（生产服务由调用方决定何时拉起）==="
systemctl stop iecu-test-llm 2>/dev/null
sleep 2
echo "  iecu-test-llm: $(systemctl is-active iecu-test-llm 2>&1)"
