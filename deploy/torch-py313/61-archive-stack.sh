#!/bin/bash
# 把整套新栈归档，目标是**能在另一块同型号板子上复现**，而不是只留几个 wheel。
# 归档落点：/opt/m0/torchbuild/archive-py313/，再用 pull.js 拉回 <你的备份根>\torch-py313\
#
# 归档内容分四类：
#   ① 自编产物（wheel）——最贵的东西，重编要 4 小时
#   ② 运行时库（CUDA 12.2 + cuDNN 9.20 + gcc-12 运行时 + OpenBLAS）——板上没有，必须带
#   ③ 解释器（CPython 3.13 整个 prefix）——自编的，带走省 2 分钟编译
#   ④ 复现资料（全部脚本 + 依赖清单 + 版本矩阵 + manifest.md5）
# ⚠ 绝不归档 libcuda.so.1 等驱动库——那是目标板自带的，带过去反而有害。
set -e
A=/opt/m0/torchbuild/archive-py313
OUT=/opt/m0/torchbuild/out
D=/var/lib/llm
rm -rf "$A"; mkdir -p "$A"/{wheels,runtime,python,scripts,docs}

echo "===== [1] 自编 wheel ====="
for w in torch-2.11 torchvision torchaudio; do
  f=$(ls -t "$OUT"/${w}*cp313*.whl 2>/dev/null | head -1)
  [ -n "$f" ] && { cp -a "$f" "$A/wheels/"; echo "  + $(basename "$f") $(stat -c %s "$f" | numfmt --to=iec)"; } \
               || echo "  !! 缺 $w 的 cp313 wheel"
done

echo "===== [2] 运行时库（含 CUDA/cuDNN/gcc-12/OpenBLAS，不含驱动） ====="
tar -C "$D/cuda122" -czf "$A/runtime/cuda-runtime-libs.tar.gz" lib64
echo "  + cuda-runtime-libs.tar.gz $(stat -c %s "$A/runtime/cuda-runtime-libs.tar.gz" | numfmt --to=iec)"
echo "  内含（校验绝无驱动库）:"
tar -tzf "$A/runtime/cuda-runtime-libs.tar.gz" | grep -cE 'libcuda\.so|libnvrm|libnvos' | sed 's/^/    驱动库个数(必须为0): /'
tar -tzf "$A/runtime/cuda-runtime-libs.tar.gz" | wc -l | sed 's/^/    文件数: /'

echo "===== [3] CPython 3.13 ====="
tar -C "$D" -czf "$A/python/py313.tar.gz" py313
echo "  + py313.tar.gz $(stat -c %s "$A/python/py313.tar.gz" | numfmt --to=iec)"

echo "===== [4] ComfyUI 运行环境（venv + 节点包，不含模型） ====="
if [ -d "$D/comfyui313" ]; then
  tar -C "$D" --exclude='comfyui313/ComfyUI/output/*' --exclude='comfyui313/ComfyUI/input/*' \
      --exclude='*/__pycache__' -czf "$A/runtime/comfyui313-env.tar.gz" comfyui313 2>/dev/null || true
  [ -f "$A/runtime/comfyui313-env.tar.gz" ] && echo "  + comfyui313-env.tar.gz $(stat -c %s "$A/runtime/comfyui313-env.tar.gz" | numfmt --to=iec)"
fi

echo "===== [5] 复现资料 ====="
cp -a "$D/build313"/*.sh "$A/scripts/" 2>/dev/null || true
cp -a "$D/mount-stack313.sh" "$A/scripts/" 2>/dev/null || true
ls "$A/scripts" | sed 's/^/  + /'
cp -a "$D/build313"/*.service* "$A/scripts/" 2>/dev/null || true
# 文档跟着走：只有 wheel 没有推导链，下一个人照样会重蹈覆辙
cp -a "$D/build313"/*.md "$A/docs/" 2>/dev/null || true
ls "$A/docs" | sed 's/^/  + /'

# pip 依赖清单：另一块板子照这个装才对得上
"$D/comfyui313/venv/bin/pip" freeze > "$A/docs/pip-freeze.txt" 2>/dev/null || true
[ -s "$A/docs/pip-freeze.txt" ] && echo "  + pip-freeze.txt ($(wc -l < "$A/docs/pip-freeze.txt") 个包)"

# ⚠ 先把环境值算进变量，**不要在 heredoc 里嵌 awk 的 $字段**：
#   不带引号的 heredoc 会先处理反斜杠，`\$3` 传到 awk 时可能还带着反斜杠，
#   awk 报 `unexpected character '\'` 而字段静默变空（2026-08-16 踩过，
#   DRIVE OS 与 glibc 两行都空了）。算成变量再引用，一层展开，稳。
BOARD=$(cat /proc/device-tree/model 2>/dev/null | tr -d '\0')
DRIVEOS=$(dpkg -l 2>/dev/null | grep nv-driveos-linux | head -1 | tr -s ' ' | cut -d' ' -f3)
NVDRV=$(cat /sys/module/nvidia/version 2>/dev/null || echo unknown)
GLIBC=$(ldd --version 2>/dev/null | head -1 | rev | cut -d' ' -f1 | rev)
KERNEL=$(uname -r)

# 版本矩阵：一眼看清这套栈是什么
cat > "$A/docs/VERSIONS.txt" <<EOF
IECU 3.1 生图栈（2026-08-15 构建）
========================================
Python        $("$D/py313/bin/python3.13" -V 2>&1 | awk '{print $2}')
PyTorch       $(ls "$A/wheels"/torch-*.whl 2>/dev/null | head -1 | sed 's/.*torch-\([0-9.]*\)-.*/\1/')
torchvision   $(ls "$A/wheels"/torchvision-*.whl 2>/dev/null | head -1 | sed 's/.*torchvision-\([0-9.]*\)-.*/\1/')
torchaudio    $(ls "$A/wheels"/torchaudio-*.whl 2>/dev/null | head -1 | sed 's/.*torchaudio-\([0-9.]*\)-.*/\1/')
CUDA          12.2  (Tegra/arm64 变体，来源 JetPack 6.0 / L4T r36.2)
cuDNN         9.20.0
gcc           12.5  (构建期；ubuntu-toolchain-r/test PPA for focal)
OpenBLAS      0.3.29 (自编，修 0.3.8 的 sgemm NaN)
目标架构      sm_87 (不带 +PTX)
Flash Attn    开启 (USE_FLASH_ATTENTION=1 / USE_MEM_EFF_ATTENTION=1)

为什么是这个组合（缺一不可，详见 NOTES.md §二）
  驱动 12.1 固定 → CUDA 必须 <12030（否则绑 multicast，Tegra 不支持）
  Tegra 变体低于 12.4 的只有 12.2
  CUDA 12.2 的 fp16 头文件在 C++20 下编不过 → torch 必须用 C++17
  torch 2.12 起改用 C++20 → 只能 2.11

构建这套东西时源板子的环境（目标板必须一致，否则整个组合的前提就不成立）
  板号            $BOARD
  DRIVE OS        $DRIVEOS
  NVIDIA 驱动版本 $NVDRV
  ★ CUDA 驱动 API 12.1 (12010)  ← 这才是锁死整条版本链的那个数，
                                  上面那个 $NVDRV 是驱动包版本号，两回事，别混
  glibc           $GLIBC
  内核            $KERNEL
EOF
echo "  + VERSIONS.txt"

echo "===== [6] 校验清单 ====="
cd "$A" && find . -type f ! -name manifest.md5 -exec md5sum {} \; | sort -k2 > manifest.md5
wc -l < manifest.md5 | sed 's/^/  条目数: /'
du -sh "$A" | sed 's/^/  归档总大小: /'
echo
echo "拉回本地：node pull.js /opt/m0/torchbuild/archive-py313 <你的备份目录>\\torch-py313"
echo "核对：md5sum -c manifest.md5"
echo ARCHIVE-DONE
