"""INT8 峰值追查 —— cublasGemmEx 只到 45 TOPS，问题出在哪

背景：v3 实测 INT8 (TN) 45.01 TOPS、FP16 39.37 TFLOPS，比值仅 1.14x。
若两者都跑满 tensor core，INT8 的计算密度应约为 FP16 的 2 倍。
FP16 对理论 dense 峰值的达成率明显高于 INT8，说明瓶颈不在 GPU 频率，
而在 INT8 内核是否真正跑满 IMMA。

本脚本测三条路径，用于区分「布局问题」与「硬件上限」：
  A. torch._int_mm            —— torch 内部走 cuBLASLt，会自行挑选最优布局
  B. torch 量化 matmul        —— 若可用
  C. cublasGemmEx TN 复测     —— 作为基准线对照

判定：
  · 若 A 明显高于 C，说明 cublasGemmEx 的普通布局没跑满 IMMA，是布局问题；
  · 若 A 与 C 接近，说明 45 TOPS 附近就是当前软件栈能达到的水平，
    再往上要走 CUTLASS 手写 IMMA 内核或 cublasLt + COL32。
"""
import time
import torch

print("设备:", torch.cuda.get_device_name(0),
      "| 算力:", torch.cuda.get_device_capability(0),
      "| torch:", torch.__version__, "| CUDA:", torch.version.cuda)


def timeit(fn, iters=30, warmup=5):
    for _ in range(warmup):
        fn()
    torch.cuda.synchronize()
    e0, e1 = torch.cuda.Event(enable_timing=True), torch.cuda.Event(enable_timing=True)
    e0.record()
    for _ in range(iters):
        fn()
    e1.record()
    torch.cuda.synchronize()
    return e0.elapsed_time(e1) / 1000.0 / iters


print("\n===== A. torch._int_mm（内部走 cuBLASLt）=====")
has_int_mm = hasattr(torch, "_int_mm")
print("  torch._int_mm 存在:", has_int_mm)
if has_int_mm:
    for N in (2048, 4096, 8192):
        ops = 2 * N ** 3
        a = torch.randint(-8, 8, (N, N), device="cuda", dtype=torch.int8)
        b = torch.randint(-8, 8, (N, N), device="cuda", dtype=torch.int8)
        try:
            out = torch._int_mm(a, b)
            torch.cuda.synchronize()
            s = timeit(lambda: torch._int_mm(a, b))
            print(f"  N={N:<5} A@B      {s*1000:8.3f} ms  {ops/s/1e12:7.2f} TOPS  "
                  f"dtype={out.dtype} 非零={int((out!=0).sum())}")
        except Exception as e:
            print(f"  N={N:<5} A@B      失败: {str(e)[:110]}")
        # B 转置版本（对应 cuBLAS 的 TN，通常是 IMMA 友好布局）
        try:
            bt = b.t().contiguous().t()
            s = timeit(lambda: torch._int_mm(a, bt))
            print(f"  N={N:<5} A@B.T    {s*1000:8.3f} ms  {ops/s/1e12:7.2f} TOPS")
        except Exception as e:
            print(f"  N={N:<5} A@B.T    失败: {str(e)[:110]}")
        del a, b
        torch.cuda.empty_cache()

print("\n===== B. FP16 / BF16 对照（torch.mm，走 cuBLASLt）=====")
for N in (4096, 8192):
    ops = 2 * N ** 3
    for dt in (torch.float16, torch.bfloat16):
        a = torch.randn(N, N, device="cuda", dtype=dt)
        b = torch.randn(N, N, device="cuda", dtype=dt)
        s = timeit(lambda: torch.mm(a, b))
        print(f"  N={N:<5} {str(dt).split('.')[-1]:<9} {s*1000:8.3f} ms  {ops/s/1e12:7.2f} TFLOPS")
        del a, b
        torch.cuda.empty_cache()

print("\n===== C. 达成率对照 =====")
print("""  Orin GPU 的理论 dense 峰值（按 2:4 稀疏峰值的一半反推）：
    INT8 dense  约 83 TOPS
    FP16 dense  约 42 TFLOPS
  把上面实测值除以对应理论值，即为达成率。
  FP16 达成率明显高于 INT8 时，瓶颈在 INT8 内核而非 GPU 频率。""")

print("\n===== D. GPU 频率（多个可能路径） =====")
import glob, os
found = False
for pat in ("/sys/class/devfreq/*/cur_freq",
            "/sys/kernel/debug/bpmp/debug/clk/gpc0clk/rate",
            "/sys/kernel/debug/clk/gpc0clk/clk_rate",
            "/sys/devices/gpu.0/devfreq/*/cur_freq",
            "/sys/devices/platform/*.gpu/devfreq/*/cur_freq"):
    for p in glob.glob(pat):
        try:
            print(f"  {p} = {open(p).read().strip()}")
            found = True
        except Exception as e:
            print(f"  {p} 读取失败: {e}")
if not found:
    print("  未找到 GPU 频率节点。可读的 devfreq 目录：")
    for p in glob.glob("/sys/class/devfreq/*"):
        print("   ", p)
    print("  （无输出说明该内核未导出 GPU devfreq，频率无法从 sysfs 确认）")
