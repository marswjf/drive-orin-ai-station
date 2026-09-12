#!/bin/sh
# 直接实测 CUDA 驱动 API 版本 —— 整条版本链（torch 2.11 / CUDA 12.2）都是围着这个数反推的。
# 板上没有 nvidia-smi；/sys/module/nvidia/version 报的是**驱动包版本**（541.1.2），不是 CUDA API 版本。
# 判据：dlopen libcuda.so.1 → cuInit(0) → cuDriverGetVersion，期望 12010。
export LD_LIBRARY_PATH=/var/lib/llm/cuda122/lib64:/usr/lib/aarch64-linux-gnu:/usr/lib
PY=/var/lib/llm/comfyui313/venv/bin/python

echo "=== libcuda 来自哪里（必须是板子自己的驱动）==="
ldconfig -p | grep -E 'libcuda\.so' | sed 's/^/  /'

echo
echo "=== 实测 cuDriverGetVersion ==="
"$PY" - <<'PY'
import ctypes
try:
    lib = ctypes.CDLL("libcuda.so.1")
except OSError as e:
    print("  ★ 加载 libcuda.so.1 失败:", e); raise SystemExit(1)

rc = lib.cuInit(0)
print("  cuInit(0) =", rc, "(0 = 成功)")
v = ctypes.c_int()
rc2 = lib.cuDriverGetVersion(ctypes.byref(v))
print("  cuDriverGetVersion =", rc2, "-> 版本号", v.value)
major, minor = v.value // 1000, (v.value % 1000) // 10
print(f"  即 CUDA {major}.{minor}")
print("  ✓ 与基线一致（12010 / CUDA 12.1）" if v.value == 12010
      else f"  ★ 与基线的 12010 不同！整条版本链的前提需要重新推导")

# 顺带记录：驱动包版本与 CUDA API 版本是两回事
try:
    with open("/sys/module/nvidia/version") as f:
        print("  参照：驱动包版本 /sys/module/nvidia/version =", f.read().strip(), "（不是 CUDA API 版本）")
except Exception:
    pass
PY

echo
echo "=== 顺带：torch 看到的运行时/编译期版本对照 ==="
"$PY" - <<'PY'
import torch
print("  torch 编译期 CUDA:", torch.version.cuda)
print("  torch 运行时能用:", torch.cuda.is_available(), "|", torch.cuda.get_device_name(0))
print("  device capability:", torch.cuda.get_device_capability(0))
print("  说明：编译期 12.2 > 驱动 12.1 是成立的（CUDA 次版本向前兼容），")
print("        但 >=12030 会绑 multicast 驱动 API，Tegra 单卡不支持 —— 这就是 12.2 的上限来源")
PY
