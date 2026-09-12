#!/bin/sh
# 查清 NTP 为什么重启后没自启，再修。板子没有 RTC，不持续校准就会漂移。
set -u

echo "=== 1. 现状 ==="
date
timedatectl 2>/dev/null

echo
echo "=== 2. systemd-timesyncd 的 enable/active 状态 ==="
systemctl is-enabled systemd-timesyncd 2>&1
systemctl is-active systemd-timesyncd 2>&1
echo "--- 是否被 mask ---"
ls -l /etc/systemd/system/systemd-timesyncd.service 2>/dev/null || echo "  未被 mask 覆盖"

echo
echo "=== 3. 配置文件还在不在（我们写的阿里云源）==="
cat /etc/systemd/timesyncd.conf 2>/dev/null | grep -vE '^#|^$'

echo
echo "=== 4. 它的日志（看是启动失败还是根本没启动）==="
journalctl -u systemd-timesyncd -n 20 --no-pager 2>/dev/null | tail -20

echo
echo "=== 5. 厂商的 nv_timesync 在干什么（可能抢时钟）==="
systemctl is-enabled nv_timesync 2>&1
systemctl is-active nv_timesync 2>&1
systemctl cat nv_timesync 2>/dev/null | grep -E 'ExecStart|Description' | head -4
echo "--- 它的日志 ---"
journalctl -u nv_timesync -n 8 --no-pager 2>/dev/null | tail -8
echo "--- 是否有 PTP 设备（车载 gPTP 时间同步）---"
ls /dev/ptp* 2>/dev/null || echo "  无 /dev/ptp*"

echo
echo "=== 6. 修复：enable + start ==="
timedatectl set-ntp true 2>&1
systemctl enable systemd-timesyncd 2>&1 | tail -2
systemctl restart systemd-timesyncd 2>&1
echo "--- 等 10 秒 ---"
sleep 10
systemctl is-enabled systemd-timesyncd
systemctl is-active systemd-timesyncd
timedatectl 2>/dev/null | grep -E 'Local time|synchronized|NTP service'

echo
echo "=== 7. 同步日志确认 ==="
journalctl -u systemd-timesyncd -n 10 --no-pager 2>/dev/null | tail -10

echo
echo "=== 8. 确认 enable 落在持久层（/etc 是 overlay，实体在 /persistent）==="
ls -l /etc/systemd/system/sysinit.target.wants/systemd-timesyncd.service 2>/dev/null \
  || ls -l /etc/systemd/system/*.wants/systemd-timesyncd.service 2>/dev/null \
  || echo "  ★ 找不到 enable 的 symlink，重启可能还是不启动"
find /persistent -name 'systemd-timesyncd.service' 2>/dev/null | head -3
sync
