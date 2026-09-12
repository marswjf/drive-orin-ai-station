#!/bin/bash
# llama-server 启动包装：从 /var/lib/llm/config.json 读参数，面板改配置后重启本服务即生效。
# 由 llm-server.service 拉起。板上没有 python3，用 node 解析 JSON。
set -u

LLM_ROOT=/var/lib/llm
CFG=$LLM_ROOT/config.json
NODE=$LLM_ROOT/bin/node

[ -f "$CFG" ] || { echo "FATAL: $CFG 不存在"; exit 78; }

# 逐项读配置，缺省值兜底
get() { "$NODE" -e "const c=require('$CFG');const v=c['$1'];process.stdout.write(v===undefined||v===null?'':String(v))" 2>/dev/null; }

# 后端可切换：cpu / cuda 两套二进制并存，出问题能立刻回退
BACKEND=$(get backend); BACKEND=${BACKEND:-cpu}
case "$BACKEND" in
  cuda) BINDIR=$LLM_ROOT/llama/bin-cuda ;;
  cpu)  BINDIR=$LLM_ROOT/llama/bin ;;
  *)    echo "FATAL: backend 只能是 cpu 或 cuda，当前='$BACKEND'"; exit 78 ;;
esac
BIN=$BINDIR/llama-server
if [ ! -x "$BIN" ]; then
  echo "WARN: $BIN 不存在，回退到 CPU 后端"
  BINDIR=$LLM_ROOT/llama/bin; BIN=$BINDIR/llama-server; BACKEND=cpu
fi
[ -x "$BIN" ] || { echo "FATAL: 两个后端都没有可用二进制（llama.cpp 尚未编译部署）"; exit 78; }
echo "后端: $BACKEND   二进制: $BIN"

MODEL=$(get model)
MMPROJ=$(get mmproj)
CTX=$(get ctx);      CTX=${CTX:-32768}
NGL=$(get ngl);      NGL=${NGL:-99}
PORT=$(get port);    PORT=${PORT:-8080}
THREADS=$(get threads); THREADS=${THREADS:-10}
CACHE_K=$(get cacheTypeK)
CACHE_V=$(get cacheTypeV)
FLASH=$(get flashAttn)
# prompt cache 池上限（MiB）。llama-server 默认 8192，对这块 28 GiB 的板子太大——
# 实测默认值下 RSS 每轮涨 123 MB 一直不停；设成 1024 后第 12 轮涨满 1.08 GiB 就完全平了。
# 这不是内存泄漏，是缓存池按上限正常填充。0 = 禁用（省内存但丢掉前缀复用加速）。
CACHE_RAM=$(get cacheRamMiB); CACHE_RAM=${CACHE_RAM:-1024}
PARALLEL=$(get parallel);     PARALLEL=${PARALLEL:-1}
# 思考控制。Qwen3.6 是思考模型：实测一句 "hi" 也要先输出 ~640 字 reasoning、
# 5.4 秒后才吐第一个正文字符。客户端不渲染 reasoning_content 就表现为长时间空白；
# max_tokens 给小了更会全部烧在思考上、content 返回空串——接 agent 时看着就像服务挂了。
#
# ⚠ `--reasoning-budget 0` 对这个模型无效【实测】：参数传进去了，照样输出 619 字思考。
#   有效的是走模板参数 enable_thinking=false（请求级 chat_template_kwargs 实测 1 秒出正文）。
#   chatTemplateKwargs 就是把它设成服务端默认，省得每个客户端都传。
REASONING_BUDGET=$(get reasoningBudget)
CHAT_TPL_KWARGS=$(get chatTemplateKwargs)
# 思考内容以什么形式返回给客户端：
#   （空）= auto，llama.cpp 自己选，对本模型即 reasoning_content 字段
#   deepseek        = 只放 message.reasoning_content
#   deepseek-legacy = content 里保留 <think> 标签，同时也填 reasoning_content（兼容性最好）
#   none            = 完全不解析，思考混在 content 里
# 客户端看不到思考链时，先把这个换成 deepseek-legacy 再说。
REASONING_FORMAT=$(get reasoningFormat)

# 批处理大小。--batch-size 是一次 llama_decode 的逻辑上限，--ubatch-size 是实际
# 送进 GPU 的物理批。默认 2048/512。调大能提 prefill 吞吐，代价是多占显存——
# 这块板子内存余量只有 2.4 GiB，改之前先在面板上看预估值。
BATCH=$(get batchSize)
UBATCH=$(get ubatchSize)
# 监听地址。默认 0.0.0.0 保持既有行为；设成 127.0.0.1 可把 8080 收进本机，
# 只留面板 9000 对外（面板反代走的就是 127.0.0.1，不受影响）。
# ⚠ 改成 127.0.0.1 前先确认没有别的机器在直连 8080，否则那些调用方会立刻断。
BIND_HOST=$(get bindHost); BIND_HOST=${BIND_HOST:-0.0.0.0}
# 客户端在模型下拉里看到的名字，也是 /v1/models 的 id。面板据此派生 -nothink 变体。
# ⚠ 必须在这里读，不能靠 extraArgs 追加一个 --alias 去覆盖：实测 llama.cpp 取的是
#   第一个出现的值，后面再给一次不生效（2026-08-17 切 Qwen3.8 时踩到，模型换了名字没换）。
# 缺省值保持 qwen3.6-35b-a3b，老预设不写这个字段时行为不变。
ALIAS=$(get alias); ALIAS=${ALIAS:-qwen3.6-35b-a3b}

[ -f "$MODEL" ] || { echo "FATAL: 模型不存在: '$MODEL'"; exit 78; }

ARGS=( --model "$MODEL"
       --host "$BIND_HOST" --port "$PORT"
       --ctx-size "$CTX"
       --threads "$THREADS"
       --parallel "$PARALLEL"
       --cache-ram "$CACHE_RAM"
       --alias "$ALIAS"
       --metrics )

[ -n "$BATCH" ] && ARGS+=( --batch-size "$BATCH" )
[ -n "$UBATCH" ] && ARGS+=( --ubatch-size "$UBATCH" )

# CPU 后端下 -ngl 无意义（还会刷警告）；只有 CUDA 后端才传
[ "$BACKEND" = "cuda" ] && ARGS+=( --n-gpu-layers "$NGL" )

# 多模态：给了 mmproj 才启用视觉塔
[ -n "$MMPROJ" ] && [ -f "$MMPROJ" ] && ARGS+=( --mmproj "$MMPROJ" )

# KV 量化需要 flash attention 才能量化 V；两者由配置控制，默认都不开，
# 等实测确认 -fa 在 qwen35moe 这种 linear+full 混合架构上可用再打开。
[ "$FLASH" = "on" ] && ARGS+=( --flash-attn on )
[ -n "$CACHE_K" ] && ARGS+=( --cache-type-k "$CACHE_K" )
[ -n "$CACHE_V" ] && ARGS+=( --cache-type-v "$CACHE_V" )

# 思考控制，只在配置里显式给了才传（不给就保持模型默认行为）
[ -n "$REASONING_BUDGET" ] && ARGS+=( --reasoning-budget "$REASONING_BUDGET" )
# 例：chatTemplateKwargs = {"enable_thinking":false} → 全局关思考
# ⚠ 这是全局默认值，会让客户端（Cherry Studio 等）自带的思考开关失效。
#   除非确实全部场景都不要思考，否则别设——让客户端自己决定。
[ -n "$CHAT_TPL_KWARGS" ] && ARGS+=( --chat-template-kwargs "$CHAT_TPL_KWARGS" )
[ -n "$REASONING_FORMAT" ] && ARGS+=( --reasoning-format "$REASONING_FORMAT" )

# extraArgs 是数组，逐个取出
EXTRA_N=$("$NODE" -e "const c=require('$CFG');process.stdout.write(String((c.extraArgs||[]).length))" 2>/dev/null)
EXTRA_N=${EXTRA_N:-0}
i=0
while [ "$i" -lt "$EXTRA_N" ]; do
  ARGS+=( "$("$NODE" -e "const c=require('$CFG');process.stdout.write(String(c.extraArgs[$i]))")" )
  i=$((i+1))
done

# ★ 第一项必须是二进制自己的目录：llama.cpp 拆成了 libllama-*-impl.so / libggml*.so，
#   交叉编译产物没有带 $ORIGIN 的 RPATH，不加这条会报 libllama-server-impl.so not found。
#   CUDA 版目录里还自带 libcudart.so.12 / libcublas.so.12（板上只有 11.4，必须用自带的）。
# DRIVE OS 把 NVIDIA 用户态库平铺在 /usr/lib（不是 Jetson 的 tegra/ 子目录），libcuda.so.1 在那
export LD_LIBRARY_PATH=$BINDIR:/usr/lib:${LD_LIBRARY_PATH:-}

# ⚠ 不要开 GGML_CUDA_ENABLE_UNIFIED_MEMORY=1。
#   它让 llama.cpp 改用 cudaMallocManaged。但 cudaprobe 实测本机 concurrentManaged=0
#   （Orin 不支持并发托管内存访问），开启后实测每轮请求泄漏约 130 MB 且不归还，
#   nvmap 客户端占用一路涨到 OOM。反正 Orin 本来就是统一内存，没有"回落"这回事。
#   由 config 的 cudaUnifiedMemory=true 显式打开（仅用于排障对照）。
[ "$(get cudaUnifiedMemory)" = "true" ] && export GGML_CUDA_ENABLE_UNIFIED_MEMORY=1

# CPU 亲和性：实测 isolcpus 隔离的 CPU5 不能参与推理——
#   taskset -c 0-11 (12 线程含 CPU5) → 1.67 t/s
#   taskset -c 0-4,6-11 (11 线程避开) → 10.54 t/s
# 所以默认显式绑核避开它。CUDA 后端下 CPU 只做采样，影响小但无害。
CPULIST=$(get cpuList)
echo "启动: $BIN ${ARGS[*]}"
[ -n "$CPULIST" ] && echo "CPU 亲和性: taskset -c $CPULIST"
free -h | head -2

if [ -n "$CPULIST" ] && command -v taskset >/dev/null; then
  exec taskset -c "$CPULIST" "$BIN" "${ARGS[@]}"
else
  exec "$BIN" "${ARGS[@]}"
fi
