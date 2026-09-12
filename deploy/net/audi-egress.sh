#!/bin/sh
# 这块板出网 + 入站防线。全程只做加法（红线 3）：
#   main 表零改动、厂商 fwmark 0x12c → table 123 语义保留、172.31.254.38 不碰。
#
# 为什么需要它：厂商脚本 tn_eth_init.sh 里那段 WAN 改造是「先 DHCP，拿不到才回落静态」——
# 拿到 DHCP 时主表默认路由是对的（本单元此时是冗余但无害，网关相同）；
# 拿不到时回落 <SITE2_IP> + `default via <SITE2_GW>`，那个网关在现场多半不存在，
# 出网就断。红线 3 不许改主路由表的默认路由，于是沿用基线板 A-130 的
# 三条 ip rule 加法 + 独立路由表 100，让出网在两种情况下都成立。
#
# 三条规则各自的作用（顺序很重要）：
#   30480  复制厂商 fwmark 语义 —— 不加的话，带 fwmark 的厂商流量会被下面两条截走，行为被改变
#   30490  查 main 表但抑制默认路由（suppress_prefixlength 0）
#          → 所有具体路由（172.31.x.x / <SITE2_NET>.x / 192.168.1.x）照常生效
#   30500  前面都没命中才回落到表 100 的默认路由 → 出网走家网网关
#
# 用法: audi-egress.sh {start|stop|status}

DEV=eth
TABLE=100

# 网关不能写死。这块板的 tn_eth_init.sh 会先跑 dhclient，插到哪个网络就拿哪个网段的地址，
# 并把正确的默认路由写进主路由表；而本脚本的 30490 规则会抑制主表默认路由、强制走表 100。
# 所以表 100 的网关必须跟着实际网络走，否则板子一挪地方就出不了网。
# 探测顺序：① 主表现有的默认网关（dhclient 设的，最可信）② eth 各地址同网段的 .1
detect_gw() {
  for gw in $(ip route show | awk '/^default/ {print $3}' | sort -u); do
    case "$gw" in
      <SITE2_GW>) continue ;;   # 厂商静态回落用的网关，多半不在现场，放到最后再试
    esac
    if ping -c 1 -W 2 "$gw" >/dev/null 2>&1; then echo "$gw"; return 0; fi
  done
  for addr in $(ip -4 -o addr show dev "$DEV" | awk '{print $4}' | cut -d/ -f1); do
    cand=$(echo "$addr" | awk -F. '{print $1"."$2"."$3".1"}')
    if ping -c 1 -W 2 "$cand" >/dev/null 2>&1; then echo "$cand"; return 0; fi
  done
  # 兜底：厂商静态回落的网关
  if ping -c 1 -W 2 <SITE2_GW> >/dev/null 2>&1; then echo "<SITE2_GW>"; return 0; fi
  return 1
}

add_guard() {
  # 入站防线：非内网源的新连接一律丢弃。
  # 板子是 root + 弱口令 nvidia，出网一旦打通，路由器上任何指向它的历史端口转发
  # 都会把 SSH 直通公网，几小时必被爆破。这道防线是必需件，不是可选项。
  iptables -N IECU_GUARD 2>/dev/null
  iptables -F IECU_GUARD
  iptables -A IECU_GUARD -i lo -j RETURN
  iptables -A IECU_GUARD -s 127.0.0.0/8   -j RETURN
  # 整个 RFC1918 私有段都放行：板卡会接入不同网络（可能是另一个 192.168.x.x 网段或 10.x），
  # 只列 192.168.1/3 的话换网络后连本地都进不来。公网源仍然一律 DROP。
  iptables -A IECU_GUARD -s 10.0.0.0/8     -j RETURN
  iptables -A IECU_GUARD -s 172.16.0.0/12  -j RETURN
  iptables -A IECU_GUARD -s 192.168.0.0/16 -j RETURN
  iptables -A IECU_GUARD -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  iptables -A IECU_GUARD -m conntrack --ctstate NEW -j DROP
  # 挂到 INPUT 最前，且只挂一次
  iptables -C INPUT -j IECU_GUARD 2>/dev/null || iptables -I INPUT 1 -j IECU_GUARD
}

del_guard() {
  iptables -D INPUT -j IECU_GUARD 2>/dev/null
  iptables -F IECU_GUARD 2>/dev/null
  iptables -X IECU_GUARD 2>/dev/null
}

case "$1" in
  start)
    GW=$(detect_gw)
    if [ -z "${GW:-}" ]; then
      echo "探测不到可达网关，放弃（板子可能还没接上网线）"
      exit 1
    fi
    echo "探测到网关: $GW"
    ip route replace default via "$GW" dev "$DEV" table "$TABLE"
    ip rule del priority 30480 2>/dev/null
    ip rule del priority 30490 2>/dev/null
    ip rule del priority 30500 2>/dev/null
    ip rule add fwmark 0x12c lookup 123 priority 30480
    ip rule add from all lookup main suppress_prefixlength 0 priority 30490
    ip rule add from all lookup "$TABLE" priority 30500
    add_guard
    echo "出网已启用，网关 $GW，表 $TABLE；入站防线 IECU_GUARD 已挂"
    ;;
  stop)
    # 只撤自己加的，不碰厂商的 32765 规则
    ip rule del priority 30500 2>/dev/null
    ip rule del priority 30490 2>/dev/null
    ip rule del priority 30480 2>/dev/null
    ip route flush table "$TABLE" 2>/dev/null
    del_guard
    echo "已撤销本单元加的规则（厂商规则未动）"
    ;;
  status)
    echo "--- ip rule ---"
    ip rule show
    echo "--- table $TABLE ---"
    ip route show table "$TABLE"
    echo "--- main 表默认路由（DHCP 成功时是当前网段的网关，失败时是 <SITE2_GW>）---"
    ip route show | grep '^default'
    echo "--- 本单元当前探测到的网关 ---"
    detect_gw || echo "  探测不到"
    echo "--- IECU_GUARD ---"
    iptables -S IECU_GUARD 2>/dev/null || echo "  未安装"
    ;;
  *)
    echo "用法: $0 {start|stop|status}"
    exit 2
    ;;
esac
