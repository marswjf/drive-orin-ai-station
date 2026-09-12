#!/bin/bash
# 板上守望链：等 torch 2.11 编完 → 复核运行时 → 验收八项 → 全绿才起 vision/audio
#
# 为什么放板上跑：PC 侧的后台守望任务会被反复回收（15 分钟的等待期正好是回收窗口），
# 而这条链本身要等几小时。放板上用 setsid nohup，与任何 SSH 会话解耦，
# 和构建本体是同一个道理。
#
# 启动方式（宿主上一条命令，不嵌套）：
#   setsid nohup bash /var/lib/llm/build313/62-after-build-chain.sh > /dev/null 2>&1 < /dev/null &
# 查看进度：
#   tail -40 /opt/m0/torchbuild/after-build.log
B=/var/lib/llm/build313
BLOG=/opt/m0/torchbuild/build211.log
LOG=/opt/m0/torchbuild/after-build.log

exec > "$LOG" 2>&1
echo "###### $(date -Is) 守望链启动，等 torch 2.11 编完 ######"

# ── 1. 等构建结束 ──────────────────────────────────────────────
# 两个出口：出现 BUILD211-END 标记，或外壳进程消失（被 OOM 杀 / set -e 提前退出）。
# 不从"没有输出"推断"正在进行"，每轮都实际查进度。
while true; do
  if grep -q 'BUILD211-END' "$BLOG" 2>/dev/null; then
    echo "$(date -Is) 检测到 BUILD211-END"
    break
  fi
  if ! pgrep -f t211-inner >/dev/null 2>&1; then
    echo "$(date -Is) !! 外壳进程已消失但没有 END 标记"
    echo "   —— 可能是 OOM 被杀，也可能是 set -e 在打标记前退出。查 dmesg 与日志尾部："
    dmesg 2>/dev/null | grep -i 'killed process' | tail -3
    tail -25 "$BLOG"
    echo "CHAIN-END reason=build-vanished"
    exit 1
  fi
  # tj 热区按 type 找，不要写死 thermal_zone 编号（编号顺序不保证稳定）
  TJ=0
  for z in /sys/devices/virtual/thermal/thermal_zone*; do
    [ "$(cat "$z/type" 2>/dev/null)" = "tj-therm" ] && TJ=$(cat "$z/temp" 2>/dev/null)
  done
  echo "$(date -Is) $(grep -oE '\[[0-9]+/[0-9]+\]' "$BLOG" | tail -1) 内存 $(awk '/MemAvailable/{printf "%d", $2/1024}' /proc/meminfo)MiB tj $((TJ/1000))C"
  sleep 300
done

RC=$(grep -oE 'BUILD211-END rc=[0-9]+' "$BLOG" | tail -1 | grep -oE '[0-9]+$')
echo "构建返回码 rc=${RC:-未知}"
if [ "${RC:-1}" != "0" ]; then
  echo "!! 构建失败，不继续。错误行："
  grep -nE '^FAILED:|error:' "$BLOG" | tail -10 | cut -c1-200
  echo "CHAIN-END reason=build-failed"
  exit 1
fi
ls -l /opt/m0/torchbuild/out/torch-2.11*.whl

# ── 2. 运行时复核（已铺好就不重铺）────────────────────────────
echo
echo "###### $(date -Is) A. CUDA 12.2 运行时复核 ######"
STAGED=$(ls /var/lib/llm/cuda122/lib64/libcudart.so.12.2.* 2>/dev/null | head -1)
BAD=$(ls /var/lib/llm/cuda122/lib64 2>/dev/null \
      | grep -E '^(libcudart|libcublas|libcublasLt|libnvrtc|libnvJitLink)\.so\.12\.[0-9]' \
      | grep -vE '\.so\.12\.2\.')
if [ -n "$STAGED" ] && [ -z "$BAD" ]; then
  echo "  已铺好且全是 12.2（$(ls /var/lib/llm/cuda122/lib64 | wc -l) 个文件），跳过重铺"
else
  echo "  未铺好或混有非 12.2 的库，重新铺"
  bash "$B/56-stage-runtime.sh" || { echo "CHAIN-END reason=stage-failed"; exit 1; }
fi

# ── 3. 验收 ───────────────────────────────────────────────────
echo
echo "###### $(date -Is) B. torch 2.11 验收（判据是真跑 kernel） ######"
# 用 tee 单独留一份，不去 grep 正在写入的 $LOG（自己 grep 自己容易读到半截）
bash "$B/53-verify-torch211.sh" 2>&1 | tee /tmp/verify211.out

# ── 4. 全绿才起配套包 ─────────────────────────────────────────
if grep -q 'ALL-PASS' /tmp/verify211.out; then
  echo
  echo "###### $(date -Is) C. 验收全绿，起 torchvision 0.26.0 + torchaudio 2.11.0 ######"
  bash "$B/54-build-vision-audio.sh"
  echo "  已在后台编，日志 /opt/m0/torchbuild/vision-audio-313.log"
  echo "CHAIN-END reason=ok-vision-audio-started"
else
  echo
  echo "!! 验收未全绿，不自动继续。看上面哪一项 FAIL。"
  echo "CHAIN-END reason=verify-failed"
fi
