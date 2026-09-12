"""板上算力基准：找 Z-Image 慢的真正原因。
问题：Z-Image 6B DiT 1024²/8步 = 106.4 秒（13.29 秒/步），
      按参数量估算理论约 1.6 秒/步，利用率只有 12%。
假设：bf16 在 sm_87 + torch 2.1 上没走 tensor core，或 SDPA 回退到 math 实现。
"""
import torch, time, sys

print("torch", torch.__version__, "| CUDA", torch.version.cuda,
      "| device", torch.cuda.get_device_name(0),
      "| capability", torch.cuda.get_device_capability(0))
print()


def bench(fn, warmup=3, iters=10):
    for _ in range(warmup):
        fn()
    torch.cuda.synchronize()
    t = time.time()
    for _ in range(iters):
        fn()
    torch.cuda.synchronize()
    return (time.time() - t) / iters


# ---------- 1. 矩阵乘：三种精度的真实吞吐 ----------
print("===== 1. 矩阵乘吞吐（N=4096）=====")
N = 4096
flops = 2 * N ** 3
for name, dt in [("fp16", torch.float16), ("bf16", torch.bfloat16),
                 ("fp32", torch.float32), ("tf32", torch.float32)]:
    try:
        if name == "tf32":
            torch.backends.cuda.matmul.allow_tf32 = True
        elif name == "fp32":
            torch.backends.cuda.matmul.allow_tf32 = False
        a = torch.randn(N, N, device="cuda", dtype=dt)
        b = torch.randn(N, N, device="cuda", dtype=dt)
        s = bench(lambda: torch.mm(a, b))
        print("  %-5s  %7.2f ms   %6.2f TFLOPS" % (name, s * 1000, flops / s / 1e12))
        del a, b
        torch.cuda.empty_cache()
    except Exception as e:
        print("  %-5s  失败: %s" % (name, str(e)[:90]))
torch.backends.cuda.matmul.allow_tf32 = False
print()

# ---------- 2. SDPA：注意力走哪条实现 ----------
print("===== 2. SDPA 后端（Z-Image 1024² 的注意力形状）=====")
# Lumina2/Z-Image 1024²: latent 128x128, patch 2 -> 4096 token
B, HEADS, SEQ, DIM = 1, 24, 4096, 64
for dtname, dt in [("bf16", torch.bfloat16), ("fp16", torch.float16)]:
    q = torch.randn(B, HEADS, SEQ, DIM, device="cuda", dtype=dt)
    k = torch.randn(B, HEADS, SEQ, DIM, device="cuda", dtype=dt)
    v = torch.randn(B, HEADS, SEQ, DIM, device="cuda", dtype=dt)
    for backend in ["default", "flash", "mem_efficient", "math"]:
        try:
            if backend == "default":
                s = bench(lambda: torch.nn.functional.scaled_dot_product_attention(q, k, v),
                          warmup=2, iters=5)
            else:
                kw = dict(enable_flash=False, enable_math=False, enable_mem_efficient=False)
                kw["enable_" + backend] = True
                with torch.backends.cuda.sdp_kernel(**kw):
                    s = bench(lambda: torch.nn.functional.scaled_dot_product_attention(q, k, v),
                              warmup=2, iters=5)
            print("  %-5s %-14s %8.2f ms" % (dtname, backend, s * 1000))
        except Exception as e:
            print("  %-5s %-14s 不可用: %s" % (dtname, backend, str(e).split("\n")[0][:80]))
    del q, k, v
    torch.cuda.empty_cache()
print()

# ---------- 3. 后端开关现状 ----------
print("===== 3. torch 后端开关 =====")
try:
    print("  flash_sdp_enabled       :", torch.backends.cuda.flash_sdp_enabled())
    print("  mem_efficient_sdp       :", torch.backends.cuda.mem_efficient_sdp_enabled())
    print("  math_sdp_enabled        :", torch.backends.cuda.math_sdp_enabled())
except Exception as e:
    print("  查询失败:", e)
print("  matmul.allow_tf32       :", torch.backends.cuda.matmul.allow_tf32)
print("  cudnn.allow_tf32        :", torch.backends.cudnn.allow_tf32)
print("  cudnn.benchmark         :", torch.backends.cudnn.benchmark)
print("  cudnn version           :", torch.backends.cudnn.version())
print()

# ---------- 4. 逐层 Linear：DiT 实际算子形状 ----------
print("===== 4. Linear 层吞吐（DiT 典型形状 4096 token × 2560 dim）=====")
TOK, DIMM = 4096, 2560
for dtname, dt in [("bf16", torch.bfloat16), ("fp16", torch.float16)]:
    x = torch.randn(TOK, DIMM, device="cuda", dtype=dt)
    lin = torch.nn.Linear(DIMM, DIMM * 4, device="cuda", dtype=dt)
    s = bench(lambda: lin(x))
    f = 2 * TOK * DIMM * DIMM * 4
    print("  %-5s  %7.2f ms   %6.2f TFLOPS" % (dtname, s * 1000, f / s / 1e12))
    del x, lin
    torch.cuda.empty_cache()
