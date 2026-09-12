#!/bin/bash
# ★★ 交付判据：在【板上】（不是 chroot 里）用真正的运行时库集验 torch。
#
# 为什么必须单独有这个脚本（2026-08-16 的教训，A-154）：
#   `53-verify-torch211.sh` 在 chroot 里验，当时它的 LD_LIBRARY_PATH 里没有
#   自编 OpenBLAS 0.3.29，于是加载到 focal 自带的 0.3.8，
#   **CPU matmul 30 次全是 NaN**，验收报 SOME-FAILED。
#   而产物完全是好的——板上按 run.sh 的库集跑，同样的测试 **NaN 0/30、CPU-GPU 差 0.000e+00**。
#   **构建环境的验收结果不能代表产品**：两边的 OpenBLAS、libstdc++ 都不是同一个文件。
#   差一点就因为这个把一个好 wheel 判成坏的、去重编。
#
# 这个脚本设的 LD_LIBRARY_PATH 与 comfyui313/run.sh 完全一致，验的就是要交付的东西。
D=/var/lib/llm
export LD_LIBRARY_PATH=$D/cuda122/lib64:/usr/lib/aarch64-linux-gnu:/usr/lib
export HOME=$D/home
export XDG_CACHE_HOME=$D/home/.cache
mkdir -p "$D/home/.cache" 2>/dev/null

# ★ 2026-08-17 参数化。原来写死 chroot-focal/build/venv313 —— 那是**构建期**的 venv，
# 而按 baseline 解包部署的板子根本没有 chroot，脚本直接 "not found"。
# 上面注释说的"要在板上按生产配置验"，生产配置就是 comfyui313/venv。
# 优先级：环境变量 VENV > 生产 venv > 构建 chroot（在编译过的板子上行为不变）
if [ -n "${VENV:-}" ]; then
  VROOT=$VENV
elif [ -x "$D/comfyui313/venv/bin/python" ]; then
  VROOT=$D/comfyui313/venv
elif [ -x "$D/chroot-focal/build/venv313/bin/python" ]; then
  VROOT=$D/chroot-focal/build/venv313
else
  echo "★ 找不到可用的 venv（既无 comfyui313/venv 也无构建 chroot）" >&2
  exit 1
fi
PY=$VROOT/bin/python
echo "验证用的 venv: $VROOT"

echo "=== 0. 板上运行时目录里的 OpenBLAS ==="
ls -la "$D/cuda122/lib64/" | grep -iE 'openblas|gfortran|atomic|stdc' | sed 's/^/  /'
echo -n "  libopenblas.so.0 -> "; readlink -f "$D/cuda122/lib64/libopenblas.so.0" 2>&1

echo
echo "=== 1. libtorch_cpu.so 在板上解析到哪些库 ==="
TL=$VROOT/lib/python3.13/site-packages/torch
ldd "$TL/lib/libtorch_cpu.so" 2>/dev/null | grep -iE 'openblas|gfortran|stdc\+\+|not found' | sed 's/^/  /'
echo "  -- libtorch_cuda.so 的 libcuda 必须来自板上 Tegra 驱动 --"
ldd "$TL/lib/libtorch_cuda.so" 2>/dev/null | grep -iE 'libcuda\.so|not found' | sed 's/^/  /'

echo
echo "=== 2. 在板上真跑（这是产品配置下的判据） ==="
"$PY" - <<'PY'
import time, sys, torch
ok = {}
print("  torch", torch.__version__, "| cuda", torch.version.cuda, "| cudnn", torch.backends.cudnn.version())
print("  cuda available:", torch.cuda.is_available(), "|", torch.cuda.get_device_name(0))
ok['arch'] = torch.cuda.get_device_capability(0) == (8, 7)
ok['cuda_ver'] = (torch.version.cuda or '').startswith('12.2')

t0 = time.time()
a = torch.randn(2048, 2048, device='cuda', dtype=torch.float16); b = a @ a
torch.cuda.synchronize(); first = time.time() - t0
print(f"  ① 首次矩阵乘 {first:.2f}s")
ok['nojit'] = first < 8

from torch.nn.attention import sdpa_kernel, SDPBackend
import torch.nn.functional as F
q = torch.randn(1, 8, 1024, 64, device='cuda', dtype=torch.float16)
for name, be in (('fa', SDPBackend.FLASH_ATTENTION), ('mea', SDPBackend.EFFICIENT_ATTENTION)):
    try:
        with sdpa_kernel(be): F.scaled_dot_product_attention(q, q, q)
        torch.cuda.synchronize(); ok[name] = True
    except Exception as e:
        print(f"  {name} FAIL", str(e)[:120]); ok[name] = False
print("  ② flash attention:", "OK" if ok['fa'] else "FAIL", "| ③ mem-efficient:", "OK" if ok['mea'] else "FAIL")

def peak(be, n=4096):
    torch.cuda.empty_cache(); torch.cuda.reset_peak_memory_stats()
    x = torch.randn(1, 8, n, 64, device='cuda', dtype=torch.float16)
    with sdpa_kernel(be): F.scaled_dot_product_attention(x, x, x)
    torch.cuda.synchronize(); return torch.cuda.max_memory_allocated() / 2**20
m_math, m_fa = peak(SDPBackend.MATH), peak(SDPBackend.FLASH_ATTENTION)
print(f"  ④ 注意力峰值 math {m_math:.0f} MiB -> flash {m_fa:.0f} MiB (省 {100*(1-m_fa/m_math):.0f}%)")
ok['fa_gain'] = m_fa < m_math

try:
    from torch.nn.attention.flex_attention import flex_attention
    ok['flex'] = True
except Exception: ok['flex'] = False
try:
    F.scaled_dot_product_attention(
        torch.randn(1,8,128,64,device='cuda',dtype=torch.float16),
        torch.randn(1,2,128,64,device='cuda',dtype=torch.float16),
        torch.randn(1,2,128,64,device='cuda',dtype=torch.float16), enable_gqa=True)
    ok['gqa'] = True
except Exception: ok['gqa'] = False
try:
    from torch._library.infer_schema import infer_schema
    def f(x: torch.Tensor, y: list[int]) -> torch.Tensor: return x
    infer_schema(f, mutates_args=()); ok['pep585'] = True
except Exception: ok['pep585'] = False
print("  ⑤ flex", ok['flex'], "| gqa", ok['gqa'], "| pep585", ok['pep585'])

# ★ 这次是在板上的真实库集下测 OpenBLAS
x = torch.randn(512, 512)
d = (x @ x - (x.cuda() @ x.cuda()).cpu()).abs().max().item()
nan = sum(1 for _ in range(30) if torch.isnan(torch.randn(512,512) @ torch.randn(512,512)).any())
print(f"  ⑥a CPU/GPU matmul 最大差 {d:.3e}")
print(f"  ⑥b CPU matmul 30 次 NaN {nan} 次")
ok['num'] = d < 1e-3; ok['nan'] = nan == 0

conv = torch.nn.Conv2d(3, 16, 3, padding=1).cuda().half()
y = conv(torch.randn(1, 3, 256, 256, device='cuda', dtype=torch.float16))
print("  ⑥c cuDNN conv2d:", tuple(y.shape))
ok['cudnn'] = tuple(y.shape) == (1, 16, 256, 256)

try:
    g = torch.cuda.CUDAGraph(); inp = torch.randn(256, 256, device='cuda')
    with torch.cuda.graph(g): out = inp @ inp
    g.replay(); torch.cuda.synchronize(); ok['cudagraph'] = True
except Exception as e:
    print("  ⑦ CUDA Graph FAIL", str(e)[:120]); ok['cudagraph'] = False

print("\n  ====== 板上验收汇总 ======")
for k, v in ok.items(): print(f"    {k:10s} {'PASS' if v else 'FAIL'}")
print("  BOARD-ALL-PASS" if all(ok.values()) else "  BOARD-SOME-FAILED")
PY
echo VERIFY-ON-BOARD-DONE
