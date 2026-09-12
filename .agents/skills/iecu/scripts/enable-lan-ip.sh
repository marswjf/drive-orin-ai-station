#!/bin/sh
# 启用局域网地址 unit 并验证。只做加法，不动厂商配置。
echo "=== 1. 加地址前的现状 ==="
ip -4 addr show dev eth | grep inet
echo "=== 2. daemon-reload + enable + start ==="
systemctl daemon-reload
systemctl enable iecu-lan-ip 2>&1
systemctl start iecu-lan-ip 2>&1
echo "=== 3. unit 状态 ==="
systemctl is-enabled iecu-lan-ip
systemctl is-active iecu-lan-ip
echo "=== 4. 加地址后 eth 上的全部地址 ==="
ip -4 addr show dev eth | grep inet
echo "=== 5. 确认厂商地址与救命通道都没被碰 ==="
ip -4 addr show dev eth | grep -q '<SITE2_IP>' && echo "  <SITE2_IP> 在 ✓" || echo "  ★ <SITE2_IP> 丢了"
ip -4 addr show dev eth.254 | grep -q '172.31.254.38' && echo "  172.31.254.38 在 ✓（救命通道）" || echo "  ★ 172.31.254.38 丢了"
ip -4 addr show dev eth | grep -q '__BOARD_LAN_IP__' && echo "  __BOARD_LAN_IP__ 已配上 ✓" || echo "  ★ __BOARD_LAN_IP__ 没配上"
echo "=== 6. 主路由表未被改动（默认路由应仍是 <SITE2_GW>）==="
ip route show | head -3
echo "=== 7. 厂商 ip rule 未动 ==="
ip rule show | grep 0x12c
