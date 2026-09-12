#!/bin/bash
# 识别板子当前接在哪个局域网，并建立出网通道与入站防线。
#
# 【这份和 site-egress.sh 的区别】
# 这是「交付第三方」用的脱敏版本，2026-09-01 为出售的批次A（__BOARD_LAN_IP__）制作。
# 相对原版删掉了三样东西，其余逐行相同：
#   1. 反向隧道（frpc）的全部内容——配置生成、iecufrp 用户与它的 uid 路由规则、
#      换站点时重启 frpc 的逻辑。板子交付后不再连任何隧道服务端。
#   2. 站点表里的隧道服务端地址与域名。站点表只剩地址、掩码、网关三项。
#   3. /run/iecu-site.env 里的 IECU_FRPS 一行。
# 保留的是对买家真正有用的三样：站点自动识别、全局出网、入站防线 IECU_GUARD。
#
# 【为什么不改默认路由】
# 主路由表里那条 default 是厂商配的，还有一条 fwmark 0x12c → table 123 的规则在用。
# 动它们等于拿唯一的入口打赌，而这块板子没有串口。
#
# 【安全性】
# 全程只做"增加"：新增一个路由表、若干条 ip rule、可能新增一个 IP 地址。
# 172.31.254.38（直连网线的救命地址）和已存在的局域网地址都不会被删。
# 探测失败就什么都不做、正常退出——最坏结果是不能上外网，板子本身照常。
set -u

TABLE=100
TIME_PRIO=30001
TIME_USER=systemd-timesync
IFACE=eth.254
CFG=/var/lib/llm/config.json
NODE=/var/lib/llm/bin/node
ENVOUT=/run/iecu-site.env

log() { echo "[site-egress] $*"; }

# ── 读站点表。放在 config.json 里，换地方只改配置不改代码 ──────────
read_sites() {
  "$NODE" -e '
    const c = require(process.argv[1]);
    const d = [
      { name: "网段 192.168.1.x", addr: "__BOARD_LAN_IP__",  cidr: 24, gw: "__ROUTER_IP__" },
      { name: "网段 192.168.0.x", addr: "192.168.0.201", cidr: 24, gw: "192.168.0.1" },
    ];
    const sites = Array.isArray(c.sites) && c.sites.length ? c.sites : d;
    for (const s of sites) {
      process.stdout.write([s.name, s.addr, s.cidr || 24, s.gw].join("|") + "\n");
    }
  ' "$CFG" 2>/dev/null
}

# ── 探测在哪个站点 ────────────────────────────────────────────────
# 开机时交换机可能还没协商完，探测会假失败，所以要多轮重试。
# 本脚本还由 iecu-egress.timer 每 5 分钟复跑一次，
# 换了网络不用手动干预，插上等一会儿就好。
ROUNDS=${SITE_PROBE_ROUNDS:-3}
CHOSEN=""
for round in $(seq 1 "$ROUNDS"); do
  while IFS='|' read -r NAME ADDR CIDR GW; do
    [ -z "${NAME:-}" ] && continue
    ADDED=0
    if ! ip -4 addr show dev "$IFACE" | grep -q " ${ADDR}/"; then
      ip addr add "${ADDR}/${CIDR}" dev "$IFACE" 2>/dev/null && ADDED=1
    fi
    if ping -c 1 -W 1 -I "$ADDR" "$GW" >/dev/null 2>&1; then
      log "识别为「${NAME}」：本机 $ADDR，网关 $GW 可达"
      CHOSEN="${NAME}|${ADDR}|${CIDR}|${GW}"
      break
    fi
    # 只回收本次自己加的地址，绝不动原本就存在的
    [ "$ADDED" = "1" ] && ip addr del "${ADDR}/${CIDR}" dev "$IFACE" 2>/dev/null
    [ "$round" = "1" ] && log "「${NAME}」不通（网关 $GW 无响应）"
  done <<EOF
$(read_sites)
EOF
  [ -n "$CHOSEN" ] && break
  [ "$round" -lt "$ROUNDS" ] && { log "第 ${round} 轮都没通，5 秒后重试"; sleep 5; }
done

if [ -z "$CHOSEN" ]; then
  log "没有匹配到任何已知站点，不做任何改动。板子本身与局域网访问不受影响。"
  log "（定时器每 5 分钟会再试一次；换了网络插上等一会儿即可）"
  exit 0
fi

IFS='|' read -r NAME ADDR CIDR GW <<EOF
$CHOSEN
EOF
NET=$(echo "$ADDR" | cut -d. -f1-3).0/${CIDR}

# ── 建出网表 ──────────────────────────────────────────────────────
# 定时器每 5 分钟会跑一次，所以先看看是不是已经是想要的样子，
# 一样就别动——反复删加规则没必要，也可能打断正在建立的连接。
WANT="default via $GW dev $IFACE src $ADDR"
HAVE=$(ip route show table "$TABLE" 2>/dev/null | grep '^default' | sed 's/  */ /g' | sed 's/ *$//')

if [ "$HAVE" = "$WANT" ]; then
  log "出网表已是当前站点的配置，无需改动"
else
  ip route replace "$NET" dev "$IFACE" src "$ADDR" table "$TABLE"
  ip route replace default via "$GW" dev "$IFACE" src "$ADDR" table "$TABLE"
  log "出网表 $TABLE 已就绪：$WANT"
fi

# ── 对时放行一个 uid ──────────────────────────────────────────────
# 这块板子没有 RTC（/dev/rtc* 不存在，hwclock 读不到），每次开机时钟从一个
# 固定基准往前走，实测跑出过近三个月的偏差，日志时间线因此完全不可用。
# systemd-timesyncd 已经 enabled，缺的只是一条出网路径——用 uidrange 放行，
# 不碰主路由表。失败了只是时间不准，不影响其它任何东西。
TIME_UID=$(id -u "$TIME_USER" 2>/dev/null)
if [ -z "$TIME_UID" ]; then
  log "没有 $TIME_USER 这个用户，跳过对时通道"
elif ip rule show | grep -q "uidrange ${TIME_UID}-${TIME_UID} lookup ${TABLE}"; then
  log "对时通道已就绪（uid $TIME_UID）"
else
  while ip rule show | grep -q "^${TIME_PRIO}:"; do
    ip rule del priority "$TIME_PRIO" 2>/dev/null || break
  done
  ip rule add uidrange "${TIME_UID}-${TIME_UID}" lookup "$TABLE" priority "$TIME_PRIO"
  log "规则：uid $TIME_UID（$TIME_USER）的流量走表 $TABLE，用于 NTP 校时"
fi

# ── 全局出网（config.json 写 "generalEgress": false 可关）───────────
# 三条规则全是加法，主路由表与厂商规则一个字节不动（实测见 A-130）：
#   30480  把厂商 fwmark 语义复制到更高优先级。厂商原规则在 32765、排在下面两条
#          之后，不复制的话被标记的流量会被 30490/30500 抢走。复制的只是语义
#          （fwmark 0x12c → 表 123），厂商那条原封不动。
#   30490  查主路由表但抑制默认路由（suppress_prefixlength 0）：内网/厂商网段
#          照常命中主表明细路由，唯独"只能靠默认路由兜底"的公网目标穿透到下一条。
#   30500  公网目标回落到表 $TABLE（站点网关）。
# ★ 入站防线 IECU_GUARD 必须先于出网规则挂好：出网一通，公网 DNAT 的回程也通了，
#   路由器上任何指向本机的历史端口转发都会复活（root 弱口令扛不住爆破）。
#   防线 = 非内网源地址的新入站一律丢弃。
GENERAL_EGRESS=$("$NODE" -e 'const c=require(process.argv[1]);process.stdout.write(String(c.generalEgress!==false));' "$CFG" 2>/dev/null)
[ -z "$GENERAL_EGRESS" ] && GENERAL_EGRESS=true
if [ "$GENERAL_EGRESS" = "true" ]; then
  if ! iptables -C INPUT -j IECU_GUARD 2>/dev/null; then
    iptables -N IECU_GUARD 2>/dev/null || iptables -F IECU_GUARD
    iptables -A IECU_GUARD -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN 2>/dev/null \
      || iptables -A IECU_GUARD -m state --state ESTABLISHED,RELATED -j RETURN
    iptables -A IECU_GUARD -i lo -j RETURN
    iptables -A IECU_GUARD -s 192.168.0.0/16 -j RETURN
    iptables -A IECU_GUARD -s 172.16.0.0/12 -j RETURN
    iptables -A IECU_GUARD -s 10.0.0.0/8 -j RETURN
    iptables -A IECU_GUARD -s 127.0.0.0/8 -j RETURN
    iptables -A IECU_GUARD -j DROP
    iptables -I INPUT 1 -j IECU_GUARD
    log "入站防线 IECU_GUARD 已挂载（非内网源的新入站一律丢弃）"
  fi
  ip rule show | grep -q '^30480:' || ip rule add fwmark 0x12c lookup 123 priority 30480
  ip rule show | grep -q '^30490:' || ip rule add priority 30490 lookup main suppress_prefixlength 0
  ip rule show | grep -q '^30500:' || ip rule add priority 30500 lookup "$TABLE"
  log "全局出网已就绪：公网目标走表 $TABLE（$GW），内网与厂商路由不变"
else
  # 显式关闭时撤掉本段自己加的东西（三条规则 + 防线），其余一概不动
  for p in 30480 30490 30500; do
    while ip rule show | grep -q "^$p:"; do ip rule del priority "$p" 2>/dev/null || break; done
  done
  if iptables -C INPUT -j IECU_GUARD 2>/dev/null; then
    iptables -D INPUT -j IECU_GUARD; iptables -F IECU_GUARD; iptables -X IECU_GUARD
  fi
  log "generalEgress=false：全局出网已关闭，仅保留对时的 uid 通道"
fi

cat > "$ENVOUT" <<ENV
IECU_SITE=${NAME}
IECU_ADDR=${ADDR}
IECU_GW=${GW}
ENV

ip -4 addr show dev "$IFACE" | grep inet
ip route show table "$TABLE"
