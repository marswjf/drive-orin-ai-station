#!/bin/bash
# 识别板子当前接在哪个局域网，并为 frpc 单独开一条出网通道。
#
# 【为什么这么做】
# 板子的默认路由指向 Hypervisor 内部虚拟网关（default via __HYPERVISOR_GATEWAY__ dev eth.8），
# 所以它既收不到公网转发进来的连接（回包出不去），自己也上不了外网。
# 但只要 frpc 能主动连出去，反向隧道就能把面板送到公网——回包走既有连接，不查路由表。
# 2026-08-14 起新增「全局出网」段（见下），root/pip/git 也能出网了；
# 主路由表与厂商规则仍然一个字节不动，见该段注释。
#
# 【为什么不改默认路由】
# 主路由表里那条 default 是厂商配的，还有一条 fwmark 0x12c → table 123 的规则在用。
# 动它们等于拿唯一的入口打赌，而这块板子没有串口。
# 所以这里用 uidrange 规则：只有 frpc 那个 uid 的流量走新表，
# 系统其它任何进程、任何地址、任何既有规则都不受影响。爆炸半径 = 一个进程。
#
# 【安全性】
# 全程只做"增加"：新增一个路由表、一条 ip rule、可能新增一个 IP 地址。
# 172.31.254.38（直连网线的救命地址）和 __BOARD_LAN_IP__ 都不会被删。
# 探测失败就什么都不做、正常退出——最坏结果是 frpc 连不上，board 本身照常。
set -u

TABLE=100
RULE_PRIO=30000
TIME_PRIO=30001
TIME_USER=systemd-timesync
IFACE=eth.254
CFG=/var/lib/llm/config.json
NODE=/var/lib/llm/bin/node
FRP_USER=iecufrp
ENVOUT=/run/iecu-site.env
FRPC_TOML=/var/lib/llm/frp/frpc.toml
TOKEN_FILE=/var/lib/llm/frp/token

log() { echo "[site-egress] $*"; }

# ── 读站点表。发布版默认空，不填就不改网络、不建隧道 ──────────────────
# 每项的 panelRemotePort 是 frps 内部面板端口；公开版故意不生成 SSH 代理。
read_sites() {
  "$NODE" -e '
    const c = require(process.argv[1]);
    const sites = Array.isArray(c.sites) ? c.sites : [];
    for (const s of sites) {
      if (!s.name || !s.addr || !s.gw || !s.frps) continue;
      const panelName = s.panelProxyName || "iecu-panel";
      const panelPort = Number(s.panelRemotePort) || 0;
      process.stdout.write([s.name, s.addr, s.cidr || 24, s.gw, s.frps, s.frpsPort || 7000, panelName, panelPort].join("|") + "\n");
    }
  ' "$CFG" 2>/dev/null
}

FRP_UID=$(id -u "$FRP_USER" 2>/dev/null)
if [ -z "$FRP_UID" ]; then
  log "用户 $FRP_USER 不存在，先建它（frpc 以它的身份运行，规则按 uid 匹配）"
  useradd -r -M -s /usr/sbin/nologin "$FRP_USER" && FRP_UID=$(id -u "$FRP_USER")
  [ -z "$FRP_UID" ] && { log "建用户失败，放弃（不影响现有网络）"; exit 0; }
fi
log "frpc 运行身份 $FRP_USER (uid $FRP_UID)"

# ── 探测在哪个站点 ────────────────────────────────────────────────
# 开机时交换机可能还没协商完，探测会假失败，所以要多轮重试。
# 本脚本还由 iecu-egress.timer 每 5 分钟复跑一次，
# 这样换了网络（比如从家里搬到单位）不用手动干预，插上等一会儿就好。
ROUNDS=${SITE_PROBE_ROUNDS:-3}
CHOSEN=""
for round in $(seq 1 "$ROUNDS"); do
  while IFS='|' read -r NAME ADDR CIDR GW FRPS FRPSPORT PANELNAME PANELPORT; do
    [ -z "${NAME:-}" ] && continue
    ADDED=0
    if ! ip -4 addr show dev "$IFACE" | grep -q " ${ADDR}/"; then
      ip addr add "${ADDR}/${CIDR}" dev "$IFACE" 2>/dev/null && ADDED=1
    fi
    if ping -c 1 -W 1 -I "$ADDR" "$GW" >/dev/null 2>&1; then
      log "识别为「${NAME}」：本机 $ADDR，网关 $GW 可达"
      CHOSEN="${NAME}|${ADDR}|${CIDR}|${GW}|${FRPS}|${FRPSPORT}|${PANELNAME}|${PANELPORT}"
      break
    fi
    # 只回收本次自己加的地址，绝不动原本就存在的（尤其 __BOARD_LAN_IP__）
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

IFS='|' read -r NAME ADDR CIDR GW FRPS FRPSPORT PANELNAME PANELPORT <<EOF
$CHOSEN
EOF
NET=$(echo "$ADDR" | cut -d. -f1-3).0/${CIDR}
PREV_SITE=$(grep '^IECU_SITE=' "$ENVOUT" 2>/dev/null | cut -d= -f2-)

# ── 建出网表（只给 frpc 用）────────────────────────────────────────
# 定时器每 5 分钟会跑一次，所以先看看是不是已经是想要的样子，
# 一样就别动——反复删加规则没必要，也可能打断正在建立的连接。
WANT="default via $GW dev $IFACE src $ADDR"
HAVE=$(ip route show table "$TABLE" 2>/dev/null | grep '^default' | sed 's/  */ /g' | sed 's/ *$//')
HAVE_RULE=$(ip rule show | grep -c "uidrange ${FRP_UID}-${FRP_UID} lookup ${TABLE}")

if [ "$HAVE" = "$WANT" ] && [ "$HAVE_RULE" -ge 1 ]; then
  log "出网通道已是当前站点的配置，无需改动"
else
  ip route replace "$NET" dev "$IFACE" src "$ADDR" table "$TABLE"
  ip route replace default via "$GW" dev "$IFACE" src "$ADDR" table "$TABLE"
  # 幂等：先删可能残留的同优先级规则，再加
  while ip rule show | grep -q "^${RULE_PRIO}:"; do
    ip rule del priority "$RULE_PRIO" 2>/dev/null || break
  done
  ip rule add uidrange "${FRP_UID}-${FRP_UID}" lookup "$TABLE" priority "$RULE_PRIO"
  log "出网表 $TABLE 已就绪：$WANT"
  log "规则：uid $FRP_UID 的流量走表 $TABLE，其它一切照旧"
fi

# ── 对时也放行一个 uid ────────────────────────────────────────────
# 这块板子没有 RTC（/dev/rtc* 不存在，hwclock 读不到），每次开机时钟从一个
# 固定基准往前走，实测跑出过近三个月的偏差，日志时间线因此完全不可用。
# systemd-timesyncd 已经 enabled，缺的只是一条出网路径——同样用 uidrange 放行，
# 依旧不碰主路由表。失败了只是时间不准，不影响其它任何东西。
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

# ── 全局出网（2026-08-14 起默认开启；config.json 写 "generalEgress": false 可关）──
# 三条规则全是加法，主路由表与厂商规则一个字节不动（实测见 A-130）：
#   30480  把厂商 fwmark 语义复制到更高优先级。厂商原规则在 32765、排在下面两条
#          之后，不复制的话被标记的流量会被 30490/30500 抢走。复制的只是语义
#          （fwmark 0x12c → 表 123），厂商那条原封不动。
#   30490  查主路由表但抑制默认路由（suppress_prefixlength 0）：内网/厂商网段
#          照常命中主表明细路由，唯独"只能靠默认路由兜底"的公网目标穿透到下一条
#          ——一个网段都不用枚举。
#   30500  公网目标回落到表 $TABLE（站点网关）。从此 root/pip/git 都能出网。
# ★ 入站防线 IECU_GUARD 必须先于出网规则挂好：出网一通，公网 DNAT 的回程也通了，
#   路由器上任何指向本机的历史端口转发都会复活（root+弱口令扛不住爆破）。
#   防线 = 非内网源地址的新入站一律丢弃；局域网(192.168/16)、直连(172.16/12)、
#   隧道与 frp(127.0.0.1) 全在放行名单里，公网入口照旧只走 LXC 的 Caddy。
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
  log "generalEgress=false：全局出网已关闭，仅保留 frpc/对时的 uid 通道"
fi

# ── 生成 frpc 配置 ────────────────────────────────────────────────
TOKEN=$(cat "$TOKEN_FILE" 2>/dev/null)
if [ -z "$TOKEN" ]; then
  log "缺少 $TOKEN_FILE，跳过生成 frpc 配置"
else
  mkdir -p "$(dirname "$FRPC_TOML")"
  cat > "$FRPC_TOML" <<TOML
# 本文件由 site-egress.sh 自动生成，手改会在下次开机被覆盖。
# 当前站点：${NAME}
serverAddr = "${FRPS}"
serverPort = ${FRPSPORT}

auth.method = "token"
auth.token = "${TOKEN}"

# 家里是动态公网 IP，每次重连都会重新解析域名，所以换 IP 不用管。
# DNS 走 /etc/resolv.conf（已经是公网 DNS），查询同样由 uid 规则送出去。
transport.dialServerTimeout = 10
transport.heartbeatInterval = 20
transport.heartbeatTimeout = 90
transport.tcpMux = true
transport.poolCount = 1

# 连不上不要退出，一直重试——板子可能比路由器先开机
loginFailExit = false

log.to = "console"
log.level = "info"

[[proxies]]
name = "${PANELNAME}"
type = "tcp"
localIP = "127.0.0.1"
localPort = 9000
remotePort = ${PANELPORT}
TOML
  chmod 600 "$FRPC_TOML"
  chown "$FRP_USER" "$FRPC_TOML" 2>/dev/null
  log "已生成 $FRPC_TOML，隧道服务端 ${FRPS}:${FRPSPORT}"
fi

cat > "$ENVOUT" <<ENV
IECU_SITE=${NAME}
IECU_ADDR=${ADDR}
IECU_GW=${GW}
IECU_FRPS=${FRPS}:${FRPSPORT}
ENV

# 换了地方（比如从家里搬到单位）：隧道服务端地址变了，frpc 得重来一次
if [ -n "$PREV_SITE" ] && [ "$PREV_SITE" != "$NAME" ]; then
  log "站点从「${PREV_SITE}」变成「${NAME}」，重启 frpc 让它连新的服务端"
  systemctl try-restart iecu-frpc 2>/dev/null
fi

ip -4 addr show dev "$IFACE" | grep inet
ip route show table "$TABLE"
