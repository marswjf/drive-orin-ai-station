#!/bin/bash
# 宿主上执行：构建 **PyTorch 2.11.0**（cp313 / CUDA 12.2 Tegra / sm_87 / Flash Attention 开）
# 日志: /opt/m0/torchbuild/build211.log   产物: /opt/m0/torchbuild/out/
#
# ══ 为什么是 2.11 而不是 2.13：这是四条硬约束夹出来的唯一解 ══════════════════
# 2026-08-15 把 2.13 编出来了（rc=0，wheel 190 MB），但**一碰 GPU 就废**。
# 逐层排查后确认，约束是这样咬合的：
#
#   ① 板上驱动固定 12.1（DRIVE OS 的一部分，改不了）
#      → torch 的 c10/cuda/driver_api.h 按**编译时** CUDA 版本决定查哪些驱动函数：
#          CUDA_VERSION >= 12080 → green context 组（驱动没有 → cudaErrorSymbolNotFound 500）
#          CUDA_VERSION >= 12030 → multicast 组（多 GPU 特性，Tegra 单卡不支持
#                                   → cudaErrorDevicesUnavailable 46）
#        所以 **CUDA 必须 < 12030**，即 12.0 / 12.1 / 12.2
#   ② Tegra(arm64) 变体的 CUDA，developer 源最低 12.4，只有 JetPack 6.0 (L4T r36.2)
#      提供 12.2 → **CUDA 只能是 12.2**
#   ③ CUDA 12.2 的 cuda_fp16.hpp / cuda_bf16.hpp **在 C++20 下编不过**
#      （__half → unsigned short 无转换函数，CUDA 12.3 才修）
#      → torch 必须用 **C++17**
#   ④ torch 的 CMAKE_CXX_STANDARD：**2.12 起是 20，2.11 及以下是 17**
#      → torch 只能是 **2.11.0**（2.11 也是 gcc 9.3 门槛的最后一版，但我们用 gcc-12）
#
# 结论：**torch 2.11.0 + CUDA 12.2 是这块板子能达到的最高组合**，不是将就。
# 2.11 相对现役 2.4.1 高七个 minor，flash_attention / flex_attention /
# PEP585 infer_schema / SDPA enable_gqa 全部原生具备，三个 backport 补丁照样作废。
#
# ── 其余参数沿用 2.13 那轮验证过的 ─────────────────────────────────────────
#   gcc-12.5（CUDA 12.2 要求 gcc <= 12；torch 2.11 要求 >= 9.3）
#   BUILD_IGNORE_SVE_UNAVAILABLE=1（A78AE 无 SVE，上游默认视为致命错误）
#   USE_KLEIDIAI=0（要 ARMv8.6 的 i8mm）
#   TORCH_CUDA_ARCH_LIST="8.7" 不带 +PTX（带了驱动 JIT 不了）
#   并发按 5 GB/job、上限 4（cutlass 段 cicc 单进程峰值 5.7 GB，7 并发实测 OOM）
set -e
ROOT=/var/lib/llm/chroot-focal
LOG=/opt/m0/torchbuild/build211.log
VER=v2.11.0
SRC=/build/pytorch211
CUDA_HOME_VER=12.2
# 并发覆盖：JOBS 和 JOBS_OVERRIDE 两个名字都认。
# ⚠ 之前只认 JOBS，传 JOBS_OVERRIDE=8 会被**静默忽略**、回落到内存公式（正好也是 4），
#   现象是"看起来生效了其实没有"。下面会把实际取值打进日志，别再靠猜。
JOBS_OVERRIDE=${JOBS:-${JOBS_OVERRIDE:-}}
if [ -n "$JOBS_OVERRIDE" ]; then
  echo "=== 并发被显式指定为 $JOBS_OVERRIDE ==="
else
  echo "=== 并发未指定，按内存公式算（5GB/job，上限 4）==="
fi

if ! mount | grep -q "$ROOT/proc"; then sh /var/lib/llm/chroot-focal-mount.sh >/dev/null; fi
echo "=== 开工前空间 ==="
df -h /opt/m0 /var | sed 's/^/  /'

cat > "$ROOT/root/t211-inner.sh" <<INNER
#!/bin/bash
set -e
export LC_ALL=C
export GIT_TERMINAL_PROMPT=0
CU=/usr/local/cuda-12.2
SRC=$SRC
echo "###### \$(date -Is) PyTorch 2.11.0 构建开始 ######"
df -h /opt/m0 2>/dev/null | tail -1

echo "###### 1. 早停检查 ######"
NVCC_V=\$(\$CU/bin/nvcc --version | grep -oE 'release [0-9]+\.[0-9]+' | awk '{print \$2}')
echo "  nvcc=\$NVCC_V  g++-12=\$(g++-12 -dumpfullversion)"
[ "\$NVCC_V" = "12.2" ] || { echo "  ABORT: CUDA 必须是 12.2（<12030 才不绑 multicast）"; exit 6; }
[ -x /var/lib/llm/py313/bin/python3.13 ] || { echo "  ABORT: py313 未就绪"; exit 3; }
echo "  -- cuBLAS 预检（Tegra 版判据）："
cat > /tmp/pre.cu <<'CU'
#include <cstdio>
#include <cublas_v2.h>
int main(){ cublasHandle_t h; cublasStatus_t s=cublasCreate(&h);
  printf("cublasCreate rc=%d %s\n", s, s?"FAIL":"OK"); return s?1:0; }
CU
\$CU/bin/nvcc -gencode arch=compute_87,code=sm_87 -o /tmp/pre /tmp/pre.cu -lcublas --cudart shared
LD_LIBRARY_PATH=\$CU/lib64:/tegra-lib:/tegra-lib/aarch64-linux-gnu /tmp/pre || { echo "  ABORT-CUBLAS"; exit 4; }
echo "  -- C++17 下的 fp16/bf16 冒烟（2.11 用 C++17，CUDA 12.2 在这个标准下没问题）："
cat > /tmp/c17.cu <<'CU'
#include <cstdio>
#include <cuda_fp16.h>
#include <cuda_bf16.h>
__global__ void k(__half* h, __nv_bfloat16* b){ h[0]=__hmax(h[0],h[1]); b[0]=__hmax(b[0],b[1]); }
int main(){ __half* h; __nv_bfloat16* b; cudaMalloc(&h,16); cudaMalloc(&b,16);
  k<<<1,1>>>(h,b); printf("c++17 fp16/bf16 rc=%d\n", cudaDeviceSynchronize()); return 0; }
CU
\$CU/bin/nvcc -ccbin=/usr/bin/g++-12 -std=c++17 -gencode arch=compute_87,code=sm_87 \
  --cudart shared -o /tmp/c17 /tmp/c17.cu 2>&1 | head -4
[ -x /tmp/c17 ] || { echo "  ABORT-CXX17-FP16"; exit 5; }
LD_LIBRARY_PATH=\$CU/lib64:/tegra-lib:/tegra-lib/aarch64-linux-gnu /tmp/c17

echo "###### 2. clone v2.11.0 ######"
cd /build
if [ ! -d "\$SRC/.git" ]; then
  git clone --depth 1 --branch $VER --recurse-submodules --shallow-submodules --jobs 3 \
      https://github.com/pytorch/pytorch "\$SRC" || true
fi
cd "\$SRC"
git log -1 --oneline | sed 's/^/  /'
git submodule update --init --recursive --force --depth 1 --jobs 3 >/dev/null 2>&1 || \
  git submodule update --init --recursive --force --depth 1 --jobs 1 >/dev/null 2>&1 || true

echo "###### 2.5 打补丁：Loops.cuh 的 std::apply ######"
# CUDA 12.2 + gcc-12 下，返回 thrust::tuple 的多输出 kernel 会在
# Loops.cuh 的 std::apply 上报 "calling a __host__ function from a __device__ function"。
# 换成 PyTorch 自己的 __host__ __device__ 版本。幂等，详见脚本头部。
# ⚠ 不打这个补丁，构建会在 [2549/5564] 附近失败，白跑两小时。
bash /root/63-patch-loops-apply.sh "\$SRC" || { echo "  ABORT: 补丁失败"; exit 7; }

echo "###### 3. 复核关键门槛（源码里的真实值） ######"
grep -n 'set(CMAKE_CXX_STANDARD' CMakeLists.txt | head -1 | sed 's/^/  /'
grep -n -A1 'requires CUDA' cmake/public/cuda.cmake | head -2 | sed 's/^/  /'
echo "  -- driver_api.h 的版本分支（CUDA 12.2 = 12020，应当一个都不进）:"
grep -nE '#if.*CUDA_VERSION >= 12|#elif.*CUDA_VERSION >= 12' c10/cuda/driver_api.h | sed 's/^/    /'

echo "###### 4. 构建环境 ######"
. /build/venv313/bin/activate
export CC=gcc-12 CXX=g++-12 CUDAHOSTCXX=g++-12
export CUDA_HOME=\$CU CUDA_TOOLKIT_ROOT_DIR=\$CU CUDACXX=\$CU/bin/nvcc
export PATH=/build/venv313/bin:\$CU/bin:\$PATH
export LD_LIBRARY_PATH=\$CU/lib64:/usr/lib/aarch64-linux-gnu:/tegra-lib:/tegra-lib/aarch64-linux-gnu
export CUDNN_INCLUDE_DIR=/usr/include
export CUDNN_LIB_DIR=/usr/lib/aarch64-linux-gnu
export CUDNN_LIBRARY=/usr/lib/aarch64-linux-gnu/libcudnn.so
export CMAKE_PREFIX_PATH=/build/venv313:/build/openblas-install
export OpenBLAS_HOME=/build/openblas-install
export TORCH_CUDA_ARCH_LIST="8.7"
export USE_CUDA=1 USE_CUDNN=1
export USE_FLASH_ATTENTION=1 USE_MEM_EFF_ATTENTION=1
export USE_NCCL=0 USE_DISTRIBUTED=0
export USE_QNNPACK=0 USE_PYTORCH_QNNPACK=0 USE_XNNPACK=1
export USE_KINETO=0 USE_NUMA=0 USE_MKL=0 BLAS=OpenBLAS
export USE_CUSPARSELT=0 USE_CUDSS=0 USE_CUFILE=0 USE_NVSHMEM=0
export BUILD_IGNORE_SVE_UNAVAILABLE=1
export USE_KLEIDIAI=0
export BUILD_TEST=0
export PYTORCH_BUILD_VERSION=2.11.0
export PYTORCH_BUILD_NUMBER=1
export _GLIBCXX_USE_CXX11_ABI=1
MEMKB=\$(awk '/MemAvailable/{print \$2}' /proc/meminfo)
if [ -n "$JOBS_OVERRIDE" ]; then
  J=$JOBS_OVERRIDE
else
  J=\$(( MEMKB / (1024*1024*5) )); [ "\$J" -gt 4 ] && J=4; [ "\$J" -lt 1 ] && J=1
fi
export MAX_JOBS=\$J
echo "MemAvailable=\$((MEMKB/1024)) MiB  nproc=\$(nproc)  MAX_JOBS=\$MAX_JOBS"
python -VV; cmake --version | head -1; \$CU/bin/nvcc --version | tail -2

echo "###### 5. 编 wheel ######"
if [ -d "\$SRC/build" ] && [ ! -f "\$SRC/build/build.ninja" ]; then rm -rf "\$SRC/build"; fi
mkdir -p /build/out
# ⚠ 这里必须临时关掉 set -e。否则构建一失败脚本就直接退出，
#   BUILD211-END 标记不会打印，外面守望的人只看到"进程消失"，
#   无法区分"编译报错"和"被 OOM killer 杀掉"——这两种的处置完全不同。
#   之后不再打开 set -e：失败时后面几行本来就会失败，让它走到 exit \$RC。
set +e
python setup.py bdist_wheel --dist-dir /build/out
RC=\$?
echo "###### \$(date -Is) BUILD211-END rc=\$RC ######"
ls -l /build/out/*.whl | sed 's/^/  /'
df -h /opt/m0 2>/dev/null | tail -1
exit \$RC
INNER
chmod +x "$ROOT/root/t211-inner.sh"
# 补丁脚本要在 chroot 里跑，先送进去
cp -a /var/lib/llm/build313/63-patch-loops-apply.sh "$ROOT/root/63-patch-loops-apply.sh"
chmod +x "$ROOT/root/63-patch-loops-apply.sh"

if pgrep -f 't211-inner' >/dev/null 2>&1; then echo "已在运行"; exit 0; fi
rm -f "$LOG"
setsid nohup chroot "$ROOT" /bin/bash /root/t211-inner.sh > "$LOG" 2>&1 < /dev/null &
echo "launched pid=$!  log=$LOG"
sleep 5
head -14 "$LOG" 2>/dev/null
