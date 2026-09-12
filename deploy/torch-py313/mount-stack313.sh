#!/bin/sh
# 新栈（py3.13 / torch 2.11 / CUDA 12.2）的挂载脚本
# 板上位置: /var/lib/llm/mount-stack313.sh
# 由 comfyui.service 的 ExecStartPre 调用，也可手动跑。幂等。
#
# 为什么要这一层：/var 只有 20G，装不下第二套完整环境（现役 comfyui310 已占 2.6G，
# 新栈的 torch+CUDA+cuDNN 合计超过 6G）。所以实体放在别的分区，
# 再 bind 回 /var/lib/llm 下。**/opt/* 全部带 noexec**，bind 之后必须 remount 去掉，
# 否则 .so 加载会失败（noexec 会挡住 PROT_EXEC 的 mmap）。
# 全部是加法操作，不写 /etc/fstab，重启后由服务再跑一次即可。
#
# ★ 实体根路径按板子不同（2026-08-17 参数化，两块板共用这一个脚本）：
#   上一块板（批次A）：/opt/m0 —— 那是 vblkdev23 独立 26G 设备，放得下
#   新板（这块板）：/opt/update —— 它的 /opt/m0 是 vblkdev56，与 /opt/other 同一个设备，
#                 而 /opt/other/overlay/upper 正是 /var 的可写层宿主；
#                 往 /opt/m0 放 6G 等于直接吃掉 /var 的空间
# 优先级：环境变量 STACK_ROOT > 已存在实体的目录 > 默认 /opt/m0（保持上一块板行为不变）
set -e

if [ -n "${STACK_ROOT:-}" ]; then
  ROOT=$STACK_ROOT
elif [ -d /opt/update/comfyui313 ] || [ -d /opt/update/cuda122 ]; then
  ROOT=/opt/update
else
  ROOT=/opt/m0
fi
echo "实体根路径: $ROOT"

pairs="$ROOT/cuda122:/var/lib/llm/cuda122 $ROOT/comfyui313:/var/lib/llm/comfyui313"

is_mounted() { awk -v p="$1" '$2==p{f=1} END{exit !f}' /proc/mounts; }

for pair in $pairs; do
  src=${pair%%:*}
  dst=${pair##*:}
  mkdir -p "$src" "$dst"
  if ! is_mounted "$dst"; then
    mount --bind "$src" "$dst"
  fi
  # 关键：去掉 noexec（继承自 /opt/m0 的挂载选项）
  mount -o remount,bind,rw,exec "$dst"
done

# 自检：exec 真的生效了吗（noexec 时下面这行会失败）
t=/var/lib/llm/comfyui313/.exectest
printf '#!/bin/sh\nexit 0\n' > "$t" && chmod +x "$t"
if "$t"; then
  rm -f "$t"
else
  echo "FATAL: /var/lib/llm/comfyui313 仍带 noexec，remount 没生效" >&2
  exit 1
fi

# CUDA 运行时是否真的在
if [ ! -e /var/lib/llm/cuda122/lib64/libcudart.so.12 ]; then
  echo "WARN: /var/lib/llm/cuda122/lib64 里没有 libcudart.so.12（还没 stage？）" >&2
fi

echo "mount-stack313 OK"
grep -E 'cuda122|comfyui313' /proc/mounts
