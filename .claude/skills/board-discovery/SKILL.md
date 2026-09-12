---
name: board-discovery
description: 拿到一块完全陌生的车规/嵌入式板卡，从"插上不知道是什么、连不上"到"找到它的 MAC 与 IP、用默认口令进去、识别平台、能持久访问"的完整方法论与脚本。当涉及新板卡首次接触、板子连不上/扫不到/ping 不通、不知道 IP、不知道型号、直连探索、端口镜像抓包、找 MAC 找 IP、默认口令测试、只读 rootfs 改地址时使用。关键词：陌生板卡、新板子、连不上、扫不到、找不到 IP、直连、二层发现、VLAN tag、pktmon 抓包、端口镜像、MAC 转发表、默认密码、device-tree、NPU、只读 rootfs、持久化 IP。
---

# 陌生板卡发现与接入

> 面向"拿到一块完全不了解的板子，要把它找出来、进去、认清是什么"。平台无关。
> 案例方法来自 2026-08-24 在一块厂商 ADAS 域控上的完整流程——从插电脑到进系统。
> 案例细节不随本包分发，但**方法本身适用于任何陌生嵌入式设备**。

这份文档解决一个反复出现的处境：**板子插上了，灯也亮，却怎么都连不上**——
ping 不通、扫不到、DHCP 没记录、不知道它的 IP、不知道它是什么型号、不知道口令。
下面是一条从零到"进系统、持久访问"的完整路径，每一步都在真板子上走过。

---

## 六条心法（每条都是用代价换来的）

1. **链路 Up ≠ 有流量。** 网口协商到速率只证明对端 PHY 通电、四对线电气正常，
   不证明有任何帧穿过来。判断"对端在不在说话"看**收包计数**，不看链路状态。

2. **"收不到"先怀疑自己这侧的过滤，再怀疑对端静默。** 网卡上残留的 VLAN tag、
   VLAN 处理开关，都会在硬件层把帧丢掉，现象和"板子不发"一模一样。
   排除法：把 VLAN 处理彻底关掉（tag=0 且 PriorityVLANTag=0）再看。

3. **一个仪表不够，要两个独立仪表交叉验证。** 网卡自身的 Rx 计数可能不上报（USB 网卡尤甚）。
   用 `pktmon`（NDIS 层，独立于网卡计数器）再测一次，并**同时发已知流量做阳性对照**——
   抓到自己发的、抓不到对端的，才能断定"仪表好、对端静默"。

4. **工具缺失会伪装成能力缺失。** `arping: applet not found`、`command -v python3` 空、
   `tcpdump` 不存在——这些是"没装工具"，不是"这台机器不行"。
   **判断某能力在不在，先 `command -v` / `which` 确认工具本身在**，否则一串"失败"会把你带偏。

5. **特征越像，越要用独立判据证伪（"全对优先怀疑巧合"）。** NVIDIA OUI + 9000 端口
   看着就是目标板，结果是台 Shield TV。MAC 前缀只说明芯片厂商，端口开着不代表跑的是你以为的服务。
   **认定"就是它"之前，用一条与这些特征无关的判据去证伪**（应用层内容、主机名、开关机相关性）。

6. **改网络只做加法 / 一切可逆。** 改地址用"先加后删 + 自恢复定时"，操作脚本用 `try/finally`
   保证无论中途出什么错都还原，改文件先留 `.orig-bak`。失联的唯一后果不应该是"只能等人到现场"。

---

## 判据纪律：什么算"做完了"

| 不算数 | 才算数 |
|---|---|
| 链路 Status = Up | 收包计数在涨（对端真的在发） |
| 网卡自己报 Rx=0 | 第二个仪表（pktmon）也报 0，且阳性对照抓到了自己发的包 |
| `command` 返回空/报错 | 先确认工具本身存在，再解读结果 |
| 某地址 ping 不通 | 排除了"我们的包根本没进它协议栈"（IP 撞了、tag 不对） |
| SSH 握手成功 | 认证也过了（握手成功只说明端口通，口令另说） |
| 改对了配置文件 | **重启整机**跑一遍开机流程，地址真的是新值（改文件 ≠ 生效） |
| 命令没报错 | 回读产物确认真的变了 |

---

## 阶段 0 — 先盘点：手上到底有什么接入面

别急着扫。先弄清这块板子暴露了哪些物理接口，每一种都是一条潜在通路：

- **网口**：几个？插的是哪个？（车规板常有多个口，只有特定口通到主 SoC）
- **串口**：Type-C / Micro-USB / 排针。插上看有没有**新的** COM 口冒出来
  （`[System.IO.Ports.SerialPort]::GetPortNames()` + `Get-PnpDevice -Class Ports -PresentOnly`）。
  串口是最强的通路——能看启动日志、能直接读网络配置，一步到位。
- **Type-C**：可能是 USB device（虚拟串口+网卡+U盘）、也可能纯 DP/供电。
  插上看 `Get-PnpDevice -PresentOnly` 有没有新设备枚举；**完全无枚举 = 电气层没握手**
  （线是充电线、口是纯 DP、或板子没上电）。

**本机（Windows）工具约束**（复用 iecu skill 的 `scripts/`）：
没有 sshpass/plink/python，密码认证只有 Node + ssh2 一条路。
`node exec.js`（远程执行）、`push.js`（SFTP）、`portscan.js` / `lanscan.js` / `arpsweep.js`（扫描）。

---

## 阶段 1 — 二层发现：对端到底在不在说话

网卡插上、链路 Up，但 ping 不通。第一个问题不是"它 IP 是多少"，而是"它发不发帧"。

```powershell
# 收发计数基线，隔几秒再采，看 Rx 涨不涨
Get-NetAdapterStatistics -Name "以太网 2" |
  Select ReceivedBytes,ReceivedBroadcastPackets,ReceivedMulticastPackets,SentBytes
```

- **Rx 一直是 0** → 要么对端静默，要么**我们这侧在过滤**。先查网卡 VLAN：
  ```powershell
  Get-NetAdapterAdvancedProperty -Name "以太网 2" -RegistryKeyword 'RegVlanID','*PriorityVLANTag'
  # 残留 tag 会只收该 tag 的帧、丢弃其余。彻底关闭再测：
  Set-NetAdapterAdvancedProperty -Name "以太网 2" -RegistryKeyword 'RegVlanID' -RegistryValue 0
  Set-NetAdapterAdvancedProperty -Name "以太网 2" -RegistryKeyword '*PriorityVLANTag' -RegistryValue 0
  ```
  ⚠ 改网卡属性、装抓包驱动都要**管理员权限**。没有就让用户用管理员 PowerShell 重开
  （`claude --continue` 接上下文）。别在半管理员状态下反复试。

- **关掉 VLAN 仍 Rx=0** → 上第二个仪表 `pktmon`（Win 自带，NDIS 层，不需装东西）：
  ```powershell
  pktmon list                              # 找网卡的组件 ID
  pktmon start --capture --comp <ID> --pkt-size 256 --file-name cap.etl
  # 抓的同时发已知流量做阳性对照（ping 广播），40 秒后：
  pktmon counters                          # 看 Rx / Tx
  pktmon stop
  ```
  **抓到自己发的 Tx、Rx 仍是 0 → 仪表没坏，对端确实静默。**
  这时"链路 1 Gbps 全双工"这条事实反而有用：四对线好、PHY 完成自协商，
  但没有帧穿过来——典型的**"这个网口没有转发路径到主处理器"**（插错口了）。

---

## 阶段 2 — 常规发现手段（及它们何时失效）

板子在发帧了，但不知道 IP。常规四招，各有盲区：

| 手段 | 命令 | 盲区 |
|---|---|---|
| ARP 全网段点名 | `node arpsweep.js 172.31`（两段前缀！三段会拼错乱扫） | 对方不在你猜的网段就空 |
| DHCP 租约 | 路由器 `cat /tmp/dhcp.leases`（带主机名，最省事） | 对方跑静态 IP 就没记录 |
| IPv6 全节点组播 | `ping6 -I <if> ff02::1`（所有 IPv6 主机应答） | 对方关了 IPv6、或帧带 tag 收不到我们的 |
| LLDP 邻居 | 交换机/`lldpcli show neighbors` | 对方不发 LLDP |

**当四招全空，但网桥/交换机明明学到了它的 MAC** —— 这组合本身就是结论：
**对端能发帧到链路上，却不理我们任何探测**。最可能的三个原因（这次三个全中）：
1. **它的静态 IP 撞了网关**（比如板子和路由器都是 __ROUTER_IP__，我们发给它的包被网关截走）；
2. **它只发不收**（只发组播，从不发 ARP，也不应答单播）；
3. **它的帧带 VLAN tag**，我们的 untagged 探测进不去它的协议栈。

→ 到这一步，不看它的**实际报文**就没法再往前。上网管交换机。

---

## 阶段 3 — 差分发现 + 网管交换机（常规手段失效后的主力）

**差分法**：先存一份"板子接入前"的全量 MAC 基线，接入后再采一次，多出来的就是它。
比猜地址可靠得多。三个基线源（都只读）：

```bash
# 路由器：DHCP 租约（带主机名）+ 网桥 MAC 学习表（凡发过帧的 MAC 都在，最全）
cat /tmp/dhcp.leases
brctl showmacs br-lan | grep -v permanent      # ageing 小 = 刚发过帧，正在活跃
ip neigh show dev br-lan
```

**网桥 MAC 学习表最强**：它记录所有发过帧的 MAC，`ageing` 计时器是"多久前发过帧"。
用它做一个**开关机相关性证伪**（阶段纪律第 5 条的正面用法）：
让用户断电板子 → 那条 MAC 的 ageing 单调上涨（不再归零）→ 上电 → 立刻归零。
**关就停、开就发 = 身份闭环**，不用看 IP。

**网管交换机是终极手段**（这次是一台 QSS 系网管交换机）：
- 管理口常只开 80/443（Web），SSH/SNMP 默认关。**QSS 前端是 SPA，API 在 `/api/v3`**：
  下载 `index.bundle.*.js`，`grep basePath` 扒出全部端点（登录 `POST /api/v3/users/login`
  body `{username, password: base64}`，MAC 表 `/mac/fdb/status`，镜像 `/mirror`，
  端口 `/ports/status`）。逆向前端比点界面快、可脚本化。
- **`/mac/fdb/status`** 直接给出 `[VLAN, MAC] → 端口`，一眼定位板子在哪个口、哪个 VLAN。
- **端口镜像**是读报文的干净手段：把板子所在口的收发复制一份到一个空闲口，
  PC 接那个口用 pktmon 抓。**抓完立即把镜像会话 `Mode:false` 还原**。

镜像抓到帧后，`pktmon etl2txt cap.etl -o cap.txt -v` 转文本，读源 IP。
这次读出源 IP = __ROUTER_IP__（撞了路由器），谜底揭开。

---

## 阶段 4 — IP 撞网关时的隔离接入（带自恢复）

板子 IP 和网关/家网设备撞了，直连它要"隔离"——给本机网卡配同段地址、**写死 ARP** 指向板子 MAC、
加一条 `/32` 主机路由。核心风险：**这段时间本机默认网关可能失效，把自己网也搞断**。

铁律：**不配网关、不改默认路由、抬高该网卡跃点数、全程 `try/finally` 还原**。
脚本模板见 `scripts/isolated-connect.ps1`。关键结构：

```powershell
try {
  Set-NetIPInterface -InterfaceIndex $IFX -InterfaceMetric 9000   # 别抢默认路由
  New-NetIPAddress    -InterfaceIndex $IFX -IPAddress <同段地址> -PrefixLength 24
  New-NetNeighbor     -InterfaceIndex $IFX -IPAddress <板子IP> -LinkLayerAddress <板子MAC> -State Permanent
  New-NetRoute        -DestinationPrefix "<板子IP>/32" -InterfaceIndex $IFX -RouteMetric 1
  # 先等端口可达再连（ARP 生效有延迟，太早连会 EHOSTUNREACH）
  ...探测 22 端口通了再 SSH...
}
finally {
  # 无条件还原：删路由/邻居/地址，恢复原地址与跃点数，自检 WiFi 通
}
```

板子侧若要改地址，用**板上自恢复脚本**（`ip addr add 新 && ip addr del 旧`，
90 秒后若没被确认就自己变回旧地址）——万一新地址不通，不必断电就能恢复。见 `scripts/board-change-ip.sh`。

---

## 阶段 5 — 默认口令测试（不爆破）

SSH 握手成功但认证失败 ≠ 密码错，也可能**只认公钥**。先问服务端认证方式，再试口令。

**在自己的板子上试自己的/厂商默认口令是正当运维**，但**不跑字典爆破**（不体面、会触发锁定）。
合理组合按平台默认来试，一轮几个就够：

```
root/root      nvidia/nvidia   root/nvidia   nvidia/ubuntu   root/(空)
```

命中即停。这次 Botheart 板是 `root/root`。厂商默认口令值得先向用户/厂商问一句，往往有现成的。

⚠ 时序坑：隔离一就绪立刻发 SSH 会 `EHOSTUNREACH`（ARP 表项还没生效）。
**先 TCP 探 22 端口通了，再发 SSH。**

---

## 阶段 6 — 平台身份识别（指纹 → 查厂商）

进去后别急着装东西，先认清这是什么。一次采全，别猜：

```bash
cat /proc/device-tree/model /proc/device-tree/compatible   # 平台名/厂商串
cat /proc/cpuinfo | grep -E 'implementer|part'             # SoC 指纹（0x41=ARM, part=核型号）
uname -a ; cat /etc/os-release                             # 内核/发行版
cat /proc/cmdline                                          # board_id/root=/secure_boot
lsblk ; mount | grep ' / '                                 # 存储布局、根分区读写性
systemd-detect-virt                                        # 裸机 or 虚拟机
ls /dev | grep -iE 'npu|gpu|dla|dsp|bpu|accel'             # AI 加速器（域控多是 NPU 不是 GPU）
systemctl list-units --state=running                       # 业务服务
```

**从指纹反查厂商**（这次的关键动作）：`CPU part 0xd89 = Cortex-A720`、
soc0 machine=`厂商 BMC 型号`、内核模块（厂商前缀）`bh_npu`、`/tmp/*_tvm_*.so`、系统 `厂商 OS`——
把这些**独特词**丢给 smart-search（厂商前缀 / 系统名），一次就查到厂商、SoC 型号、算力。
> 别按 device-tree 的 `model` 字面下结论：这次 model 是 `AEMv8A`（ARM 通用模板名），
> 真身份在 `soc0/machine` 和内核模块前缀里。**多个来源交叉**才可靠。

**AI 平台的关键分野**：有没有 CUDA / 是什么加速器，决定了模型部署路线完全不同。
NVIDIA 系走 CUDA/llama.cpp；国产域控多是**私有 NPU + 编译器**（这次是 Apache TVM 编到 bh_npu），
现成的 CUDA 那套一个都用不上。

---

## 阶段 7 — 只读 rootfs 下的地址持久化

车规系统的根分区常是**只读**（`mount | grep ' / '` 看 `ro`），不能往 `/etc`、`/usr` 塞文件，
也做不了标准的 systemd 加法单元。先探清持久化到底往哪走：

```bash
mount -o remount,rw / && mount -o remount,ro /   # 能不能临时解只读（secure_boot=0 多半能）
which crontab cron ; ls /etc/rc.local            # 有没有软钩子（多半没有）
grep -rIls -E '/usercfg|/data|/storage' /usr/lib/systemd  # 有没有服务从可写分区读配置
```

这次结论：**软钩子路线不存在，只能 remount rw 改配置文件**。做法（可完全回滚）：

```bash
mount -o remount,rw /
cp -a <配置文件> <配置文件>.orig-bak          # 先备份
sed -i 's#旧地址#新地址#' <配置文件>           # 改地址来源 + 开机脚本里硬编码的免费ARP
sync ; mount -o remount,ro /                   # 无条件锁回只读
grep 回读校验
```

⚠ **改对文件 ≠ 重启生效**。地址由谁配、开机流程里有没有别处再配一遍，都得靠**重启整机**验证。
重启前确认失联兜底：板子在交换机上（能再镜像抓包找回）、口令已知、`.orig-bak` 能回滚。

---

## 脚本索引（`scripts/`，与 iecu skill 的 `../iecu/scripts/` 配合）

| 要做的事 | 脚本 |
|---|---|
| IP 撞网关时隔离连板（改地址+写死ARP+主机路由+自恢复+finally还原） | `scripts/isolated-connect.ps1` |
| 板上原子改地址 + 90 秒自恢复 | `scripts/board-change-ip.sh` |
| pktmon 抓包 + etl2txt 解析源 IP | `scripts/pktmon-capture.ps1` |
| 网卡 VLAN tag 摘除/还原 | `scripts/nic-vlan.ps1` |
| QSS 系网管交换机 API（登录/MAC表/端口/镜像） | `scripts/qnap-qss.ps1` |
| 网桥 FDB / DHCP / ARP 差分找新设备 | `scripts/diff-newmac.ps1` |
| 只读 rootfs 持久化改地址（带备份+回滚） | `scripts/persist-static-ip.sh` |
| 远程执行/传输/扫描（复用） | `../iecu/scripts/`（exec/push/portscan/lanscan/arpsweep） |

远程执行统一 `IECU_HOST=<ip> IECU_USER=<u> IECU_PASS=<p> node ../iecu/scripts/exec.js --file <脚本>`。
⚠ `exec.js` 不传 `IECU_HOST` 会连默认旧地址（172.31.254.38），务必显式指定。

---

## 坑点清单（这次实战踩的，都零报错所以最坑）

1. **网卡残留 VLAN tag → Rx=0**：不是板子静默，是网卡硬件层过滤。关掉 VLAN 处理才看得到。
2. **PowerShell 的 `$OutputEncoding` 是带 BOM 的 UTF8**：管道送给远端 `sh` 会在首行插 BOM，
   报 `﻿command: not found`——**看着像远端命令错，其实是本地编码污染**。
   用 `New-Object Text.UTF8Encoding $false`，或脚本落文件再 `exec.js --file`。
3. **NVIDIA OUI + 9000 端口 = Shield TV，不是板子**：特征越像越要独立判据证伪。
   最快证伪查 DHCP 租约表（带主机名）。
4. **`arpsweep.js` 收两段前缀**（`172.31`），传三段会拼成 `192.168.1.0.0/16` 乱扫。/24 用 `lanscan.js`。
5. **交换机管理口只开 80/443**：没有 SSH，逆向 SPA 的 `/api/v3` 比点界面快。
6. **登录失败先问认证方式，别猜密码**：可能只认公钥；而且爆破会触发锁定。
7. **隔离一就绪立刻 SSH → EHOSTUNREACH**：ARP 表项没生效。先 TCP 探端口通再连。
8. **只读 rootfs**：标准加法单元塞不进 `/etc`；软钩子（cron/rc.local）多半没有；
   只能 remount rw 改文件。
9. **全盘 `grep -r /etc /usr` 会超时**：定位到具体文件后精确 `cat`，别反复全盘搜。
10. **device-tree `model` 可能是通用模板名**（`AEMv8A`）：真身份在 `soc0/machine`、内核模块前缀。
11. **exec.js 默认连旧 host**：不显式 `IECU_HOST` 会连到别的板子，握手超时。
12. **改对配置文件 ≠ 重启生效**：持久化必须重启整机验证，且先备好失联兜底。

---

## 与其他 skill 的关系

- 这块 skill 只管**发现与接入**（从零到"进系统、能持久访问"）。
- 进去之后要在这块板上部署 AI / 二次开发，是另一件事——若是 NVIDIA Orin 系走 `iecu`，
  国产 NPU 系（如 Botheart）目前无对应 skill，工具链要现啃。
- 工具脚本共用 `../iecu/scripts/`（exec/push/扫描），不复制副本。
- 本次实战完整过程：`references/case-xheartos-20260824.md`。
