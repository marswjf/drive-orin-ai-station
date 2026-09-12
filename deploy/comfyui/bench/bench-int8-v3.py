"""INT8 / FP16 算力实测 v3

v2 的三个测量缺陷（2026-08-16 复核时发现）：
  1. 加载 libcublas.so.11（CUDA 11.4 的 cuBLAS）。板上现有 CUDA 12.2，
     新版对 sm_87 的 INT8 内核实现可能不同，必须分别测。
  2. 用 time.time() 计时，包含 Python/ctypes 调用开销与主机侧抖动。
     改用 CUDA event，测的是设备侧真实耗时。
  3. 全程不采 GPU 频率。跑不满可能是频率没上去，而不是内核没用上 tensor core。

口径说明（避免与厂商标称值比错）：
  · 一次 MAC = 2 ops，本脚本的 ops = 2 * M * N * K，与 NVIDIA 的 TOPS/FLOPS 口径一致。
  · 同时输出 TMAC/s（= TOPS / 2），便于和只按 M*N*K 计数的脚本对照。
  · 厂商标称的 Orin 254/275 TOPS 是 **INT8 稀疏 + GPU 与两个 DLA 合计**。
    2:4 结构化稀疏理论吞吐是 dense 的 2 倍，所以拿随机 dense 权重去跑，
    对标值应是 GPU dense INT8，不是标称峰值。
"""
import ctypes, glob, os, sys, time
import torch

CUBLAS_OP_N, CUBLAS_OP_T = 0, 1
CUDA_R_8I, CUDA_R_32I, CUDA_R_16F = 3, 10, 2
CUBLAS_COMPUTE_32I = 72
CUBLAS_COMPUTE_32F = 68
CUBLAS_GEMM_DEFAULT = -1
CUBLAS_GEMM_DEFAULT_TENSOR_OP = 99
ERRS = {0: "SUCCESS", 1: "NOT_INITIALIZED", 7: "INVALID_VALUE", 8: "ARCH_MISMATCH",
        13: "EXECUTION_FAILED", 14: "INTERNAL_ERROR", 15: "NOT_SUPPORTED"}

torch.cuda.init()
_ = torch.zeros(8, device="cuda")
print("设备:", torch.cuda.get_device_name(0),
      "| 算力等级:", torch.cuda.get_device_capability(0),
      "| torch:", torch.__version__, "| 编译期 CUDA:", torch.version.cuda)


# ---------- GPU 频率 ----------
def gpu_freq_nodes():
    out = []
    for p in glob.glob("/sys/class/devfreq/*"):
        try:
            name = os.path.basename(p)
            cur = open(os.path.join(p, "cur_freq")).read().strip()
            mx = open(os.path.join(p, "max_freq")).read().strip()
            out.append((name, int(cur), int(mx)))
        except Exception:
            pass
    return out


def show_freq(tag):
    nodes = gpu_freq_nodes()
    if not nodes:
        print(f"  [{tag}] 无 devfreq 节点，读不到 GPU 频率")
        return
    for name, cur, mx in nodes:
        pct = 100.0 * cur / mx if mx else 0
        print(f"  [{tag}] {name}  {cur/1e6:.0f} / {mx/1e6:.0f} MHz  ({pct:.0f}%)")


# ---------- cuBLAS 绑定 ----------
def load_cublas(path):
    lib = ctypes.CDLL(path)
    lib.cublasGemmEx.restype = ctypes.c_int
    lib.cublasGemmEx.argtypes = [
        ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
        ctypes.c_int, ctypes.c_int, ctypes.c_int,
        ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
        ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
        ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
        ctypes.c_int, ctypes.c_int,
    ]
    return lib


def bench(lib, handle, N, ta, tb, atype, ctype, comp, algo, A, B, C, alpha, beta, iters=30):
    """返回 (设备侧单次耗时秒, 非零元素数) 或 (None, status)"""
    def call():
        return lib.cublasGemmEx(
            handle, ta, tb, N, N, N,
            ctypes.cast(ctypes.pointer(alpha), ctypes.c_void_p),
            ctypes.c_void_p(A.data_ptr()), atype, N,
            ctypes.c_void_p(B.data_ptr()), atype, N,
            ctypes.cast(ctypes.pointer(beta), ctypes.c_void_p),
            ctypes.c_void_p(C.data_ptr()), ctype, N,
            comp, algo)

    st = call()
    torch.cuda.synchronize()
    if st != 0:
        return None, st
    for _ in range(5):                       # 预热，让频率爬上去
        call()
    torch.cuda.synchronize()

    ev0, ev1 = torch.cuda.Event(enable_timing=True), torch.cuda.Event(enable_timing=True)
    ev0.record()
    for _ in range(iters):
        call()
    ev1.record()
    torch.cuda.synchronize()
    s = ev0.elapsed_time(ev1) / 1000.0 / iters
    return (s, int((C != 0).sum().item())), 0


def run_suite(libpath, sizes=(2048, 4096, 8192)):
    print(f"\n{'='*72}\ncuBLAS: {libpath}\n{'='*72}")
    try:
        lib = load_cublas(libpath)
    except OSError as e:
        print("  加载失败：", e)
        return {}
    handle = ctypes.c_void_p(torch.cuda.current_blas_handle())
    best = {}

    for N in sizes:
        ops = 2 * N ** 3                     # 一次 MAC 记 2 ops
        print(f"\n--- N = {N}  (ops = 2*N^3 = {ops/1e12:.2f} T) ---")
        ai, bi = ctypes.c_int(1), ctypes.c_int(0)
        try:
            A8 = torch.randint(-8, 8, (N, N), device="cuda", dtype=torch.int8)
            B8 = torch.randint(-8, 8, (N, N), device="cuda", dtype=torch.int8)
            C32 = torch.zeros(N, N, device="cuda", dtype=torch.int32)
        except RuntimeError as e:
            print("  分配失败（内存不足），跳过：", str(e)[:80])
            continue

        for tname, ta, tb in [("NN", CUBLAS_OP_N, CUBLAS_OP_N),
                              ("NT", CUBLAS_OP_N, CUBLAS_OP_T),
                              ("TN", CUBLAS_OP_T, CUBLAS_OP_N),
                              ("TT", CUBLAS_OP_T, CUBLAS_OP_T)]:
            for aname, algo in [("default", CUBLAS_GEMM_DEFAULT),
                                ("tensor_op", CUBLAS_GEMM_DEFAULT_TENSOR_OP)]:
                C32.zero_()
                r, st = bench(lib, handle, N, ta, tb, CUDA_R_8I, CUDA_R_32I,
                              CUBLAS_COMPUTE_32I, algo, A8, B8, C32, ai, bi)
                if r is None:
                    print(f"  INT8 {tname} {aname:<10} 失败 status={st} ({ERRS.get(st,'?')})")
                    continue
                s, nz = r
                tops = ops / s / 1e12
                if nz:
                    best[("int8", N)] = max(best.get(("int8", N), 0), tops)
                print(f"  INT8 {tname} {aname:<10} {s*1000:8.3f} ms  "
                      f"{tops:7.2f} TOPS  ({tops/2:6.2f} TMAC/s)  "
                      f"{'非零 '+str(nz) if nz else '★全 0，无效'}")
        del A8, B8, C32
        torch.cuda.empty_cache()

        # FP16 对照
        af, bf = ctypes.c_float(1.0), ctypes.c_float(0.0)
        A16 = torch.randn(N, N, device="cuda", dtype=torch.float16)
        B16 = torch.randn(N, N, device="cuda", dtype=torch.float16)
        C16 = torch.zeros(N, N, device="cuda", dtype=torch.float16)
        for tname, ta, tb in [("NN", CUBLAS_OP_N, CUBLAS_OP_N),
                              ("TN", CUBLAS_OP_T, CUBLAS_OP_N)]:
            for aname, algo in [("default", CUBLAS_GEMM_DEFAULT),
                                ("tensor_op", CUBLAS_GEMM_DEFAULT_TENSOR_OP)]:
                C16.zero_()
                r, st = bench(lib, handle, N, ta, tb, CUDA_R_16F, CUDA_R_16F,
                              CUBLAS_COMPUTE_32F, algo, A16, B16, C16, af, bf)
                if r is None:
                    print(f"  FP16 {tname} {aname:<10} 失败 status={st} ({ERRS.get(st,'?')})")
                    continue
                s, nz = r
                tf = ops / s / 1e12
                if nz:
                    best[("fp16", N)] = max(best.get(("fp16", N), 0), tf)
                print(f"  FP16 {tname} {aname:<10} {s*1000:8.3f} ms  "
                      f"{tf:7.2f} TFLOPS  {'非零 '+str(nz) if nz else '★全 0，无效'}")
        show_freq(f"N={N} 跑完")
        del A16, B16, C16
        torch.cuda.empty_cache()
    return best


show_freq("开跑前")

CU122 = "/var/lib/llm/cuda122/lib64/libcublas.so.12"
CU114 = None
for c in ("/usr/local/cuda-11.4/targets/aarch64-linux/lib/libcublas.so.11",
          "/usr/lib/aarch64-linux-gnu/libcublas.so.11", "libcublas.so.11"):
    if c == "libcublas.so.11" or os.path.exists(c):
        CU114 = c
        break

results = {}
if os.path.exists(CU122):
    results["CUDA 12.2"] = run_suite(CU122)
else:
    print("找不到", CU122)

print("\n\n" + "=" * 72)
print("汇总（口径：ops = 2*M*N*K，与 NVIDIA TOPS 口径一致）")
print("=" * 72)
for tag, best in results.items():
    print(f"\n{tag}")
    for N in (2048, 4096, 8192):
        i8 = best.get(("int8", N))
        f16 = best.get(("fp16", N))
        if i8 or f16:
            r = f"{i8/f16:.2f}x" if (i8 and f16) else "—"
            print(f"  N={N:<5} INT8 {i8 if i8 else 0:6.2f} TOPS   "
                  f"FP16 {f16 if f16 else 0:6.2f} TFLOPS   INT8/FP16 = {r}")

print("""
对标说明：
  · Orin 标称 254/275 TOPS = INT8 **稀疏** + GPU 与两个 DLA 合计。
  · 2:4 结构化稀疏理论吞吐为 dense 的 2 倍，随机 dense 权重跑不出稀疏峰值。
  · 因此本测试应对标 GPU dense INT8，而不是标称峰值。
""")
