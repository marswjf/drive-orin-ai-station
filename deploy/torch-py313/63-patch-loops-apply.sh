#!/bin/bash
# 补丁：Loops.cuh 的 std::apply 换成显式 __host__ __device__ 的本地实现
#
# ── 现象 ────────────────────────────────────────────────────────────────
# torch 2.11 + CUDA 12.2 + gcc-12，编到 [2549/5564] 时
# ActivationPreluKernel.cu 报 16 个错，全部指向同一处：
#   aten/src/ATen/native/cuda/Loops.cuh(67):
#     error: calling a __host__ function("std::apply<...>") from a __device__ function
#
# ── 为什么不是"关掉某个开关"就行 ────────────────────────────────────────
# nvcc 命令行里 `--expt-relaxed-constexpr` 和 `--expt-extended-lambda` **都在**，
# `-std=c++17` 也对，gcc-12 的 std::apply 确实是 constexpr。
# 而且**同一个 Loops.cuh 被几十个 kernel 用，只有这一个文件炸**——
# AbsKernel / ActivationElu / Gelu / Hardswish 等全部编过。
# 区别在于：只有 prelu_backward 走 `gpu_kernel_multiple_outputs`，
# 它的 functor 返回 `thrust::tuple<scalar_t, scalar_t>`。
# 推断（未逐层拆到底）：libstdc++ 的 std::apply 带 noexcept 说明符
#   noexcept(__unpack_std_tuple<is_nothrow_invocable, _Fn, _Tuple>)
# 对返回 thrust::tuple 的 functor 求值时，把这个实例化推成了纯 __host__。
#
# ── 补丁做什么 ──────────────────────────────────────────────────────────
# 把 PyTorch **自己的 HIP 实现**（c10/util/C++17.h 里的 c10::guts::apply）
# 原样搬进 Loops.cuh 作局部函数。它显式标了 C10_HOST_DEVICE、**没有 noexcept 说明符**，
# 且 ROCm 构建里所有 kernel 本来就走这条路径，是上游长期验证过的代码。
#
# ⚠ 为什么不直接改 c10/util/C++17.h 的 `#if defined(__HIP__)` 守卫：
#   那个头文件被 torch_cpu 广泛包含，一改就让**几千个 CPU 目标全部重编**，
#   白扔已经跑掉的两小时。改 Loops.cuh 只影响 CUDA 目标，而 CUDA 阶段才刚开始。
#
# 幂等：已打过就跳过。判据是标记 IECU-GUTS-APPLY 出现 2 次（注释 1 + 调用点 1）。
#
# 两边都能跑：
#   宿主上   bash 63-patch-loops-apply.sh
#   chroot 里 bash /root/63-patch-loops-apply.sh /build/pytorch211
# 由 60-build-torch211.sh 在 clone 之后自动调用，新板子从零构建也会带上。
set -e
if [ -n "$1" ]; then
  SRC=$1
elif [ -d /build/pytorch211 ]; then
  SRC=/build/pytorch211                                   # 在 chroot 里
else
  SRC=/var/lib/llm/chroot-focal/build/pytorch211          # 在宿主上
fi
F="$SRC/aten/src/ATen/native/cuda/Loops.cuh"
PY=""
for c in /build/venv313/bin/python /var/lib/llm/py313/bin/python3.13; do
  [ -x "$c" ] && PY=$c && break
done
[ -f "$F" ] || { echo "FATAL: 找不到 $F"; exit 2; }
[ -n "$PY" ] || { echo "FATAL: 找不到可用的 python"; exit 2; }
echo "  源码树 $SRC"
echo "  python $PY"

N=$(grep -c 'IECU-GUTS-APPLY' "$F" || true)
if [ "$N" -ge 2 ]; then
  echo "已打过补丁（标记 $N 处），跳过"
  grep -n 'IECU-GUTS-APPLY' "$F" | sed 's/^/  /'
  exit 0
fi

[ -f "$F.orig" ] || cp -a "$F" "$F.orig"

"$PY" - "$F" <<'PYEOF'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()

HELPER = '''
// IECU-GUTS-APPLY：下面这段是 PyTorch 自己的 c10::guts::apply（c10/util/C++17.h），
// 原样搬来。上游把它包在 #if defined(__HIP__) 里，CUDA 下不存在；
// 而 CUDA 12.2 + gcc-12 上 libstdc++ 的 std::apply 在 __device__ 里调不了
// （只有返回 thrust::tuple 的多输出 kernel 触发，推断是它的 noexcept 说明符所致）。
// 直接改 C++17.h 会让几千个 CPU 目标重编，所以在这里局部定义。
namespace iecu_detail {
template <class F, class Tuple, std::size_t... INDEX>
C10_HOST_DEVICE constexpr auto apply_impl(
    F&& f,
    Tuple&& t,
    std::index_sequence<INDEX...>) {
  return std::forward<F>(f)(std::get<INDEX>(std::forward<Tuple>(t))...);
}
template <class F, class Tuple>
C10_HOST_DEVICE constexpr auto apply(F&& f, Tuple&& t) {
  return apply_impl(
      std::forward<F>(f),
      std::forward<Tuple>(t),
      std::make_index_sequence<
          std::tuple_size<std::remove_reference_t<Tuple>>::value>{});
}
}  // namespace iecu_detail
'''

# 1) 在 namespace at::native { 之后插入 helper
anchor = 'namespace at::native {'
i = s.find(anchor)
assert i != -1, '找不到 namespace at::native {'
i += len(anchor)
s = s[:i] + '\n' + HELPER + s[i:]

# 2) 把 #if defined(__HIP__) 的三分支换成单一调用
old = '''#if defined(__HIP__)
      results[i] = c10::guts::apply(f, args[i]);
#else
      results[i] = std::apply(f, args[i]);
#endif'''
new = '''      // IECU-GUTS-APPLY：统一走本地的 __host__ __device__ 版本，
      // 与 ROCm 构建的行为一致
      results[i] = iecu_detail::apply(f, args[i]);'''
assert old in s, '找不到 std::apply 的三分支，源码结构变了，补丁需重写'
s = s.replace(old, new)

# 3) index_sequence 用到 <utility>，显式补上不依赖 <tuple> 的传递包含
if '#include <utility>' not in s:
    s = s.replace('#include <tuple>', '#include <tuple>\n#include <utility>', 1)

open(p, 'w', encoding='utf-8').write(s)
print('补丁已写入')
PYEOF

echo "=== 校验 ==="
echo -n "  标记数（应为 2）: "; grep -c 'IECU-GUTS-APPLY' "$F"
echo -n "  残留的 std::apply（应为 0）: "; grep -c 'std::apply' "$F"
echo -n "  iecu_detail::apply 调用（应为 1）: "; grep -c 'iecu_detail::apply(f, args\[i\])' "$F"
grep -n 'iecu_detail\|IECU-GUTS-APPLY\|#include <utility>' "$F" | head -12 | sed 's/^/  /'
echo "PATCH-LOOPS-DONE"
