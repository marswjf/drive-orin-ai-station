#!/bin/sh
# 阶段 0 验证：确认三件不能靠推断的事——接口 ARP 标志、rp_filter、块设备真实挂载。只读。
echo "=== 1. 母接口与诊断子接口的 flags（NOARP 在不在）==="
ip link show eth 2>/dev/null
ip link show eth.254 2>/dev/null
ip link show eth.251 2>/dev/null
echo "=== 2. rp_filter（解释 untagged 时 ARP 通但 TCP 不通）==="
sysctl net.ipv4.conf.all.rp_filter net.ipv4.conf.default.rp_filter 2>/dev/null
sysctl net.ipv4.conf.eth.rp_filter 2>/dev/null
sysctl "net.ipv4.conf.eth/254.rp_filter" 2>/dev/null
echo "=== 3. arp_ignore / arp_announce（解释跨接口 ARP 应答）==="
sysctl net.ipv4.conf.all.arp_ignore net.ipv4.conf.all.arp_announce 2>/dev/null
sysctl net.ipv4.conf.eth.arp_ignore 2>/dev/null
echo "=== 4. 全部块设备的真实挂载点（df 会隐藏同设备多挂载）==="
grep vblkdev /proc/mounts
echo "=== 5. vblkdev23（基线的 /opt/m0，26G）挂了没 ==="
grep -q vblkdev23 /proc/mounts && echo "  已挂载" || echo "  ★ 未挂载"
echo "=== 6. /opt 目录结构 ==="
ls -la /opt/
echo "=== 7. /opt/other 存在吗（/var overlay 的 upperdir 宿主）==="
ls -la /opt/other/ 2>/dev/null || echo "  /opt/other 不存在"
echo "=== 8. 全部网络接口与 MTU ==="
ip -br link 2>/dev/null
echo "=== 9. 有没有 eth.3 / eth.4（基线的感知域 VLAN）==="
ls /sys/class/net/ | tr '\n' ' '; echo
echo "=== 10. TensorRT / DriveWorks 版本 ==="
dpkg -l 2>/dev/null | grep -iE 'tensorrt|driveworks|nvinfer|libnvinfer' | head -6
echo "=== 11. 智驾栈进程数（应为 0）==="
ps -ef 2>/dev/null | grep -cE 'mfrlaunch|execution-man|routingmanager'
echo "=== 12. 平台服务是否在跑 ==="
systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | awk '{print $1}' | head -25
echo "=== 13. failed units ==="
systemctl list-units --state=failed --no-pager --no-legend 2>/dev/null
echo "=== 14. /eol 是什么（基线没记录）==="
ls -la /eol/ 2>/dev/null | head -8
echo "=== 15. SELinux ==="
getenforce 2>/dev/null
