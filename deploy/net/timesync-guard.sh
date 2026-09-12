#!/bin/sh
# 时间同步守卫。板子没有 RTC，开机时间从上次落盘的时间戳起算，不校时就会一直错下去。
#
# 为什么需要这个东西（2026-08-19 实测的故障）：
#   systemd-timesyncd 是 DefaultDependencies=no + Before=sysinit.target，
#   它在网络起来、在 iecu-egress 装好 uid 101 的出网路由**之前**就启动了，
#   那一刻根本出不去网；之后它再没有同步成功。结果是板子 01:01 开机，
#   到 19:49 人工干预为止，系统时间一直停在三个月前（5 月 17 日）。
#   直接后果：所有 HTTPS 请求报「certificate is not yet valid」，日志时间线不可用。
#
# 判据纪律（陷阱 51/57）：
#   - 不看 systemctl is-active，只认 timedatectl 的 NTPSynchronized
#   - 本脚本对应的 unit 不能写 RemainAfterExit=yes，否则定时器每次触发都是空操作
set -u

NODE=/var/lib/llm/bin/node
SNTP=/var/lib/llm/net/sntp-set.js
WAIT_SEC=${WAIT_SEC:-60}

synced() { timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -qx yes; }

if synced; then
  echo "已同步（$(date '+%F %T')），无需处理"
  exit 0
fi

echo "未同步，开始处理（当前系统时间 $(date '+%F %T')）"

# 第一步：确保 NTP 打开并重启 timesyncd
timedatectl set-ntp true 2>/dev/null || true
systemctl restart systemd-timesyncd 2>/dev/null || true

i=0
while [ "$i" -lt "$WAIT_SEC" ]; do
  if synced; then
    echo "timesyncd 已同步，用时 ${i}s，现在 $(date '+%F %T')"
    exit 0
  fi
  i=$((i + 2))
  sleep 2
done

# 第二步：timesyncd 不行，直接走 SNTP 兜底
echo "timesyncd 等待 ${WAIT_SEC}s 仍未同步，改用 SNTP 直连兜底"
if [ -x "$NODE" ] && [ -f "$SNTP" ]; then
  "$NODE" "$SNTP" --apply
  rc=$?
  echo "SNTP 兜底退出码 $rc，现在 $(date '+%F %T')"
  # 时间对了之后再给 timesyncd 一次机会，让它接管后续的漂移校正
  systemctl restart systemd-timesyncd 2>/dev/null || true
  exit $rc
fi

echo "★ 兜底不可用：NODE=$NODE SNTP=$SNTP 缺失"
exit 1
