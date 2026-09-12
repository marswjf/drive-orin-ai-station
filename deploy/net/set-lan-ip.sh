#!/bin/bash
# 给 eth.254 加局域网 IP，开机自动执行。
#
# 为什么单独做一个 unit 而不改厂商脚本：
#   厂商的 /etc/systemd/scripts/tn_eth_init.sh 用 ifconfig 硬编码 17 个 VLAN 的 IP。
#   改它一旦出错就会失去 SSH，而这块板子没有串口，失联=只能断电。
#   独立 unit 只做"加一个地址"，不动任何现有配置，失败也不影响原有的 172.31.254.38。
#
# 明确不做的事：不改默认路由。板子当前默认路由指向内部虚拟网关 __HYPERVISOR_GATEWAY__，
#   那是给 Hypervisor 内部通信用的；改成 __ROUTER_IP__ 可能影响跨 VM 服务。
#   板子不需要上网——所有文件都从 PC 经 SFTP 推。
set -u

IFACE=eth.254
ADDR=__BOARD_LAN_IP__/24

# 开机时 VLAN 子接口由 tn_eth_init.sh 创建，可能比本 unit 晚，等它出现
for i in $(seq 1 60); do
  ip link show "$IFACE" >/dev/null 2>&1 && break
  sleep 1
done

if ! ip link show "$IFACE" >/dev/null 2>&1; then
  echo "FATAL: $IFACE 60 秒内未出现，放弃（不影响原有 172.31.254.38）"
  exit 1
fi

if ip -4 addr show dev "$IFACE" | grep -q "${ADDR%/*}"; then
  echo "已存在 $ADDR on $IFACE，跳过"
else
  ip addr add "$ADDR" dev "$IFACE" && echo "已添加 $ADDR to $IFACE"
fi

ip -br -4 addr show dev "$IFACE"
