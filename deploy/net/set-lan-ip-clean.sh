#!/bin/bash
# 给 eth.254 加局域网 IP，开机自动执行。
#
# 【这份和 set-lan-ip.sh 的区别】
# 2026-09-01 为出售的批次A制作，把单一地址改成地址列表，同时挂两个：
#   __BOARD_LAN_IP__/24   原有地址，保持不变
#   192.168.0.201/24  新增的固定地址，覆盖另一类常见家用网段
# 两个都无条件添加，不依赖网关探测，也不依赖 DHCP——买家的路由器无论
# 发在哪一段，板子都有一个能直接访问的固定地址。
#
# 为什么单独做一个 unit 而不改厂商脚本：
#   厂商的 /etc/systemd/scripts/tn_eth_init.sh 用 ifconfig 硬编码 17 个 VLAN 的 IP。
#   改它一旦出错就会失去 SSH，而这块板子没有串口，失联=只能断电。
#   独立 unit 只做"加地址"，不动任何现有配置，失败也不影响 172.31.254.38。
#
# 明确不做的事：不改默认路由，不删任何已有地址。
set -u

IFACE=eth.254
ADDRS="__BOARD_LAN_IP__/24 192.168.0.201/24"

# 开机时 VLAN 子接口由 tn_eth_init.sh 创建，可能比本 unit 晚，等它出现
for i in $(seq 1 60); do
  ip link show "$IFACE" >/dev/null 2>&1 && break
  sleep 1
done

if ! ip link show "$IFACE" >/dev/null 2>&1; then
  echo "FATAL: $IFACE 60 秒内未出现，放弃（不影响原有 172.31.254.38）"
  exit 1
fi

for A in $ADDRS; do
  if ip -4 addr show dev "$IFACE" | grep -q " ${A%/*}/"; then
    echo "已存在 $A on $IFACE，跳过"
  else
    ip addr add "$A" dev "$IFACE" && echo "已添加 $A to $IFACE"
  fi
done

ip -br -4 addr show dev "$IFACE"
