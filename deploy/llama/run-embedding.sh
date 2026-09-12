#!/bin/bash
# Embedding 服务：Qwen3-Embedding-0.6B，独立端口，可与主模型同时运行（只占几百 MB）。
set -u

LLM_ROOT=/var/lib/llm
NODE=$LLM_ROOT/bin/node
CFG=$LLM_ROOT/config.json

[ -f "$CFG" ] || { echo "FATAL: $CFG 不存在"; exit 78; }
get() { "$NODE" -e "const c=require('$CFG');const v=c['$1'];process.stdout.write(v===undefined||v===null?'':String(v))" 2>/dev/null; }

# 模型路径可由 config.json 的 embeddingModel 覆盖（2026-08-12 起，Q8_0 换装用）
MODEL=$(get embeddingModel); MODEL=${MODEL:-/opt/m/llm/Qwen3-Embedding-0.6B-f16.gguf}

# 计算后端：embeddingBackend 显式指定，缺省跟随主服务的 backend
BACKEND=$(get embeddingBackend); BACKEND=${BACKEND:-$(get backend)}; BACKEND=${BACKEND:-cpu}
[ "$BACKEND" = "cuda" ] && BINDIR=$LLM_ROOT/llama/bin-cuda || BINDIR=$LLM_ROOT/llama/bin
[ -x "$BINDIR/llama-server" ] || BINDIR=$LLM_ROOT/llama/bin
BIN=$BINDIR/llama-server

# CPU 档：两个目录下是同一个带 CUDA 的二进制，仅靠 -ngl 0 仍会建 CUDA 上下文并占 GPU 映射
# 内存。置空 CUDA_VISIBLE_DEVICES 才会走到"没有可用设备"分支，nvmap 占用归零【实测】。
# 线程数 11 = 可调度核数（CPU5 被 isolcpus 隔离，nproc 已经把它排除）。
if [ "$BACKEND" = "cpu" ]; then
  export CUDA_VISIBLE_DEVICES=
  NGL=0; THREADS=11
else
  NGL=99; THREADS=2
fi

[ -x "$BIN" ] || { echo "FATAL: $BIN 不存在（llama.cpp 尚未编译部署）"; exit 78; }
[ -f "$MODEL" ] || { echo "FATAL: 模型不存在: $MODEL"; exit 78; }

PORT=$(get embeddingPort);   PORT=${PORT:-8081}
PAR=$(get embeddingParallel); PAR=${PAR:-1}      # 并发路数
SLOT=$(get embeddingCtxSlot); SLOT=${SLOT:-4096} # 每路上下文
# prompt 缓存对 embedding 无效：每段待编码文本的前缀都不一样，命中率接近零，
# 只会占内存并刷"超过上限，跳过"的日志。0 = 关闭（llama.cpp 实测语义）。
CRAM=$(get embeddingCacheRam); CRAM=${CRAM:-0}
CTX=$((PAR * SLOT))                              # llama.cpp 的 --ctx-size 是总量，按路数均分

export LD_LIBRARY_PATH=$BINDIR:/usr/lib:${LD_LIBRARY_PATH:-}

echo "模型: $MODEL"
echo "后端: $BACKEND  并发 $PAR × 每路 $SLOT = 总 ctx $CTX  cache-ram ${CRAM}MiB  ngl $NGL  线程 $THREADS"

# --embedding 开启 /v1/embeddings 端点；--pooling last 是 Qwen3-Embedding 的正确池化方式
# --metrics 必须显式开启，否则 /metrics 返回 501，面板上这个服务的统计全是空的
exec "$BIN" \
  --model "$MODEL" \
  --host 0.0.0.0 --port "$PORT" \
  --embedding --pooling last \
  --ctx-size "$CTX" \
  --parallel "$PAR" \
  --cache-ram "$CRAM" \
  --metrics \
  --n-gpu-layers "$NGL" \
  --threads "$THREADS" \
  --alias qwen3-embedding-0.6b
