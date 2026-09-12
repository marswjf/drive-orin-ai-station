#!/bin/bash
# 构建并发自动降档：前半程高并发，进入 cutlass/mem_eff 段前自动回落到 4
#
# ── 为什么需要它 ────────────────────────────────────────────────────────
# A-147 的教训是"并发按最吃内存的阶段定"，于是全程锁死 MAX_JOBS=4。
# 但 2026-08-16 实测：常规 ATen kernel 阶段每个 cicc 只占 **0.58~0.70 GB**，
# 4 个任务合计 2.8 GB，而板子有 28.7 GB、11 个核里 6 个闲着。
# 真正吃 5.7 GB/进程的是 cutlass 模板实例化（mem_eff_attention 47 个 .cu），
# 只占剩余 3022 个目标的 4%。**用 4% 的峰值限住 96% 的工作，代价是多跑三四个小时。**
#
# ── 做法 ────────────────────────────────────────────────────────────────
# 高并发跑，每 30 秒检查一次两个信号，命中任一就降档：
#   ① 日志里出现 cutlass / mem_eff / flash_attn 的 CUDA 目标（提前量：
#      这类文件每个要编好几分钟，看到第一个时其余槽位还是轻量任务，
#      此刻内存约 7×0.7+5.7≈10.6 GB，离危险还远）
#   ② MemAvailable 跌破 8 GB（兜底，防止判据①漏掉别的吃内存的段）
# 降档 = 杀掉编译进程 → 用 JOBS_OVERRIDE=4 重启构建（ninja 增量，只丢在飞的几个目标）。
#
# ⚠ 杀进程只针对编译工具（ninja/cicc/cc1plus/nvcc/ptxas/cudafe++）与构建外壳，
#   这是红线允许 pkill 的唯一范畴；服务一律 systemctl。
#
# 启动：setsid nohup bash /var/lib/llm/build313/64-build-throttle.sh > /dev/null 2>&1 < /dev/null &
# 日志：/opt/m0/torchbuild/throttle.log
BLOG=/opt/m0/torchbuild/build211.log
TLOG=/opt/m0/torchbuild/throttle.log
B=/var/lib/llm/build313
exec > "$TLOG" 2>&1

echo "###### $(date -Is) 降档守望启动 ######"
REASON=""
while true; do
  if grep -q 'BUILD211-END' "$BLOG" 2>/dev/null; then
    echo "$(date -Is) 构建已结束，无需降档，退出"; exit 0
  fi
  if ! pgrep -f t211-inner >/dev/null 2>&1; then
    echo "$(date -Is) 构建进程已不在，退出（不做任何干预）"; exit 0
  fi
  if grep -qE 'Building CUDA object.*(mem_eff_attention|flash_attn|cutlass)' "$BLOG" 2>/dev/null; then
    REASON="进入 cutlass/mem_eff 段"; break
  fi
  M=$(awk '/MemAvailable/{printf "%d", $2/1048576}' /proc/meminfo)
  if [ "${M:-99}" -lt 8 ]; then
    REASON="可用内存跌到 ${M}GB"; break
  fi
  sleep 30
done

echo "$(date -Is) ★ 触发降档：$REASON"
grep -oE '\[[0-9]+/[0-9]+\]' "$BLOG" | tail -1 | sed 's/^/  降档时进度 /'
awk '/MemAvailable/{printf "  降档时可用内存 %.1f GB\n", $2/1048576}' /proc/meminfo

# 先停 PC 侧那条守望链，避免它在"旧进程已杀、新进程未起"的空窗里误判成 build-vanished
pkill -f 62-after-build-chain 2>/dev/null && echo "  已暂停 after-build 守望链"

echo "  杀编译进程（只杀编译工具，服务一律不碰）"
pkill -f 't211-inner' 2>/dev/null
for p in ninja cicc cc1plus nvcc ptxas cudafe++ nvlink fatbinary; do
  pkill -x "$p" 2>/dev/null && echo "    killed $p"
done
sleep 8
echo -n "  残留编译进程: "; pgrep -x 'cicc|cc1plus|nvcc|ptxas' | tr '\n' ' '; echo

echo "$(date -Is) 用 JOBS=4 重启构建（ninja 增量）"
# ⚠ 变量名是 JOBS（60- 也认 JOBS_OVERRIDE，但以 JOBS 为准）
JOBS=4 bash "$B/60-build-torch211.sh"
sleep 10

echo "$(date -Is) 重启 after-build 守望链"
setsid nohup bash "$B/62-after-build-chain.sh" > /dev/null 2>&1 < /dev/null &
sleep 3
echo -n "  构建进程: "; pgrep -f t211-inner | tr '\n' ' '; echo
echo -n "  守望链: "; pgrep -f 62-after-build-chain | tr '\n' ' '; echo
echo "THROTTLE-DONE"
