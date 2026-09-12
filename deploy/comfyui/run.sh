#!/bin/bash
# ComfyUI 启动包装。板上唯一可用的 torch 是 NVIDIA JetPack 5 版
# （Python 3.8 / CUDA 11.4 / 原生 sm_87），因此路径与库都要手动指到位。
D=/var/lib/llm
PYR=$D/py/root
export LD_LIBRARY_PATH=$PYR/usr/lib/aarch64-linux-gnu:/usr/local/cuda-11.4/lib64
export PYTHONPATH=$PYR/usr/lib/python3.8/site-packages
export HOME=$D/home
# 根分区只读，HuggingFace/Torch 的默认缓存路径 (~/.cache) 写不进去
export HF_HOME=$D/home/.cache/huggingface
export TORCH_HOME=$D/home/.cache/torch
export XDG_CACHE_HOME=$D/home/.cache
# git 也装在 /var/lib/llm（根分区只读），ComfyUI-Manager 靠 PATH 找它
export PATH=$D/bin:$PATH
export GIT_PYTHON_GIT_EXECUTABLE=$D/bin/git
cd $D/comfyui
exec $PYR/usr/bin/python3.8 main.py "$@"
