"""INT8 算力实测 v2 —— 修正 v1 的两个测量错误。

v1 的问题：
  1. FP16 用 CUBLAS_COMPUTE_16F 但 alpha/beta 传了 c_float 指针，
     cuBLAS 按 half 读那 2 个字节 → 读到垃圾/0 → 内核实际没算，
     结果全 0、耗时 0.20ms、算出 687 TFLOPS 这种超硬件极限的假数据。
     修正：改用 CUBLAS_COMPUTE_32F（fp16 输入 / fp32 累加），alpha/beta 本来就是 float。
  2. INT8 只测了 NN 布局。cuBLAS 的 INT8 要用上 IMMA tensor core
     对转置组合有要求（通常 A 列主序、B 行主序，即 transb=T），
     NN 会回退到非 tensor core 的慢路径。
     修正：NN / NT / TN / TT 四种组合全测。
判定：若某个组合明显快于 FP16，说明 INT8 tensor core 在板上是真实可用的。
"""
import ctypes, time, torch

CUBLAS_OP_N, CUBLAS_OP_T = 0, 1
CUDA_R_8I, CUDA_R_32I, CUDA_R_16F, CUDA_R_32F = 3, 10, 2, 0
CUBLAS_COMPUTE_32I = 72
CUBLAS_COMPUTE_32F = 68
CUBLAS_COMPUTE_32F_FAST_16F = 74
CUBLAS_GEMM_DEFAULT = -1
CUBLAS_GEMM_DEFAULT_TENSOR_OP = 99

torch.cuda.init()
_ = torch.zeros(8, device="cuda")
print("device:", torch.cuda.get_device_name(0),
      "capability:", torch.cuda.get_device_capability(0))

lib = ctypes.CDLL("libcublas.so.11")
lib.cublasGemmEx.restype = ctypes.c_int
lib.cublasGemmEx.argtypes = [
    ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
    ctypes.c_int, ctypes.c_int, ctypes.c_int,
    ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
    ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
    ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
    ctypes.c_int, ctypes.c_int,
]
handle = ctypes.c_void_p(torch.cuda.current_blas_handle())
ERRS = {0: "SUCCESS", 7: "INVALID_VALUE", 8: "ARCH_MISMATCH", 13: "EXECUTION_FAILED",
        14: "INTERNAL_ERROR", 15: "NOT_SUPPORTED"}
N = 4096
FLOPS = 2 * N ** 3


def measure(ta, tb, atype, ctype, comp, algo, A, B, C, alpha, beta):
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
    for _ in range(3):
        call()
    torch.cuda.synchronize()
    t = time.time()
    IT = 20
    for _ in range(IT):
        call()
    torch.cuda.synchronize()
    s = (time.time() - t) / IT
    return (s, int((C != 0).sum().item())), 0


print("\n===== INT8 GEMM：四种转置组合（N=%d）=====" % N)
ai, bi = ctypes.c_int(1), ctypes.c_int(0)
A8 = torch.randint(-8, 8, (N, N), device="cuda", dtype=torch.int8)
B8 = torch.randint(-8, 8, (N, N), device="cuda", dtype=torch.int8)
C32 = torch.zeros(N, N, device="cuda", dtype=torch.int32)
best_i8 = 0.0
for tname, ta, tb in [("NN", CUBLAS_OP_N, CUBLAS_OP_N), ("NT", CUBLAS_OP_N, CUBLAS_OP_T),
                      ("TN", CUBLAS_OP_T, CUBLAS_OP_N), ("TT", CUBLAS_OP_T, CUBLAS_OP_T)]:
    for aname, algo in [("default", CUBLAS_GEMM_DEFAULT),
                        ("tensor_op", CUBLAS_GEMM_DEFAULT_TENSOR_OP)]:
        C32.zero_()
        r, st = measure(ta, tb, CUDA_R_8I, CUDA_R_32I, CUBLAS_COMPUTE_32I, algo,
                        A8, B8, C32, ai, bi)
        if r is None:
            print("  %s %-10s 失败 status=%d (%s)" % (tname, aname, st, ERRS.get(st, "?")))
            continue
        s, nz = r
        tops = FLOPS / s / 1e12
        best_i8 = max(best_i8, tops if nz > 0 else 0)
        print("  %s %-10s %8.2f ms  %7.2f TOPS  %s"
              % (tname, aname, s * 1000, tops, "非零 %d" % nz if nz else "★结果全 0，无效"))
del A8, B8, C32
torch.cuda.empty_cache()

print("\n===== FP16 GEMM 对照（fp32 累加，alpha/beta 类型正确）=====")
af, bf = ctypes.c_float(1.0), ctypes.c_float(0.0)
A16 = torch.randn(N, N, device="cuda", dtype=torch.float16)
B16 = torch.randn(N, N, device="cuda", dtype=torch.float16)
C16 = torch.zeros(N, N, device="cuda", dtype=torch.float16)
best_f16 = 0.0
for aname, algo in [("default", CUBLAS_GEMM_DEFAULT), ("tensor_op", CUBLAS_GEMM_DEFAULT_TENSOR_OP)]:
    C16.zero_()
    r, st = measure(CUBLAS_OP_N, CUBLAS_OP_N, CUDA_R_16F, CUDA_R_16F,
                    CUBLAS_COMPUTE_32F, algo, A16, B16, C16, af, bf)
    if r is None:
        print("  NN %-10s 失败 status=%d (%s)" % (aname, st, ERRS.get(st, "?")))
        continue
    s, nz = r
    tops = FLOPS / s / 1e12
    best_f16 = max(best_f16, tops if nz > 0 else 0)
    print("  NN %-10s %8.2f ms  %7.2f TFLOPS  %s"
          % (aname, s * 1000, tops, "非零 %d" % nz if nz else "★结果全 0，无效"))

print("\n===== torch 原生对照 =====")
torch.cuda.synchronize()
for _ in range(3):
    torch.mm(A16, B16)
torch.cuda.synchronize()
t = time.time()
for _ in range(20):
    torch.mm(A16, B16)
torch.cuda.synchronize()
s = (time.time() - t) / 20
print("  torch.mm fp16       %8.2f ms  %7.2f TFLOPS" % (s * 1000, FLOPS / s / 1e12))

print("\n===== 判定 =====")
print("  INT8 最快 : %6.2f TOPS" % best_i8)
print("  FP16 最快 : %6.2f TFLOPS" % best_f16)
if best_i8 and best_f16:
    ratio = best_i8 / best_f16
    print("  加速比    : %.2fx" % ratio)
    if ratio > 1.5:
        print("  → INT8 tensor core 真实可用，值得投工程接进推理路径")
    elif ratio > 0.9:
        print("  → INT8 与 FP16 打平，量化只省内存不提速")
    else:
        print("  → INT8 反而更慢：cuBLAS 在 sm_87 上没给 INT8 走 tensor core 路径，")
        print("    量化的收益只在内存，不在算力")
