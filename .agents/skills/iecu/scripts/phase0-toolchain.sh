#!/bin/sh
# 阶段 0 补充：工具链盘点 + 根分区空间归因 + 厂商网络配置来源。全部只读。
echo "=== 1. 可执行的解释器/编译器 ==="
for c in python3 python3.8 python gcc cc g++ node perl make; do
  p=$(command -v "$c" 2>/dev/null)
  echo "  $c -> ${p:-（无）}"
done
echo "=== 2. python3.8 包是否已登记（对照 command -v，见陷阱 41）==="
dpkg -l 2>/dev/null | grep -E '^ii +python3' | head -5
echo "=== 3. python 二进制实际在不在 ==="
ls -la /usr/bin/python3* 2>/dev/null
ls /usr/lib/python3.8/os.py 2>/dev/null && echo "  标准库在"
echo "=== 4. CUDA 相关包 ==="
dpkg -l 2>/dev/null | grep -iE 'cuda|tensorrt|cudnn' | head -10
echo "=== 5. 驱动包版本（注意：这不是 CUDA API 版本）==="
cat /sys/module/nvidia/version 2>/dev/null
echo "=== 6. 根分区 3.6G 用在哪（前 12 大目录）==="
du -shx /* 2>/dev/null | sort -rh | head -12
echo "=== 7. 根分区挂载选项（是否只读）==="
mount | grep -E ' / | /etc | /var '
echo "=== 8. 完整 VLAN 子接口列表 ==="
ip -br a 2>/dev/null | wc -l
ip -4 a 2>/dev/null | grep -E 'inet ' | awk '{print $2, $NF}'
echo "=== 9. 厂商网络初始化脚本（<SITE2_IP> 从哪来）==="
ls -la /etc/systemd/scripts/tn_eth_init.sh 2>/dev/null
grep -nE '192\.168|ifconfig|ip addr' /etc/systemd/scripts/tn_eth_init.sh 2>/dev/null | head -20
echo "=== 10. 主路由表与策略路由（部署时只做加法）==="
ip route show 2>/dev/null
echo "--- rules ---"
ip rule show 2>/dev/null
echo "=== 11. 未挂载的块设备（对照红线 12 的 A/B 备份槽）==="
cat /proc/partitions 2>/dev/null
echo "=== 12. 现有 iptables 规则 ==="
iptables -S 2>/dev/null | head -20
echo "=== 13. 时间与 RTC ==="
date
timedatectl 2>/dev/null | head -6
ls /dev/rtc* 2>/dev/null || echo "  无 RTC 设备（与基线一致，必须联网校时）"
