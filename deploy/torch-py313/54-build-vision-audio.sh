#!/bin/bash
# 宿主上执行：编 torchvision 0.26.0 与 torchaudio 2.11.0（cp313 / CUDA 12.2 / sm_87）
#
# ⚠ 三处参数必须与 60-build-torch211.sh 完全一致，否则编出来的扩展与 torch 不兼容：
#   CUDA 12.2（不是 12.9/12.4）、gcc-12（CUDA 12.2 的 nvcc 只认 gcc<=12）、C++17。
#   为什么锁这三个 → 见 baseline/VERSIONS.txt 与本文档「版本天花板」的约束推导。
#
# 版本对应说明（2026-08-15 查证）：
#   torchvision 0.26.0 与 torch 2.11 配对（0.19←2.4, 0.20←2.5, 0.21←2.6 … 0.26←2.11）
#   torchaudio **2.11.0 是终版**：上游 README 明写 "TorchAudio 2.11 works with torch 2.11
#   and with every future torch release (2.12, 2.13, etc.)"，已进入维护阶段，
#   不再随 torch 版本升级 —— 所以别去找"更新版的 torchaudio"，没有那个东西。
#   它仍是 ComfyUI 的必需件（A-134），不能省。
# 两个包都必须自编：PyPI 官方 aarch64 wheel 的 C++ ABI 与我们的不一致（A-134）。
set -e
ROOT=/var/lib/llm/chroot-focal
LOG=/opt/m0/torchbuild/vision-audio-313.log
if ! mount | grep -q "$ROOT/proc"; then sh /var/lib/llm/chroot-focal-mount.sh >/dev/null; fi

cat > "$ROOT/root/va313-inner.sh" <<'INNER'
#!/bin/bash
export LC_ALL=C
export GIT_TERMINAL_PROMPT=0
CU=/usr/local/cuda-12.2
. /build/venv313/bin/activate
export CC=gcc-12 CXX=g++-12 CUDAHOSTCXX=g++-12
export CUDA_HOME=$CU CUDACXX=$CU/bin/nvcc
export PATH=/build/venv313/bin:$CU/bin:$PATH
# ⚠ /build/openblas-install/lib 必须排在 /usr/lib/aarch64-linux-gnu 前面：
#   focal 自带的是 OpenBLAS 0.3.8，CPU matmul **必出 NaN**（A-133，实测 30/30）。
#   漏了这一段不会报错，只会让所有 CPU 数值结果变成 nan。
export LD_LIBRARY_PATH=/build/openblas-install/lib:$CU/lib64:/usr/lib/aarch64-linux-gnu:/tegra-lib:/tegra-lib/aarch64-linux-gnu
export TORCH_CUDA_ARCH_LIST="8.7"
export FORCE_CUDA=1
export _GLIBCXX_USE_CXX11_ABI=1
# CUDA 12.2 的 cuda_fp16.hpp 在 C++20 下编不过（12.3 才修），必须锁 17
export CXXFLAGS="-std=c++17"
export NVCC_APPEND_FLAGS="-std=c++17"
MEMKB=$(awk '/MemAvailable/{print $2}' /proc/meminfo)
J=$(( MEMKB / (1024*1024*3) )); [ "$J" -gt 8 ] && J=8; [ "$J" -lt 1 ] && J=1
export MAX_JOBS=$J

echo "###### 0. 早停检查 ######"
V=$($CU/bin/nvcc --version | grep -oE 'release [0-9]+\.[0-9]+' | awk '{print $2}')
[ "$V" = "12.2" ] || { echo "FATAL nvcc=$V 不是 12.2"; exit 9; }
g++-12 --version | head -1 | sed 's/^/  /'
TV=$(python -c 'import torch;print(torch.__version__)')
case "$TV" in 2.11*) : ;; *) echo "FATAL torch=$TV 不是 2.11"; exit 9;; esac
echo "  MAX_JOBS=$MAX_JOBS  torch=$TV  nvcc=$V"

echo "###### 0.5 钉住 setuptools（torchvision 0.26 要 pkg_resources） ######"
# setuptools **81 起移除了 pkg_resources**，而 torchvision 0.26 的 setup.py 第 14 行
# 还在 `from pkg_resources import ...`，用 84.0.0 会直接 ModuleNotFoundError。
# torchaudio 不依赖它，所以只有 vision 会踩。→ 钉到 <81。
ST=$(pip show setuptools 2>/dev/null | awk '/^Version/{print $2}')
echo "  当前 setuptools=$ST"
python -c "import pkg_resources" 2>/dev/null || {
  echo "  pkg_resources 缺失，降到 setuptools<81"
  pip install -q "setuptools<81"
  echo "  现在 setuptools=$(pip show setuptools 2>/dev/null | awk '/^Version/{print $2}')"
  python -c "import pkg_resources; print('  pkg_resources OK')"
}

echo "###### A. torchvision 0.26.0 ######"
# 已有 wheel 就跳过：重跑这个脚本时不必白编一遍（改并发/修 vision 时会重跑）
if ls /build/out/torchvision-0.26.0*cp313*.whl >/dev/null 2>&1; then
  echo "  已有 wheel，跳过：$(ls /build/out/torchvision-0.26.0*cp313*.whl)"
else
cd /build
[ -d vision026/.git ] || git clone --depth 1 --branch v0.26.0 https://github.com/pytorch/vision vision026
cd vision026
git log -1 --oneline
export BUILD_VERSION=0.26.0
python setup.py bdist_wheel --dist-dir /build/out
echo "  torchvision rc=$?"
fi

echo "###### B. torchaudio 2.11.0 ######"
if ls /build/out/torchaudio-2.11.0*cp313*.whl >/dev/null 2>&1; then
  echo "  已有 wheel，跳过：$(ls /build/out/torchaudio-2.11.0*cp313*.whl)"
else
cd /build
[ -d audio211/.git ] || git clone --depth 1 --branch v2.11.0 https://github.com/pytorch/audio audio211
cd audio211
git log -1 --oneline
export BUILD_VERSION=2.11.0
export BUILD_SOX=0 BUILD_KALDI=0 BUILD_RNNT=0 USE_FFMPEG=0 USE_CUDA=1
python setup.py bdist_wheel --dist-dir /build/out
echo "  torchaudio rc=$?"
fi

echo "###### 产物 ######"
ls -l /build/out/*.whl | sed 's/^/  /'
echo VA313-DONE
INNER
chmod +x "$ROOT/root/va313-inner.sh"

rm -f "$LOG"
setsid nohup chroot "$ROOT" /bin/bash /root/va313-inner.sh > "$LOG" 2>&1 < /dev/null &
echo "launched pid=$!  log=$LOG"
sleep 3
head -3 "$LOG" 2>/dev/null
