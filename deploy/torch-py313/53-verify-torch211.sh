#!/bin/bash
# 宿主上执行：装 torch 2.11 wheel 到构建 venv 并做**带确切判据**的验收
#
# ⚠ 判据不是"开关为 True"，是"强制走该后端时不抛异常、且结果正确"。
#   这块板子上"编译成功 + is_available()=True + arch 报对"三条同时成立，
#   仍可能完全不能用（CUDA 12.9 编的报 500、12.4 编的报 46，都是初始化就炸）。
#   所以第 ① 项是真跑一个 kernel，第 ⑦ 项是真捕一次 CUDA Graph。
#
# ⚠⚠ 这个脚本在 **chroot 里**验，用的是构建环境的库。
#    **chroot 环境不等于产品配置**——板上跑 ComfyUI 用的是
#    `/var/lib/llm/cuda122/lib64` 那一套（run.sh 设的 LD_LIBRARY_PATH）。
#    两者的 OpenBLAS、libstdc++ 都可能不是同一个文件。
#    **最终判据以 `65-verify-on-board.sh` 为准**，那个脚本在板上按产品配置验。
#    本脚本的作用是"wheel 刚出炉时的快速自检"，不是交付判据。
set -e
ROOT=/var/lib/llm/chroot-focal
if ! mount | grep -q "$ROOT/proc"; then sh /var/lib/llm/chroot-focal-mount.sh >/dev/null; fi

cat > "$ROOT/root/verify211.sh" <<'INNER'
#!/bin/bash
set -e
export LC_ALL=C
CU=/usr/local/cuda-12.2
# ⚠ /build/openblas-install/lib 必须排在 /usr/lib/aarch64-linux-gnu 前面。
#   focal 自带 OpenBLAS 0.3.8，CPU matmul **必出 NaN**（A-133；2026-08-16 实测 30/30）。
#   漏了这一段，⑥a/⑥b 两项会 FAIL，而产物本身是好的——白白误判一次（A-154）。
export LD_LIBRARY_PATH=/build/openblas-install/lib:$CU/lib64:/usr/lib/aarch64-linux-gnu:/tegra-lib:/tegra-lib/aarch64-linux-gnu
. /build/venv313/bin/activate

WHL=$(ls -t /build/out/torch-2.11*.whl 2>/dev/null | head -1)
[ -z "$WHL" ] && { echo "ABORT: 没找到 torch 2.11 wheel"; exit 3; }
echo "###### 安装 $WHL ######"
pip install -q --force-reinstall --no-deps "$WHL"
pip install -q typing_extensions filelock jinja2 networkx sympy fsspec 2>/dev/null || true

python - <<'PY'
import time, sys, torch
ok = {}
print("torch", torch.__version__, "| cuda", torch.version.cuda, "| cudnn", torch.backends.cudnn.version())
print("python", sys.version.split()[0])
print("cuda available:", torch.cuda.is_available(), "| device:", torch.cuda.get_device_name(0))
cc = torch.cuda.get_device_capability(0)
print("compute capability:", cc, "(应为 (8, 7))")
ok['arch'] = cc == (8, 7)
ok['cuda_ver'] = (torch.version.cuda or '').startswith('12.2')
print("编译期 CUDA 版本:", torch.version.cuda, "(必须是 12.2；12.3+ 会绑 multicast 报错 46)")

# ① 无 PTX JIT + 驱动 API 绑定正确：首次 GPU 调用必须秒级且不抛异常
#    这一项同时替代"错误 500/46"的探测——那两个错误都在此处爆出来
t0 = time.time()
a = torch.randn(2048, 2048, device='cuda', dtype=torch.float16)
b = a @ a
torch.cuda.synchronize()
first = time.time() - t0
print(f"① 首次矩阵乘 {first:.2f}s  {'OK' if first < 5 else 'FAIL(疑似 PTX JIT)'}")
ok['nojit'] = first < 5

# ② flash attention：强制只用 FA 后端，不抛异常才算数
from torch.nn.attention import sdpa_kernel, SDPBackend
import torch.nn.functional as F
q = torch.randn(1, 8, 1024, 64, device='cuda', dtype=torch.float16)
try:
    with sdpa_kernel(SDPBackend.FLASH_ATTENTION):
        o = F.scaled_dot_product_attention(q, q, q)
    torch.cuda.synchronize()
    print("② flash attention 强制后端: OK", tuple(o.shape))
    ok['fa'] = True
except Exception as e:
    print("② flash attention 强制后端: FAIL ->", str(e)[:160])
    ok['fa'] = False

# ③ mem-efficient attention
try:
    with sdpa_kernel(SDPBackend.EFFICIENT_ATTENTION):
        o = F.scaled_dot_product_attention(q, q, q)
    torch.cuda.synchronize()
    print("③ mem-efficient attention: OK")
    ok['mea'] = True
except Exception as e:
    print("③ mem-efficient attention: FAIL ->", str(e)[:160])
    ok['mea'] = False

# ④ FA 的实际收益：注意力峰值内存应显著低于 math 后端
#    这一项是 ControlNet 双分支能否解锁的直接依据（A-138 是被 math 后端的
#    全量注意力矩阵撑爆的）
def peak(backend, n=4096):
    torch.cuda.empty_cache(); torch.cuda.reset_peak_memory_stats()
    x = torch.randn(1, 8, n, 64, device='cuda', dtype=torch.float16)
    with sdpa_kernel(backend):
        y = F.scaled_dot_product_attention(x, x, x)
    torch.cuda.synchronize()
    return torch.cuda.max_memory_allocated() / 2**20
try:
    m_math = peak(SDPBackend.MATH)
    m_fa = peak(SDPBackend.FLASH_ATTENTION)
    print(f"④ 4096 序列注意力峰值: math {m_math:.0f} MiB -> flash {m_fa:.0f} MiB  (省 {100*(1-m_fa/m_math):.0f}%)")
    ok['fa_gain'] = m_fa < m_math
except Exception as e:
    print("④ 峰值对比失败:", str(e)[:120]); ok['fa_gain'] = False

# ⑤ 三个 backport 补丁不再需要：2.11 原生具备
#    （py3.10 时代的 37-/40- 两个补丁到此作废，pip 重装 torch 不再需要重打）
try:
    from torch.nn.attention.flex_attention import flex_attention, create_block_mask
    print("⑤a flex_attention 原生可用: OK (diffusers 可解钉)")
    ok['flex'] = True
except Exception as e:
    print("⑤a flex_attention: FAIL", str(e)[:100]); ok['flex'] = False
try:
    o = F.scaled_dot_product_attention(
        torch.randn(1, 8, 128, 64, device='cuda', dtype=torch.float16),
        torch.randn(1, 2, 128, 64, device='cuda', dtype=torch.float16),
        torch.randn(1, 2, 128, 64, device='cuda', dtype=torch.float16), enable_gqa=True)
    print("⑤b SDPA enable_gqa 原生可用: OK (40- 补丁作废)")
    ok['gqa'] = True
except Exception as e:
    print("⑤b enable_gqa: FAIL", str(e)[:100]); ok['gqa'] = False
try:
    from torch._library.infer_schema import infer_schema
    def f(x: torch.Tensor, y: list[int]) -> torch.Tensor: return x
    infer_schema(f, mutates_args=())
    print("⑤c PEP585 infer_schema 原生可用: OK (37- 补丁作废)")
    ok['pep585'] = True
except Exception as e:
    print("⑤c infer_schema: FAIL", str(e)[:100]); ok['pep585'] = False

# ⑥ 数值正确性：CPU/GPU 一致 + cuDNN 卷积 + OpenBLAS 无 NaN（A-133）
x = torch.randn(512, 512)
d = (x @ x - (x.cuda() @ x.cuda()).cpu()).abs().max().item()
print(f"⑥a CPU/GPU matmul 最大差 {d:.2e} {'OK' if d < 1e-3 else 'FAIL'}")
ok['num'] = d < 1e-3
nan = sum(1 for _ in range(30) if torch.isnan(torch.randn(512,512) @ torch.randn(512,512)).any())
print(f"⑥b CPU matmul 30 次 NaN 出现 {nan} 次 {'OK' if nan==0 else 'FAIL(OpenBLAS 又坏了)'}")
ok['nan'] = nan == 0
conv = torch.nn.Conv2d(3, 16, 3, padding=1).cuda().half()
y = conv(torch.randn(1, 3, 256, 256, device='cuda', dtype=torch.float16))
print("⑥c cuDNN conv2d:", tuple(y.shape), "OK")
for dt in (torch.float16, torch.bfloat16):
    z = (torch.randn(256,256,device='cuda',dtype=dt) @ torch.randn(256,256,device='cuda',dtype=dt))
    assert not torch.isnan(z).any()
print("⑥d fp16 / bf16 matmul: OK")

# ⑦ CUDA Graph 捕获：driver_api.h 的 12040 分支若被误进，这里会炸
try:
    s = torch.cuda.Stream()
    g = torch.cuda.CUDAGraph()
    inp = torch.randn(256, 256, device='cuda')
    with torch.cuda.graph(g):
        out = inp @ inp
    g.replay(); torch.cuda.synchronize()
    print("⑦ CUDA Graph 捕获+回放: OK")
    ok['cudagraph'] = True
except Exception as e:
    print("⑦ CUDA Graph: FAIL ->", str(e)[:160]); ok['cudagraph'] = False

print("\n====== 验收汇总 ======")
for k, v in ok.items(): print(f"  {k:10s} {'PASS' if v else 'FAIL'}")
print("ALL-PASS" if all(ok.values()) else "SOME-FAILED")
PY
INNER
chmod +x "$ROOT/root/verify211.sh"
chroot "$ROOT" /bin/bash /root/verify211.sh
