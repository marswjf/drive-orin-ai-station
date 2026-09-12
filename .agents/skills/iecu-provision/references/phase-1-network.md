# 阶段 1 — 网络：局域网地址、出网、入站防线、对时

目标：板子插上普通网线就能用，root 能直接 `pip install`，同时不把 SSH 暴露给公网。

**贯穿这一阶段的唯一原则：只做加法。**

---

## 1.1 出厂网络长什么样

物理口 `eth` 上配置了十六个 VLAN 子接口：

```
eth.3 eth.4 eth.5 eth.7 eth.8 eth.9 eth.32 eth.42 eth.68 eth.129
eth.200 eth.250 eth.251 eth.252 eth.253 eth.254
```

每个都是 `172.31.<vlan>.38/24`。主路由表的默认路由是：

```
default via __HYPERVISOR_GATEWAY__ dev eth.8
```

**这条指向 Hypervisor 内部虚拟网络，出不去外网，也没有回程。**
厂商还有一条策略路由 `fwmark 0x12c → table 123`，那是智驾栈自己的通道。

**这三样（主表默认路由、厂商 fwmark 规则、`172.31.254.38` 地址）一个都不能动。**

---

## 1.2 加局域网地址

在 `eth.254` 上**追加**一个局域网地址，不替换原有的：

```bash
ip addr add __BOARD_LAN_IP__/24 dev eth.254
```

做成 unit（`iecu-lan-ip.service`，脚本 `/var/lib/llm/net/set-lan-ip.sh`）开机自动加。
地址按站点选——脚本支持多站点识别，配置在 `config.json` 的 `sites` 段。

完成后 `eth.254` 上同时有两个地址，救命通道不受影响：

```
eth.254@eth  UP  172.31.254.38/24 __BOARD_LAN_IP__/24
```

---

## 1.3 全局出网：三条加法规则

这是整个网络部分最关键的设计。板子默认出不了网，而 `pip`、`git`、模型下载都需要。

```bash
# 独立路由表 100：走局域网网关
ip route add default via __ROUTER_IP__ dev eth.254 src __BOARD_LAN_IP__ table 100
ip route add 192.168.1.0/24 dev eth.254 scope link src __BOARD_LAN_IP__ table 100

# 三条规则，优先级都在厂商规则之前，但语义上不覆盖它
ip rule add pref 30480 fwmark 0x12c table 123      # 复制厂商语义，保证智驾栈不受影响
ip rule add pref 30490 table main suppress_prefixlength 0   # 主表里除默认路由外照常生效
ip rule add pref 30500 table 100                   # 落到我们的表
```

**为什么是这三条**：

| 规则 | 作用 | 不加会怎样 |
|---|---|---|
| 30480 | 在我们的规则之前重申厂商的 fwmark 语义 | 智驾栈的流量可能被我们的表截走 |
| 30490 | 主表照常匹配，但**屏蔽它的默认路由** | 所有流量仍走 `__HYPERVISOR_GATEWAY__` 那条死路 |
| 30500 | 剩下的落到表 100 | 屏蔽了主表默认路由却没有替代，直接断网 |

主路由表、厂商规则、`172.31.254.38` 全程零改动。站点无关——换个网络只要表 100 里的
网关跟着改，搬到哪都能用。

持久化在 `/var/lib/llm/net/site-egress.sh` 的「全局出网」段，由 `iecu-egress.service`
与 `iecu-egress.timer` 维护。

---

## 1.4 入站防线（和出网是一套，不能只做一半）

出网打通的同时，公网 DNAT 的回程也通了。**没有这道防线，路由器上任何指向板子的
历史端口转发都会把 root + 弱口令的 SSH 直接送上公网**，几小时内必被爆破。

```bash
iptables -N IECU_GUARD
iptables -A IECU_GUARD -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
iptables -A IECU_GUARD -i lo -j RETURN
iptables -A IECU_GUARD -s 192.168.0.0/16 -j RETURN
iptables -A IECU_GUARD -s 172.16.0.0/12 -j RETURN
iptables -A IECU_GUARD -s 10.0.0.0/8 -j RETURN
iptables -A IECU_GUARD -j DROP
iptables -I INPUT 1 -j IECU_GUARD          # 必须在 INPUT 最前
```

语义：**非内网源发起的新入站一律丢弃**，已建立连接和回程放行。

⚠ 顺序很重要，`IECU_GUARD` 要排在厂商的 `idps_input` 链之前。

---

## 1.5 DNS 与对时

**本板子没有 RTC。** 不校时会跑出几十天的偏差——实测偏过 87 天，
而时间错会让 TLS 证书校验全部失败，表现成"网络不通"。

```bash
# /etc/systemd/timesyncd.conf
[Time]
NTP=ntp.aliyun.com ntp1.aliyun.com ntp.tencent.com
FallbackNTP=cn.pool.ntp.org ntp.ubuntu.com
```

时区设 `Asia/Shanghai`。`systemd-timesync` 以 uid 101 运行，
出网规则里要给它单独开一条（`ip rule add pref 30001 uidrange 101-101 table 100`）。

判据：`timedatectl` 里 `System clock synchronized: yes`。

DNS 用 `/etc/resolv.conf`（基线是 223.5.5.5 / 114.114.114.114 等四个）。

---

## 1.6 反向隧道（可选，但强烈建议）

板子挪到任何网络都能连上，靠 `frpc` 反连家里的 `frps`。
配置在 `/var/lib/llm/net/`，unit 是 `iecu-frpc.service`，以 uid 998（`iecufrp`）运行——
所以出网规则里也要给它一条 `uidrange 998-998 table 100`。

**隧道只送面板（:9000），绝不送 SSH。** 理由同 1.4：root + 弱口令。

---

## 1.7 完成判据

逐条实测，不看配置文件：

```bash
# ① 出网（⚠ 自建 CPython 必须带证书环境变量，否则 TLS 校验失败，
#    看起来像网络不通，实际是证书路径问题）
export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
python -c "import urllib.request as u; print(u.urlopen('https://pypi.org/simple/',timeout=20).status)"
```

基线板实测：PyPI 200 / GitHub 200 / ModelScope 200 / hf-mirror 200。

- [ ] 四个站点全部 200
- [ ] `timedatectl` 显示 `System clock synchronized: yes`
- [ ] `ip route`（主表）与出厂时逐行一致
- [ ] `ip rule` 里厂商的 `fwmark 0x12c → 123` 仍在
- [ ] `172.31.254.38` 仍在 `eth.254` 上，直连能进
- [ ] `iptables -L INPUT -n -v` 里 `IECU_GUARD` 是第一条且有计数
- [ ] 从外网尝试连板子 SSH：连不上

**最后一条必须实测。** 出网和入站是同一次改动的两面，只验一半等于没验。
