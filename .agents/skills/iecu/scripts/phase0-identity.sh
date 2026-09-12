#!/bin/sh
# iecu-provision 阶段 0：新板身份核对。五项与基线不一致就不能直接用 baseline/ 的编译产物。
echo "=== 1. 板号（期望 p3663-XXXX）==="
cat /proc/device-tree/model 2>/dev/null | tr -d '\0'; echo
echo "=== 2. cmdline 关键项 ==="
cat /proc/cmdline | tr ' ' '\n' | grep -E 'root=|board_name|aurixfw|isolcpus'
echo "=== 3. DRIVE OS（期望 6.0.9.0-1）==="
dpkg -l 2>/dev/null | grep nv-driveos-linux | head -5
echo "=== 4. glibc（期望 2.31）==="
ldd --version 2>&1 | head -1
echo "=== 5. 内核（期望 5.15.116-rt-tegra）==="
uname -a
echo "=== 6. 发行版 ==="
cat /etc/os-release 2>/dev/null | head -4
echo "=== 7. 网络接口 ==="
ip -br a 2>/dev/null
echo "=== 8. 内存 ==="
free -m 2>/dev/null | head -3
echo "=== 9. 磁盘 ==="
df -h 2>/dev/null | grep -vE '^tmpfs|^devtmpfs'
echo "=== 10. GPU/NV 设备节点数 ==="
ls /dev/nv* 2>/dev/null | wc -l
echo "=== 11. libcuda 位置 ==="
ldconfig -p 2>/dev/null | grep -i 'libcuda\.so' | head -3
echo "=== 12. 是否有 tegra_hv（Hypervisor 判据）==="
lsmod 2>/dev/null | grep -c tegra_hv
echo "=== 13. 智驾栈 unit 状态 ==="
systemctl is-enabled application_start 2>/dev/null
systemctl is-active application_start 2>/dev/null
echo "=== 14. 已开监听端口 ==="
ss -lntu 2>/dev/null | head -20
