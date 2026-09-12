#!/bin/bash
# ComfyUI 启动包装（Python 3.13 / 自编 torch 2.11 / CUDA 12.2 Tegra / sm_87 / Flash Attention 开）
# 板上位置: /var/lib/llm/comfyui313/run.sh
#
# 与 py310 那版的三处关键区别：
#  1. LD_LIBRARY_PATH 必须前置 /var/lib/llm/cuda122/lib64 —— 板子自带的是 CUDA 11.4，
#     整套 12.2 运行时与 cuDNN 9.20 由我们分发。**libcuda.so.1 不在其中**，
#     那是驱动、永远用板上 Tegra 的那个（红线）。
#  2. 同一目录里还有新版 libstdc++.so.6.0.35：板上 focal 只有 6.0.28，
#     而 torch 2.11 是 gcc-12 编的，缺它直接 import 失败。
#  3. 删掉了 py310 时代的 NVRTC workaround（PYTORCH_JIT=0 / NVFUSER_DISABLE）——
#     那是 sbsa 版 CUDA 11.4 与 Tegra 库混用导致的（A-140），换成 Tegra 版 CUDA 后
#     NVRTC 运行时编译已实测正常，关掉 JIT 反而会白白牺牲 torch.compile 一类能力。
D=/var/lib/llm
NEW=$D/comfyui313
export HOME=$D/home
# 根分区只读，HuggingFace/Torch 的默认缓存路径 (~/.cache) 写不进去
export HF_HOME=$D/home/.cache/huggingface
export TORCH_HOME=$D/home/.cache/torch
export XDG_CACHE_HOME=$D/home/.cache
# git 装在 /var/lib/llm（根分区只读），ComfyUI-Manager 靠 PATH 找它
export PATH=$D/bin:$PATH
export GIT_PYTHON_GIT_EXECUTABLE=$D/bin/git
# IECU-TLS-CERT-FIX（A-136，★2026-08-17 修正）：自建 CPython 的 OpenSSL 默认证书路径
# /usr/lib/ssl/cert.pem 在板上不存在，不设这几个变量则 Manager 一切 https 都
# CERTIFICATE_VERIFY_FAILED。
# ⚠ 原来这里指向 /etc/ssl/certs/ca-certificates.crt —— 在这块板上实测**那个文件也不存在**：
#   厂商镜像根本没装 ca-certificates（dpkg 状态 `un`，/etc/ssl/certs 是空目录，
#   /usr/share/ca-certificates 也没有）。所以原来的"修复"其实是个空指针，
#   表现是 git 报 `Problem with the SSL CA cert`、pip/requests 报证书错。
#   解法：deploy/comfyui/fix-ca-certs.sh 从 node 内置的 145 个根证书生成
#   /var/lib/llm/ca-bundle.crt。这里优先用它，系统那份存在时才回落。
if [ -s "$D/ca-bundle.crt" ]; then
  CA=$D/ca-bundle.crt
elif [ -s /etc/ssl/certs/ca-certificates.crt ]; then
  CA=/etc/ssl/certs/ca-certificates.crt
else
  CA=""
  echo "WARN: 找不到 CA bundle，Manager 的 https 会失败。跑 deploy/comfyui/fix-ca-certs.sh" >&2
fi
if [ -n "$CA" ]; then
  export SSL_CERT_FILE=$CA
  export GIT_SSL_CAINFO=$CA
  export REQUESTS_CA_BUNDLE=$CA
  export CURL_CA_BUNDLE=$CA
fi
export SSL_CERT_DIR=/etc/ssl/certs
# IECU-cuda122: 分发的 CUDA 12.2 运行时 + cuDNN 9.20 + gcc 运行时
export LD_LIBRARY_PATH=$D/cuda122/lib64:${LD_LIBRARY_PATH:-}

# 挂载自检：cuda122 与 comfyui313 都是从 /opt/m0 bind 过来的（/opt 带 noexec，
# bind 后 remount 去掉）。挂载没生效时 .so 加载会失败且报错难懂，这里提前拦一次。
if [ ! -e "$D/cuda122/lib64/libcudart.so.12" ]; then
  echo "FATAL: /var/lib/llm/cuda122 未挂载或为空，先跑 $D/mount-stack313.sh" >&2
  exit 1
fi

cd $NEW
exec $NEW/venv/bin/python ComfyUI/main.py "$@"
