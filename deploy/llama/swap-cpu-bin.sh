#!/bin/sh
# 把 llama/bin（CPU 版，向量服务在用）换成新版，但**先验证向量数值等价**。
#
# 为什么必须验：建库与查询必须用同一套向量（陷阱 34）。F16→Q8 那次余弦 0.9997、
# 单维差 5.6e-3 就已经要求整库重建了，所以"看着差不多"不是判据。
# 换二进制理论上不该改数值，但理论不是判据——同一个模型换 llama.cpp 版本，
# 内核实现、累加顺序、默认池化都可能变。
#
# 用法: sh swap-cpu-bin.sh verify   只验证，不动任何东西
#       sh swap-cpu-bin.sh swap     验证通过才换（不通过直接退出）
#       sh swap-cpu-bin.sh rollback 换回老的
set -u
L=/var/lib/llm/llama
N=/var/lib/llm/bin/node
T=/var/lib/llm/tmp
NEW=$L/bin-new-cpu
OLD_TAG=b1-dd1ea52
BASE=$T/embed-base-dd1ea52.json
CFG=/var/lib/llm/config.json

get() { $N -e "const c=require('$CFG');process.stdout.write(String(c['$1']===undefined?'':c['$1']))"; }

verify() {
  [ -x "$NEW/llama-server" ] || { echo "★ $NEW/llama-server 不存在"; return 1; }
  [ -f "$BASE" ] || { echo "★ 没有老版向量基线 $BASE，先在老版上跑 embed-fingerprint.js save"; return 1; }

  MODEL=$(get embeddingModel); MODEL=${MODEL:-/opt/m/llm/Qwen3-Embedding-0.6B-Q8_0.gguf}
  PAR=$(get embeddingParallel); PAR=${PAR:-1}
  SLOT=$(get embeddingCtxSlot); SLOT=${SLOT:-4096}
  CRAM=$(get embeddingCacheRam); CRAM=${CRAM:-0}
  CTX=$((PAR * SLOT))

  echo "  停生产向量服务（8081 要腾给测试实例）"
  systemctl stop llm-embedding
  sleep 2

  echo "  用新版 CPU 二进制起临时向量服务（参数与 run-embedding.sh 的 CPU 档一致）"
  systemctl reset-failed iecu-test-embed 2>/dev/null
  systemd-run --unit=iecu-test-embed --collect \
    --setenv=LD_LIBRARY_PATH="$NEW:/usr/lib" \
    --setenv=CUDA_VISIBLE_DEVICES= \
    "$NEW/llama-server" \
      --model "$MODEL" \
      --host 127.0.0.1 --port 8081 \
      --embedding --pooling last \
      --ctx-size "$CTX" --parallel "$PAR" --cache-ram "$CRAM" \
      --metrics --n-gpu-layers 0 --threads 11 \
      --alias qwen3-embedding-0.6b >/dev/null 2>&1

  i=0; ok=0
  while [ $i -lt 40 ]; do
    if $N -e 'require("http").get({host:"127.0.0.1",port:8081,path:"/health"},r=>process.exit(r.statusCode===200?0:1)).on("error",()=>process.exit(1))' 2>/dev/null; then ok=1; break; fi
    systemctl is-active iecu-test-embed >/dev/null 2>&1 || break
    i=$((i+1)); sleep 2
  done
  echo "  等待 $((i*2))s  health=$ok"
  if [ "$ok" != "1" ]; then
    echo "  ★ 新版 CPU 二进制起不来："
    journalctl -u iecu-test-embed --no-pager -n 25 | tail -15 | sed 's/^/    /'
    systemctl stop iecu-test-embed 2>/dev/null; systemctl start llm-embedding
    return 1
  fi

  echo "  确认它确实走了 CPU（nvmap 占用应为 0）"
  awk '/llama-server/ {print "    nvmap: "$1" "$4}' /sys/kernel/debug/nvmap/iovmm/clients 2>/dev/null

  echo "  比对向量数值："
  $N "$T/embed-fingerprint.js" diff "$BASE" | sed 's/^/    /'
  RC=$?

  systemctl stop iecu-test-embed 2>/dev/null
  sleep 1
  systemctl start llm-embedding
  return $RC
}

case "${1:-verify}" in
  verify) verify ;;
  swap)
    verify || { echo "★ 验证不通过，不换"; exit 1; }
    echo
    echo "=== 换 bin/ ==="
    [ -d "$L/bin-$OLD_TAG" ] && { echo "★ $L/bin-$OLD_TAG 已存在，先处理"; exit 1; }
    systemctl stop llm-embedding
    mv "$L/bin" "$L/bin-$OLD_TAG" || exit 1
    mv "$NEW" "$L/bin"            || exit 1
    systemctl start llm-embedding
    sleep 8
    echo "  llm-embedding: $(systemctl is-active llm-embedding)"
    LD_LIBRARY_PATH="$L/bin:/usr/lib" "$L/bin/llama-server" --version 2>&1 | head -1 | sed 's/^/  bin 现在是: /'
    ;;
  rollback)
    [ -d "$L/bin-$OLD_TAG" ] || { echo "★ 没有 $L/bin-$OLD_TAG"; exit 1; }
    systemctl stop llm-embedding
    mv "$L/bin" "$NEW" && mv "$L/bin-$OLD_TAG" "$L/bin" || exit 1
    systemctl start llm-embedding
    echo "  已回滚。bin = $(LD_LIBRARY_PATH="$L/bin:/usr/lib" "$L/bin/llama-server" --version 2>&1 | head -1)"
    ;;
  *) echo "用法: $0 verify|swap|rollback"; exit 2 ;;
esac
