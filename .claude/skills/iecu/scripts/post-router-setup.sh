#!/bin/sh
# 板子接到家网路由器之后执行：出网 → 校时 → 探测挂 NAS 的能力。
# 每步独立打印结果，前一步失败不中断后面的诊断。

echo "############ 1. 接入确认 ############"
ip -4 addr show dev eth | grep inet
echo "--- 家网网关是否可达 ---"
if ip route get __ROUTER_IP__ >/dev/null 2>&1; then
  echo "  路由可解析 ✓"
else
  echo "  ★ __ROUTER_IP__ 路由不可解析"
fi
ping -c 2 -W 2 __ROUTER_IP__ >/dev/null 2>&1 && echo "  ping 网关通 ✓" || echo "  ★ ping 网关不通"
ping -c 2 -W 2 __NAS_IP__ >/dev/null 2>&1 && echo "  ping NAS 通 ✓" || echo "  ★ ping NAS 不通"

echo
echo "############ 2. 启用出网 ############"
systemctl daemon-reload
systemctl enable iecu-egress-audi 2>&1
systemctl start iecu-egress-audi 2>&1
echo "--- unit 状态 ---"
systemctl is-enabled iecu-egress-audi
systemctl is-active iecu-egress-audi
echo "--- 规则现状 ---"
/var/lib/llm/net/audi-egress.sh status

echo
echo "############ 3. 出网验证 ############"
echo "--- DNS 解析（glibc，不依赖 curl）---"
getent hosts ntp.aliyun.com  && echo "  DNS ✓" || echo "  ★ DNS 失败"
getent hosts modelscope.cn   >/dev/null 2>&1 && echo "  modelscope 可解析 ✓" || echo "  ★ modelscope 解析失败"
echo "--- 外网 TCP 连通（用 /dev/tcp 不行，改用 nc/ping）---"
ping -c 2 -W 3 223.5.5.5 >/dev/null 2>&1 && echo "  ping 223.5.5.5 通 ✓" || echo "  ★ ping 公网 DNS 不通"
command -v nc >/dev/null 2>&1 && { nc -z -w 4 modelscope.cn 443 && echo "  TCP 443 到 modelscope 通 ✓" || echo "  ★ TCP 443 不通"; } || echo "  （板上无 nc，跳过 TCP 测试）"
echo "--- 主路由表确认仍未被改 ---"
ip route show | grep '^default'

echo
echo "############ 4. 校时 ############"
echo "--- 改之前 ---"
date
timedatectl 2>/dev/null | grep -E 'Time zone|synchronized|NTP service'
timedatectl set-timezone Asia/Shanghai 2>&1
cat > /etc/systemd/timesyncd.conf <<'TSCONF'
[Time]
NTP=ntp.aliyun.com ntp1.aliyun.com ntp2.aliyun.com
FallbackNTP=cn.pool.ntp.org time.windows.com
TSCONF
systemctl restart systemd-timesyncd 2>&1
timedatectl set-ntp true 2>&1
echo "--- 等 8 秒让它同步 ---"
sleep 8
echo "--- 改之后 ---"
date
timedatectl 2>/dev/null | grep -E 'Local time|Time zone|synchronized|NTP service'
echo "--- timesyncd 日志 ---"
journalctl -u systemd-timesyncd -n 8 --no-pager 2>/dev/null | tail -8

echo
echo "############ 5. 挂 NAS 的能力探测（决定备份走哪条路）############"
echo "--- NFS 客户端 ---"
ls /sbin/mount.nfs /usr/sbin/mount.nfs 2>/dev/null || echo "  无 mount.nfs"
grep -qw nfs /proc/filesystems && echo "  内核支持 nfs ✓" || { modprobe nfs 2>/dev/null && grep -qw nfs /proc/filesystems && echo "  nfs 模块加载成功 ✓" || echo "  ★ 内核不支持 nfs"; }
echo "--- CIFS/SMB 客户端 ---"
ls /sbin/mount.cifs /usr/sbin/mount.cifs 2>/dev/null || echo "  无 mount.cifs"
grep -qw cifs /proc/filesystems && echo "  内核支持 cifs ✓" || { modprobe cifs 2>/dev/null && grep -qw cifs /proc/filesystems && echo "  cifs 模块加载成功 ✓" || echo "  ★ 内核不支持 cifs"; }
echo "--- NAS 的 NFS 导出列表 ---"
command -v showmount >/dev/null 2>&1 && showmount -e __NAS_IP__ 2>&1 | head -20 || echo "  板上无 showmount，无法列举导出"
echo "--- rpcbind 在跑（NFS 需要）---"
systemctl is-active rpcbind 2>/dev/null

echo
echo "############ 完成 ############"
