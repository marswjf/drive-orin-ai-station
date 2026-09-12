#!/bin/bash
# 宿主上执行：把新栈在【板上】跑起来所缺的运行库预置到 /var/lib/llm/cuda122/lib64
#
# 与 py310 那版（11-stage-runtime-libs.sh）的区别：那时 CUDA 用 11.4，板上 Tegra 自带
# 全套运行库，只需补 libnvToolsExt + OpenBLAS 两个。现在整套 CUDA 12.2 + cuDNN 9.20
# 板上都没有，必须完整分发。
#
# 🔴 铁律一：**libcuda.so.1 永远用板上 Tegra 的那个**（/usr/lib/libcuda.so.1），
#    绝不分发、绝不覆盖 —— 它是驱动的一部分，与内核模块配套。
#    分发的只能是"运行时库"（cudart/cublas/cudnn/nvrtc…），不含驱动。
#
# 🔴 铁律二：**CUDA 版本必须与编 torch 时用的完全一致（12.2）**。
#    探索期这个目录里放过 12.4 的库，而 12.4 编的 torch 会绑 multicast 驱动 API、
#    在 Tegra 单卡上报 cudaErrorDevicesUnavailable(46)。运行时库版本不匹配同样危险，
#    所以脚本开头**先整目录清空再重铺**——库文件名带版本号后缀，
#    同名覆盖清不掉上一版的残留（libcublas.so.12.4.x 会和 12.2.x 并存）。
#
# 另外两个容易漏的：
#   libstdc++.so.6 —— 新 gcc 编的代码要更高的 GLIBCXX，板上 focal 只有 3.4.28。
#     文件名存在 ≠ 版本够，所以这个必须**无条件**拷新版，不能走"板上有就跳过"的逻辑。
#   libgomp.so.1  —— 同理，取 chroot 里那份。
set -e
ROOT=/var/lib/llm/chroot-focal
MNT=/var/lib/llm/cuda122
DST="$MNT/lib64"
CU="$ROOT/usr/local/cuda-12.2"
[ -d "$CU" ] || { echo "FATAL: $CU 不存在，CUDA 版本必须是 12.2"; exit 9; }
if ! mount | grep -q "$ROOT/proc"; then sh /var/lib/llm/chroot-focal-mount.sh >/dev/null; fi

is_mounted() { awk -v p="$1" '$2==p{f=1} END{exit !f}' /proc/mounts; }

echo "===== [0] 把探索期的 cuda129 改名成 cuda122（保留实体，不删不拷） ====="
# 探索期实体叫 /opt/m0/cuda129 并 bind 到 /var/lib/llm/cuda129，里面是 12.4 的库。
# 用 mv 改名而不是"新建 + 删旧"：省 2.5G 空间，且改名失败是可见错误、不会丢东西。
if is_mounted /var/lib/llm/cuda129; then
  umount /var/lib/llm/cuda129 && echo "  已卸载 /var/lib/llm/cuda129"
fi
[ -d /var/lib/llm/cuda129 ] && rmdir /var/lib/llm/cuda129 2>/dev/null || true
if [ -d /opt/m0/cuda129 ] && [ ! -d /opt/m0/cuda122 ]; then
  mv /opt/m0/cuda129 /opt/m0/cuda122
  echo "  实体已改名: /opt/m0/cuda129 -> /opt/m0/cuda122"
fi
mkdir -p /opt/m0/cuda122/lib64

echo "===== [0.5] 建 bind 挂载并硬校验实体落在 /opt/m0 ====="
# 🔴 不做这一步，下面 2.5G 库会直接写进 /var —— /var 是 20G 的 overlay，
#    这套东西的整个空间设计就是"实体放 /opt/m0，bind 回 /var/lib/llm 并去掉 noexec"。
# 挂载脚本的正式落点就是 /var/lib/llm/（comfyui.service 的 ExecStartPre 也引用这里），
# 不在就从 build313 装过去，顺便把切换时的那一步做掉。
if [ ! -x /var/lib/llm/mount-stack313.sh ]; then
  cp -a /var/lib/llm/build313/mount-stack313.sh /var/lib/llm/mount-stack313.sh
  chmod 755 /var/lib/llm/mount-stack313.sh
  echo "  已安装 /var/lib/llm/mount-stack313.sh"
fi
sh /var/lib/llm/mount-stack313.sh
BACK=$(df -P "$MNT" | tail -1 | awk '{print $1}')
M0=$(df -P /opt/m0 | tail -1 | awk '{print $1}')
if [ "$BACK" != "$M0" ]; then
  echo "  🔴 FATAL: $MNT 的实体在 $BACK，不是 /opt/m0 的 $M0"
  echo "     bind 挂载没生效，继续下去会把 2.5G 写进 /var。停。"
  exit 7
fi
echo "  OK: $MNT 实体在 $BACK（与 /opt/m0 同一块）"

echo "===== [0.8] 清空旧版残留（必须；见铁律二） ====="
if [ -d "$DST" ]; then
  echo "  清理前: $(ls "$DST" | wc -l) 个文件 / $(du -sh "$DST" | cut -f1)"
  ls "$DST" | grep -E 'libcublas\.so\.12\.' | sed 's/^/    旧: /' || true
  rm -rf "$DST"
fi
mkdir -p "$DST"

echo "===== [1] CUDA 12.2 运行时库（不含驱动） ====="
# USE_KINETO=0 所以不需要 cupti；nvToolsExt 被 libtorch_cuda 链接
for pat in libcudart.so.12 libcublas.so.12 libcublasLt.so.12 libcufft.so.11 \
           libcurand.so.10 libcusolver.so.11 libcusolverMg.so.11 libcusparse.so.12 \
           libnvrtc.so.12 libnvrtc-builtins.so.12 libnvJitLink.so.12 libnvToolsExt.so.1 \
           libnvblas.so.12; do
  for f in "$CU"/lib64/${pat}*; do
    [ -e "$f" ] || continue
    cp -a "$f" "$DST/" 2>/dev/null && echo "  + $(basename $f) $(stat -c %s "$f" | numfmt --to=iec)"
  done
done

echo "===== [2] cuDNN 9.20 ====="
for f in "$ROOT"/usr/lib/aarch64-linux-gnu/libcudnn*.so.9*; do
  [ -e "$f" ] || continue
  cp -a "$f" "$DST/" 2>/dev/null && echo "  + $(basename $f) $(stat -c %s "$f" | numfmt --to=iec)"
done

echo "===== [3] gcc 运行时（板上版本太旧，必须覆盖使用） ====="
# 取 chroot 里的默认（最新）版本即可：libstdc++ 向后兼容，高版本是低版本的超集。
# ⚠ libatomic 容易漏：gcc 编出的 torch 会链接它，板上没有 → import 直接失败
for n in libstdc++.so.6 libgomp.so.1 libgcc_s.so.1 libatomic.so.1; do
  src=$(readlink -f "$ROOT/usr/lib/aarch64-linux-gnu/$n" 2>/dev/null)
  [ -e "$src" ] || src=$(readlink -f "$ROOT/lib/aarch64-linux-gnu/$n" 2>/dev/null)
  [ -e "$src" ] || { echo "  !! 找不到 $n"; continue; }
  # 先清掉可能存在的坏链接（早期版本的自链接 bug 会留下断链，cp 会报 Too many levels）
  rm -f "$DST/$n" "$DST/$(basename "$src")"
  cp -a "$src" "$DST/"
  # ⚠ 真实文件名可能就等于 soname（libgcc_s.so.1 / libopenblas.so.0 就是这样），
  #   这时再 ln -sf 会造出指向自己的断链，表现为 "cannot open shared object file"。
  if [ "$(basename "$src")" != "$n" ]; then ln -sf "$(basename "$src")" "$DST/$n"; fi
  echo "  + $n -> $(basename $src) $(stat -c %s "$src" | numfmt --to=iec)"
done
echo "-- 板上原版对照（不动它们，只在 LD_LIBRARY_PATH 里排前面）:"
ls -la /usr/lib/aarch64-linux-gnu/libstdc++.so.6 | sed 's/^/    /'

echo "===== [4] OpenBLAS + gfortran（沿用 A-133 修好的 0.3.29） ====="
# 搜索顺序把 chroot 的自编目录放最前：那里的文件名带明确版本
# （libopenblas_armv8p-r0.3.29.so），归档后能一眼看出是哪一版；
# torch-extra-libs 里那份文件名就是 libopenblas.so.0，看不出版本。
for n in libopenblas.so.0 libgfortran.so.5; do
  for d in "$ROOT/build/openblas-install/lib" /var/lib/llm/torch-extra-libs "$ROOT/usr/lib/aarch64-linux-gnu"; do
    f=$(readlink -f "$d/$n" 2>/dev/null)
    [ -e "$f" ] || continue
    rm -f "$DST/$n" "$DST/$(basename "$f")"
    cp -a "$f" "$DST/"
    # 同上：文件名等于 soname 时不能再建同名链接（会自指、断链）
    if [ "$(basename "$f")" != "$n" ]; then ln -sf "$(basename "$f")" "$DST/$n"; fi
    echo "  + $n <- $d ($(basename "$f"))"
    break
  done
done

echo "===== [5] 安全检查：绝不能出现驱动库 ====="
BAD=$(ls "$DST" | grep -E '^libcuda\.so|^libnvidia|^libnvrm|^libnvos' || true)
if [ -n "$BAD" ]; then
  echo "  🔴 检测到驱动库，立即删除: $BAD"
  for b in $BAD; do rm -f "$DST/$b"; done
else
  echo "  OK：目录内无驱动库"
fi

echo "===== [6] 版本自检：铺进去的必须全是 12.2 ====="
# ⚠ 只对**版本号跟随 CUDA 版本**的那几个库判定。
#   cufft/curand/cusolver/cusparse 各有自己的版本线（如 CUDA 12.2 配
#   libcusparse.so.12.1.1.53），拿它们判定会误报。
WRONG=$(ls "$DST" | grep -E '^(libcudart|libcublas|libcublasLt|libnvrtc|libnvJitLink)\.so\.12\.[0-9]' \
        | grep -vE '\.so\.12\.2\.' || true)
if [ -n "$WRONG" ]; then
  echo "  🔴 混进了非 12.2 的库，说明目录没清干净:"
  echo "$WRONG" | sed 's/^/    /'
  exit 8
fi
ls "$DST" | grep -E '^(libcudart|libcublas)\.so\.12\.' | sed 's/^/  /'
echo "  OK：无非 12.2 残留"

echo "===== [7] 挂载与实体位置复核 ====="
grep -E 'cuda122|comfyui313' /proc/mounts | sed 's/^/  /'
for leftover in /var/lib/llm/cuda129 /opt/m0/cuda129; do
  [ -e "$leftover" ] && echo "  ⚠ 探索期遗留仍在: $leftover（第 [0] 步应已改名，请人工确认）"
done

echo "===== [8] 体积与清单 ====="
du -sh "$DST"
ls "$DST" | wc -l | sed 's/^/  文件数: /'
df -h /var | tail -1 | sed 's/^/  /'
echo STAGE-DONE
