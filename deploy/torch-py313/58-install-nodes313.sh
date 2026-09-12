#!/bin/bash
# 58-install-nodes313.sh —— 给 py3.13 新环境装第三方节点包（可重复执行）
#
# 用法: bash 58-install-nodes313.sh [<git-url> ...]   不给参数则装 DEFAULT
#
# ⚠ 这个脚本存在的唯一理由是防住已经踩过的坑（沿用 42- 的逻辑）：
#   第三方 requirements 的间接依赖（kornia / spandrel / timm / diffusers 之类）会从
#   PyPI 拉官方 torch，把我们自编的 sm_87 版顶掉，连带几个 GB 的 nvidia-* 包。所以：
#     ① PIP_CONSTRAINT 钉死 torch/torchvision/torchaudio/numpy
#     ② requirements 里 torch 系的行先过滤
#     ③ 每装一个就回读版本，被顶立刻停手
#   ComfyUI-Manager 界面里的 install 走的也是 pip，同样会中招——宁可用这个脚本。
#
# ⚠ 装完必须查启动日志的 IMPORT FAILED 与启动耗时（陷阱 54）：
#   "custom_nodes 里有文件夹" ≠ "节点注册成功"。
set -u
C=/var/lib/llm/comfyui313
CN=$C/ComfyUI/custom_nodes
PIP=$C/venv/bin/pip
PY=$C/venv/bin/python
GIT=/var/lib/llm/bin/git
export GIT_SSL_CAINFO=/etc/ssl/certs/ca-certificates.crt
export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
export REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
export PATH=/var/lib/llm/bin:$PATH
export HOME=/var/lib/llm/home
export LD_LIBRARY_PATH=/var/lib/llm/cuda122/lib64:${LD_LIBRARY_PATH:-}

# 这份清单是 2026-08-16 从**现役 comfyui310/custom_nodes 实际内容**抄来的，
# 不是凭工作流猜的——迁移的目标是与现役环境等价，少一个包就可能有工作流打不开。
# ComfyUI-GGUF 排第一且是必需件：板上所有现役工作流的 UNet 与文本编码器都是 GGUF。
DEFAULT="https://github.com/city96/ComfyUI-GGUF
https://github.com/ltdrdata/ComfyUI-Manager
https://github.com/kijai/ComfyUI-KJNodes
https://github.com/crystian/ComfyUI-Crystools
https://github.com/AIGODLIKE/AIGODLIKE-COMFYUI-TRANSLATION
https://github.com/rgthree/rgthree-comfy
https://github.com/Suzie1/ComfyUI_Comfyroll_CustomNodes
https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler
https://github.com/yiw39711-afk/comfuinoda-Navyblue"

URLS="${*:-$DEFAULT}"
mkdir -p "$CN"

echo "###### 0.0 与现役环境的版本差异（先看清楚再装） ######"
# 现役 comfyui310 的关键版本（2026-08-16 实测），新环境装完要对照：
#   gguf 0.19.0 / numpy 1.26.4 / transformers 4.57.6 / diffusers 0.35.1 /
#   kornia 0.8.2 / spandrel 0.4.2 / safetensors 0.8.0 / pillow 12.3.0
# ★ diffusers 现役被钉在 0.35.1，原因是 A-141：0.39+ 无条件 import
#   torch.nn.attention.flex_attention，而 torch 2.4.1 没有。
#   **torch 2.11 原生就有 flex_attention（已实测 PASS），这个钉子可以拔掉。**
#   但别顺手就升——先让工作流跑通，再单独验 diffusers 升级。
OLD=/var/lib/llm/comfyui310/venv/bin/pip
if [ -x "$OLD" ]; then
  echo "  包名          现役(py3.10)    新环境(py3.13)"
  for p in gguf numpy transformers diffusers kornia spandrel safetensors pillow; do
    o=$("$OLD" show "$p" 2>/dev/null | awk '/^Version/{print $2}')
    n=$($PIP show "$p" 2>/dev/null | awk '/^Version/{print $2}')
    printf "  %-14s %-15s %s\n" "$p" "${o:-未装}" "${n:-未装}"
  done
fi

echo "###### 0. 装之前的基线 ######"
$PY - <<'PY'
import torch, numpy, torchvision, torchaudio
print('  torch      ', torch.__version__)
print('  torchvision', torchvision.__version__)
print('  torchaudio ', torchaudio.__version__)
print('  numpy      ', numpy.__version__)
PY
# ⚠ 四个版本号全部从**实际装上的**读，不要写死。
#   写死过一次（torchvision 钉在 0.28.0，而实际配 torch 2.11 的是 0.26.0），
#   约束文件和现实对不上时 pip 会去 PyPI 找那个不存在的组合，把自编版顶掉。
BASE_TORCH=$($PY -c "import torch;print(torch.__version__)")
BASE_TV=$($PY -c "import torchvision;print(torchvision.__version__)")
BASE_TA=$($PY -c "import torchaudio;print(torchaudio.__version__)")
NUMPY_NOW=$($PY -c "import numpy;print(numpy.__version__)")

cat > /tmp/node-constraints313.txt <<EOF
torch==$BASE_TORCH
torchvision==$BASE_TV
torchaudio==$BASE_TA
numpy==$NUMPY_NOW
EOF
export PIP_CONSTRAINT=/tmp/node-constraints313.txt
echo "  约束文件:"; sed 's/^/    /' /tmp/node-constraints313.txt

for U in $URLS; do
  NAME=$(basename "$U" .git)
  D="$CN/$NAME"
  echo
  echo "=============================================================="
  echo "###### $NAME ######"
  if [ -d "$D/.git" ]; then
    echo "  已存在，拉取更新"
    (cd "$D" && $GIT pull --ff-only 2>&1 | tail -3)
  else
    $GIT clone --depth 1 "$U" "$D" 2>&1 | tail -3 || { echo "  ★clone 失败，跳过"; continue; }
  fi

  if [ -f "$D/requirements.txt" ]; then
    grep -viE '^\s*(torch|torchvision|torchaudio|nvidia-)([=<>~!].*)?\s*$' "$D/requirements.txt" > /tmp/req-node313.txt || true
    DROP=$(grep -ciE '^\s*(torch|torchvision|torchaudio|nvidia-)([=<>~!].*)?\s*$' "$D/requirements.txt" || true)
    echo "  过滤掉 torch 系 $DROP 行，开始安装"
    $PIP install -q -r /tmp/req-node313.txt 2>&1 | tail -8
  else
    echo "  无 requirements.txt（零依赖包）"
  fi

  NOW=$($PY -c "import torch;print(torch.__version__)" 2>/dev/null || echo "IMPORT-FAILED")
  if [ "$NOW" != "$BASE_TORCH" ]; then
    echo "  ★★★ 警报：torch 从 $BASE_TORCH 变成 $NOW —— 立刻停手"
    exit 1
  fi
  echo "  torch 仍是 $NOW ✓"
done

echo
echo "###### 收尾检查 ######"
$PY - <<'PY'
import torch, numpy, torchvision, torchaudio
print('  torch      ', torch.__version__)
print('  torchvision', torchvision.__version__)
print('  torchaudio ', torchaudio.__version__)
print('  numpy      ', numpy.__version__)
print('  cuda 可用  ', torch.cuda.is_available())
PY
echo "  custom_nodes 现有:"
ls -1 "$CN" 2>/dev/null | grep -v __pycache__ | sed 's/^/    /'
df -h /var /opt/m0 | tail -2 | sed 's/^/  /'
echo
echo "###### 下一步：重启服务后必须做三件事 ######"
echo "  1. journalctl -u comfyui | grep -c 'IMPORT FAILED'   → 必须是 0"
echo "  2. 看启动耗时（陷阱 54：某个包的联网依赖能让启动从 31s 变 408s）"
echo "  3. 查 /object_info 里节点类型真的注册了（L1 验证，见 comfyui-import skill）"
