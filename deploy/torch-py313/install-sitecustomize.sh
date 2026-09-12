#!/bin/bash
# 装 sitecustomize.py 到板上的 ComfyUI venv（幂等，可反复跑）。
#
# 作用：让 torch 先于 comfy_aimdo 拿到 glibc 的 static TLS 额度。
# 不装它，去掉 --highvram 之后 ComfyUI 起不来，报
#   ImportError: .../torch/lib/libc10.so: cannot allocate memory in static TLS block
# 完整推导见同目录 sitecustomize.py 的注释。
#
# 用法（在 PC 上）:
#   node .claude/skills/iecu/scripts/push.js deploy/torch-py313/sitecustomize.py \
#        /var/lib/llm/comfyui313/venv/lib/python3.13/site-packages/sitecustomize.py
#   node .claude/skills/iecu/scripts/exec.js --file deploy/torch-py313/install-sitecustomize.sh
# 或直接在板上跑本脚本（它会自己写文件，不依赖 push）。
set -u

SP=/var/lib/llm/comfyui313/venv/lib/python3.13/site-packages
TARGET=$SP/sitecustomize.py

if [ ! -d "$SP" ]; then
  echo "FATAL: 找不到 site-packages: $SP" >&2
  echo "  （生图栈实体在 /opt/update，要先跑 mount-stack313.sh 把它 bind 回来）" >&2
  exit 1
fi

cat > "$TARGET" <<'PY'
# IECU-TLS-FIX 2026-09-02  —— 正本在项目 deploy/torch-py313/sitecustomize.py
# 去掉 --highvram 后 enables_dynamic_vram() 返回 True，main.py 会调用
# comfy_aimdo.control.init() 启用 DynamicVRAM。aimdo 的 C 扩展用 initial-exec
# TLS 模型，吃掉 glibc 的 static TLS 余量；板子是 glibc 2.31，surplus 是编译期
# 固定值，且还没有 glibc.rtld.optional_static_tls 这个 tunable 可调（2.32 才有，
# 本板实测设了无效）。于是随后 import torch 时 libc10.so 申请 static TLS 失败。
# 让 torch 先加载即可绕开。sitecustomize 由解释器自动 import，早于 main.py，
# 所以不必改 ComfyUI 源码，升级 ComfyUI 也不会冲掉。
# 删掉本文件即可回滚，但必须同时把 --highvram 加回 comfyui.service，否则起不来。
try:
    import torch  # noqa: F401
except Exception:
    pass
PY

echo "已写入 $TARGET"

# 判据不是"文件存在"，而是"预加载真的生效且 torch 能 import"。
/var/lib/llm/comfyui313/venv/bin/python - <<'PY'
import sys
ok_sc = "sitecustomize" in sys.modules
try:
    import torch
    print(f"自检: sitecustomize 已加载={ok_sc}  torch={torch.__version__}  cuda={torch.cuda.is_available()}")
except Exception as e:
    print(f"自检失败: {e}")
    raise SystemExit(1)
PY
