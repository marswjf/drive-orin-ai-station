# 本板 vs 基线板：实测差异清单（2026-08-17）

> 数据来源：2026-08-17 首次接触新板的只读采集（`scripts/phase0-identity.sh`、
> `phase0-toolchain.sh`、`phase0-verify.sh`）。每条都注明实测还是推断。
> **部署时按这份清单改 `iecu-provision` 的阶段步骤，不要照抄基线板的做法。**

板子标识：MAC `<NEW_BOARD_MAC>`（基线板是 `<BASE_BOARD_MAC>`，同属 `02:80:5e:1f` 前缀）。

---

## 一、五项核心身份：全部一致【实测】

`baseline/` 的编译产物可以直接落地，不必重编。

| 项 | 基线值 | 本板 |
|---|---|---|
| 板号 | `p3663-XXXX` | `p3663-XXXX` |
| board_name | `p3663-a01` | `p3663-a01` |
| DRIVE OS | `6.0.9.0-1` | `6.0.9.0-1` |
| glibc | `2.31` | `2.31-0ubuntu9.9` |
| 内核 | `5.15.116-rt-tegra` | `5.15.116-rt-tegra` |
| 发行版 | Ubuntu 20.04 | 20.04.6 LTS |
| CUDA toolkit | 11.4.460 | 11.4.460 |
| cuDNN | 8.9.2 | 8.9.2.19 |
| TensorRT | 8.6.12 | 8.6.12.4 |
| DriveWorks | 5.16.61 | 5.16.61 |
| 驱动包 | — | 541.1.2 |
| Hypervisor | 有 `tegra_hv` | 7 个模块 |
| libcuda | `/usr/lib/libcuda.so.1` | 同 |

**唯一未实测项：CUDA 驱动 API 版本**（基线 `12010`，是锁死整条版本链的那个数）。
板上无 python/gcc/node，`dlopen` + `cuDriverGetVersion` 暂时做不了。
按 DRIVE OS 与驱动包版本与基线完全一致，**推断为 12010——这是推断，不是实测**。
验证方法：阶段 3 推上 node 后第一件事就测它。**在验证通过前，不要引用为事实。**

---

## 二、必须改部署做法的差异

### 1. ★★ `/opt/m0` 与 `/opt/other` 是同一个设备（最容易踩）

```
/dev/vblkdev56 /opt/other ext4 rw,...
/dev/vblkdev56 /opt/m0    ext4 rw,...     ← 同一设备挂两处，内容相同
/var → overlay，upperdir=/opt/other/overlay/upper
```

| | 基线板 | 本板 |
|---|---|---|
| `/opt/m0` | vblkdev23，**26G 独立设备** | **vblkdev56，20G，与 `/opt/other` 同一个** |
| `/opt/other` | vblkdev56，20G | vblkdev56（同上） |
| vblkdev23（26G） | 挂 `/opt/m0` | **未挂载，完全闲置** |

**后果**：往 `/opt/m0` 放大文件就是挤占 `/var` 的可写层。基线板上"`/opt/other` 不能当数据盘"
（陷阱 31）在本板上升级为"**`/opt/m0` 也不能当数据盘**"。
基线部署往 `/opt/m0` 放 16.5 GiB 多模态模型的做法，在本板上会把 `/var` 挤爆，
而 `/var` 装着 `/var/lib/llm`（node、frpc、面板密码）与 `/var/log`——挤爆等于服务成片异常。

**处置建议**：把闲置的 vblkdev23（26G）挂起来当 `/opt/m0` 的替代数据盘，
或者模型全部放 `/opt/m`（vblkdev50，30G，28G 空闲，与基线一致且独立）。
挂载前先只读挂一次确认内容（参照红线 12 对 vblkdev51 的处理方式），**不要直接格式化**。

### 2. ★ 局域网地址要加在 `eth` 母接口，不是 `eth.254`

| | 基线板 | 本板 |
|---|---|---|
| 母接口 `eth` 地址 | 无 | **`__SITE2_IP__/24`，untagged** |
| 母接口 NOARP | 报告记为 NOARP | **没有 NOARP**（flags 是 `BROADCAST,MULTICAST,ALLMULTI,UP,LOWER_UP`） |
| 诊断口 VLAN 行为 | 物理口 **PVID=254**，untagged 直通 `172.31.254.38` | **必须自己打 tag 254** |
| 默认路由 | `__HYPERVISOR_GATEWAY__ dev eth.8`（Hypervisor 内网，不通外网） | **`__SITE2_GW__ dev eth`（普通网关）** |

**基线板把 `192.0.2.15` 加在 `eth.254`**，靠交换芯片 PVID=254 剥 tag 才能被家网访问。
**本板不要照抄**——它的诊断口不剥 tag，加在 `eth.254` 上会要求链路两端都处理 VLAN 254。
**应加在 `eth` 母接口**（untagged），普通路由器和交换机直接可达。

用户已指定本板用 **`192.0.2.15`**（避开上一块板的 `.15`）。

### 3. 首次接触必须配 VLAN 254（否则只能 ARP 不能 TCP）

本板 PC 直连的两条入口：

| 入口 | 地址 | 本机要做什么 |
|---|---|---|
| A（推荐，免 VLAN） | `__SITE2_IP__` on `eth` | 本机配 `__SITE2_NET__.x/24`。**未实测**，接口标志与路由表支持 |
| B（已实测走通） | `172.31.254.38` on `eth.254` | 本机配 `172.31.254.x/16` **且必须设 VLAN ID 254** |

Windows 上走 B 的做法（本次实测通过，Realtek USB GbE）：

```powershell
New-NetIPAddress -InterfaceIndex <idx> -IPAddress 172.31.254.1 -PrefixLength 16
Set-NetAdapterAdvancedProperty -Name "<网卡名>" -RegistryKeyword "RegVlanID" -RegistryValue 254
# 网卡会重置几秒，之后确认手工地址还在（可能被重置清掉）
```

**不配 VLAN 时的迷惑现象（务必记住，排查会绕很久）**：
ARP 能拿到 MAC，但**全部 65535 个 TCP 端口都扫不开**。
机制是——ARP 请求进 `eth`（untagged），内核 `arp_ignore=0` 允许跨接口应答，
应答也从 `eth` untagged 回来，所以 ARP 成功；
但 TCP 的 SYN-ACK 按路由表 `172.31.254.0/24 dev eth.254` **带 tag 254 出去**，
没配 VLAN 的网卡直接丢弃，握手永远不成。
`rp_filter` 是 `2`（loose），**不是它拦的**——这条已实测排除，别再往这个方向查。

---

## 三、其余差异

| 项 | 基线板 | 本板 | 说明 |
|---|---|---|---|
| VLAN 子接口 | 16 个，含 `eth.3` 感知域（16 个摄像头/雷达 MAC） | **11 个，无 `eth.3`/`eth.4`** | 感知域未配置。现有：251/254/7/8/9/68/17/22/48/129/200 |
| SELinux | `enforcing` | **`Permissive`** | 限制更少 |
| 时间 | 已设 `Asia/Shanghai` + NTP 同步 | **`Etc/UTC`，NTP inactive，慢约 205 天**（板上 1 月 24 日） | 同样无 RTC，阶段 1 必做校时 |
| failed units | 3 个（docker / rootfs_expand / networkd_wait_online） | **1 个（`nv_rootfs_expand`）** | 没装 docker |
| 智驾栈 `application_start` | 我们手动 disable | **出厂就 `disabled` + `inactive`** | 省一步 |
| SOME/IP | — | **仍在跑**：4 个 `:30490` 监听（VLAN 17/22/48），`vsomeip_17/22/48.log` 持续写入 | 那 4~5 个进程要单独确认再决定停不停 |
| 组播路由 | 未记录 | `239.127.3.1` dev eth.48/17/22，`239.127.129.1` dev eth.129 | SOME/IP 组播 |
| `/eol` 产线测试工具 | **基线未记录** | **有 `nvsipl_camera_display_all`、`memtester`、`IPD2.0_Csample_Eol_App`、`nvsipl_drv/`** | ★ 对能力边界 C 档「视频输入/摄像头」是现成资产，值得单独探 |
| iptables | 我们加了 `IECU_GUARD` | **只有 `-A OUTPUT -p igmp -j DROP`**（干净出厂态） | 阶段 1 要补入站防线 |
| 内存 | 停栈后可用 24.6 GB | **29415 MB total / 28622 MB available**（全新未跑任何东西） | 一致 |

---

## 四、完全相同，可以照搬基线经验

- `/` 只读、91%、剩 383M（`nv_rootfs_expand` 同样 failed，**别碰**）
- vblkdev51（4G）未挂载 = `/app` 的 A/B 备份槽 → **红线 12 同样适用**
- `ip rule` 的 `32765: from all fwmark 0x12c lookup 123` → 厂商规则，**红线，不动**
- MTU **1466**（非 1500）
- **无 RTC**（`/dev/rtc*` 不存在），不校时会跑出巨大偏差
- **python3.8 的情况一字不差**（陷阱 41）：`command -v python3` 返回空，
  但 `dpkg -l` 是 `ii python3 3.8.2-0ubuntu2`、标准库 `/usr/lib/python3.8/os.py` 在，
  `/usr/bin/python3*` 不存在——**缺的就是那一个可执行文件**，从 deb 里取出来即可
- 板上**没有** python / gcc / cc / g++ / node / perl / make（全部实测确认）
- 分区表与基线完全一致（`/proc/partitions` 逐项核对：vblkdev0 7224192、1 262144、
  23 27262976、50 31457280、51 4194304、52 4194304、53 262144、54 41943040、
  55 51200、56 20971520）——**差异只在挂载关系，不在分区本身**

---

## 四点五、本轮（2026-08-17）已完成的配置

### 两块板并行的资源分配（★ 加任何东西前先查这张表，重名/撞端口 frps 会直接拒绝注册）

| 项 | 上一块板（批次A） | 新板（本板） |
|---|---|---|
| 局域网地址 | `192.0.2.15` on **eth.254** | **`192.0.2.15` on eth 母接口**（untagged） |
| 直连救命通道 | `172.31.254.38`（PVID=254，不用打 tag） | `172.31.254.38`（**必须打 VLAN 254 tag**） |
| 出网方式 | uidrange + 三条加法规则 | table 100 + 三条加法规则（30480/30490/30500） |
| frps proxy 名 | `iecu-panel` / `iecu-ssh` | **`iecu2-panel` / `iecu2-ssh`** |
| 隧道端口 | __PANEL_TUN1__ / __SSH_TUN1__ | **__PANEL_TUN2__ / __SSH_TUN2__** |
| Caddy 站点 | `:__PUBLIC_PORT1__` | **`:__PUBLIC_PORT2__`（待建）** |
| unit 前缀 | `iecu-egress` / `iecu-frpc` | **`iecu-egress-audi` / `iecu-frpc-audi`** |
| NAS 备份目录 | `/volume1/backup/iecu-models/` | `/volume1/backup/iecu-audi-20260817/` |

两块板的 `172.31.254.38` 相同但互不冲突——那是厂商硬编码的直连地址，只在网线直插时用。

### 建立的五个 unit（全部 enabled，源文件在 `deploy/systemd/`）

| unit | 作用 | 要点 |
|---|---|---|
| `iecu-lan-ip.service` | 加 `192.0.2.15/24` 到 **eth 母接口** | 源文件 `iecu-lan-ip-audi.service`。**不是 eth.254**，见 §二.2 |
| `iecu-egress-audi.service` | 出网 + 入站防线 | 脚本 `/var/lib/llm/net/audi-egress.sh`，源 `deploy/net/audi-egress.sh` |
| `var-lib-llm-disks-d23.mount` | 挂 vblkdev23 (26G) | 出厂空白 ext4，**只挂载不 mkfs** |
| `iecu-data.service` | mergerfs 合并 95G | 三分支：`d23/data` + `/opt/update/data` + `/opt/m/data` |
| `iecu-frpc-audi.service` | 反向隧道 | 以 `iecufrp`(uid 998) 运行，配置 600 权限 |

### 存储：mergerfs 合并出 95G 视图【实测】

```
/var/lib/llm/data   （软链 /var/data）   95G 总 / 90G 可用
  ├─ /var/lib/llm/disks/d23/data   vblkdev23  25G 可用
  ├─ /opt/update/data              vblkdev54  38G 可用
  └─ /opt/m/data                   vblkdev50  28G 可用
实测：写 283 MB/s，读 855 MB/s（清缓存后）
```

**为什么不用 LVM**：13 个 vblkdev 是 Hypervisor 的 PCT 静态切好、Storage Server VM 下发的虚拟块设备，
Guest 内改不了 PCT，分区本身合不了。LVM 能做出一个大卷，但要装 lvm2（板上 `pvcreate`/`vgcreate`/`mdadm`
**一个都没有**）、格式化两个分区、还得 mask `opt-update.mount`（触红线 4）。mergerfs 不格式化、
不改 fstab、不动分区表，`umount` 就完全恢复，而速度损失基本测不出来。

**两个限制**：① 单个文件不能跨分支，最大受限于最大分支（当前 38G）；
② `/opt/m` 与 `/opt/update` 在 fstab 里带 `noexec`，**可执行文件仍只能放 `/var/lib/llm`**（红线 7）。

前置条件（实测）：`/dev/fuse` 在、`fuse.ko` 可加载、`/usr/bin/fusermount` 在。
二进制是**静态链接版** `mergerfs-2.42.0-static-linux_arm64`（存档 `deploy/storage/`）——
那些 deb 都是 bullseye/jammy 以上，板上 glibc 2.31 装不了（陷阱 47 同类）。

### 数据处置

板上智驾数据已备份到 NAS 后删除，腾出 **8.9 GB**：

| 内容 | 大小 | 处置 |
|---|---|---|
| `/opt/update`（`A_32_gos0-fs_targetfs.img` 4.3G + `package/51` 3.0G + 签名镜像 1.1G） | 8.3G | tar 到 NAS 后**已删** |
| `/app`（Momenta 智驾栈，2538 文件 + 364 符号链接） | 1.3G | tar 到 NAS，**只读分区未删** |
| `/opt/m0` 智驾残留 + syslog 553M | 0.6G | 已删 |

NAS 落点 `/volume1/backup/iecu-audi-20260817/`：四个 tar + `board-state/`（26 个文件，
含 `tn_eth_init.sh` 的 orig/new/before_wan/current 四个版本、分区表、路由表、iptables、dpkg 全量清单）
+ `SHA256SUMS`。⚠ **NAS 是单块大容量无冗余机械盘且剩余空间有限**（infra 红线 6），
删了本地副本后这是唯一一份，用户已知情确认。

同时把 `<你的备份根>` 里批次A上一块板的智驾数据 31.3 GB 搬到
`\\__NAS_IP__\<归档共享>\<项目归档目录>`（逐目录核对文件数与字节数一致后删源），
本机从 36.19 GB / 14824 文件降到 4.83 GB / 71 文件。清理时把**活部署资产**（torch 运行时、ComfyUI 环境、模型目录）与智驾数据分开——前者不是要删的车机数据。

### SSH 入口收敛

镜像自带卖家公钥 `vendor@buildhost`，**两处**：`/root/.ssh/authorized_keys`
与 `/home/nvidia/.ssh/authorized_keys`，时间都是 `May 7 2025`（= 镜像构建时间，
和 `/app/*`、`tn_eth_init.sh` 原版一致）。**这是打进刷机镜像的，不是运行时写的**
→ 推论：同型号板子可能都有，且刷机/恢复后会回来。

两个文件在只读根分区上删不掉（删要 `remount,rw` 写厂商根分区 = 红线 2），
改走配置屏蔽：`/etc/ssh/sshd_config` 里设 `AuthorizedKeysFile /etc/ssh/authorized_keys.d/%u`
（`/etc` 是 overlay，可写且持久，正好盖住镜像自带的东西）。目录下 `root`/`nvidia` 都是 0 字节。
备份留在 `/var/lib/llm/backup-sshkeys/` 与 NAS 的 `board-state/`。
**要装自己的公钥**：写进 `/etc/ssh/authorized_keys.d/<用户名>`。

### ★ 账户安全加固（2026-08-17 夜，为部署到单位内网做的）

**先纠正本文件早先一条未验证推断**：之前写「`nvidia` 账户局域网内仍可密码登录」——
**错了**。厂商 sshd_config 里本来就有 **`AllowUsers root`**，日志实测
`User nvidia ... not allowed because not listed in AllowUsers`。
→ **nvidia 账户从来就不能 SSH 登录**，不管密码多弱。当时没查 `AllowUsers` 就下了结论，
是"上游报告成功 ≠ 我以为的事实"的又一例。

**弱口令实测**（本机验证，不走网络，不触发爆破检测）：
- root 密码 = `nvidia`（**登录本身就是证明** —— 我们一直用 `IECU_PASS=nvidia` 以 root SSH 进来的）
- nvidia 密码 = `nvidia`（`openssl passwd -6 -salt <salt>` 生成哈希后与 `/etc/shadow` 中对应条目比对命中）
- ⚠ **测密码不能用 `su`** —— 板上没有 `su`，第一版脚本因此**全部假阴性**（报"都不对"）。
  py3.13 也没有 `crypt` 模块（PEP 594 移除）。可用的是 **`openssl passwd -6 -salt`** 比对哈希。

**做的加固**（用户选择：换强密码 + 保留 root 登录 + 保留密码登录 + 不额外限端口）：
- root 与 nvidia 密码都改成面板同款 `iecupassword`（`chpasswd` 从 stdin 喂，不进进程表）。
  验证：openssl 比对新哈希命中、旧口令 `nvidia` 失效、**新密码实际 SSH 登录成功**。
- sshd drop-in `/etc/ssh/sshd_config.d/60-iecu-harden.conf`（落到持久层）：
  `MaxAuthTries 3`（原 6）、`LoginGraceTime 30`（原 120）、`MaxStartups 3:50:10`、
  `PermitEmptyPasswords no`、`ClientAliveInterval 300`、`X11Forwarding no`。
  改法：drop-in 而非改主配置每一行；`sshd -t` 通过才 `reload`（不 restart）。

**加固后的真实攻击面**：唯一 SSH 入口 **root@22**（`AllowUsers root`），
12 位强密码，3 次试错断连。对单位内网够用。板子根分区只读装不了 fail2ban，
但 `MaxAuthTries 3` + 强密码已让在线爆破不现实。
`IECU_GUARD` 仍在 INPUT 最前挡公网源（内网源放行——所以内网账户安全必须做实，正是本节）。

**回滚**：`sshd_config.bak-harden-20260817` 在板上；删 drop-in 即恢复宽松策略。
改密码脚本是临时文件、用完即删，密码不进项目同步目录。

### 空载基线【实测 2026-08-17 21:17】

```
内存  29415 MB 总 / 28592 MB 可用（什么都没跑）
温度  thermal_zone0/1/2/3/4/10 = 51/49/49/51/46/39 °C
```

⚠ **温度不能套用上一块板基线**：上一块板空载 67°C 是 performance 锁频 + 省电全关的地板温度，
本板 51°C 说明没锁在同样的状态，跑起来的表现会不同，要重新测。

---

## 四点六、重启验证与随后修的三处（2026-08-17 晚）

**重启后五个 unit 全部自恢复**（IP、出网、防线、95G 合并视图、隧道），但暴露三件事：

### 1. ★ 板子自己拿到了 DHCP 地址 —— "插路由就能识别"是真的

重启后 `eth` 上是：

```
inet __SWITCH_IP__28/24 dynamic   eth    ← dhclient 拿的
inet 192.0.2.15/24  secondary eth    ← iecu-lan-ip 配的
default via 192.0.2.1 dev eth        ← dhclient 改的主路由表
```

`tn_eth_init.sh` 的 WAN 段是 **先 `dhclient -1 eth`（等 10 秒），拿不到才回落 `__SITE2_IP__`**。
在家网它真的拿到了地址，所以 `__SITE2_IP__` 这次没出现。
→ **卖家那句"插路由就能识别"成立**；之前判它不成立，是因为当时板子根本没接上家网，
等于拿"没接网时扫不到"否定了"接网能识别"。

⚠ `.228` 是动态的会变，**可靠入口始终是静态的 `.16`**。若想让动态地址也固定，
在路由器上给 MAC `<NEW_BOARD_MAC>` 绑静态租约（可选，不做也不影响）。

### 2. ★ NTP 重启后不自启 —— 根因是缺 symlink

`systemctl is-enabled systemd-timesyncd` 报 `enabled`，但 **`active=inactive`**，
且 `journalctl` 里 `-- No entries --`（根本没启动过）。
根因：缺 `sysinit.target.wants/systemd-timesyncd.service` 这个 symlink，
只有 **`timedatectl set-ntp true`** 会创建它，`systemctl enable` + `restart` 不会。
修好后确认 symlink 实体落在 `/persistent/driveos/security/etc/systemd/system/sysinit.target.wants/`。

**判据**：只认 `timedatectl` 的 `System clock synchronized: yes` + `NTP service: active`，
`is-enabled` 说 enabled 不算数（又一个"上游报告成功≠生效"的例子）。

顺带查清 **`nv_timesync.service` 不抢时钟**：它的 ExecStart 是 `nv_timesync.sh save 10` / `load`，
作用是「关机存时钟、开机读回」，正是补偿没有 RTC 的机制，与 timesyncd 互补。
另发现 **`/dev/ptp0` 存在**（车载 gPTP 硬件时间同步），从未探测过，属能力边界 C 档。

### 3. ★ 自己引入的缺陷：出网网关写死，一挪地方就断

`audi-egress.sh` 原本 `GW=192.0.2.1` 写死。而 `30490` 规则**抑制主表默认路由**、
强制走表 100 —— 板子挪到别的网络时，dhclient 明明在主表设好了正确网关，
却被这条规则跳过，表 100 指向不存在的 `192.0.2.1`，**出网直接断**。

改成 `detect_gw()` 动态探测：① 主表现有默认网关（dhclient 设的，最可信，跳过 `__SITE2_GW__`）
→ ② `eth` 各地址同网段的 `.1` → ③ 兜底 `__SITE2_GW__`，每一步都 ping 验证可达。
实测重启单元后正确探测到 `192.0.2.1`。

同一轮把 `IECU_GUARD` 从「只放行 192.168.1/3 两段」改成 **RFC1918 全放行**
（`10/8` + `172.16/12` + `192.168/16`），否则换到别的网络（可能是另一个 `192.168.x.x` 网段或 `10.x`）
连本地都进不来。公网源仍一律 DROP。

⚠ **遗留**：探测只在 unit 启动时做一次。**换了网络要重启板子，或跑
`systemctl restart iecu-egress-audi`**。上一块板用 timer + 独立 `-recheck` unit 解决
（注意陷阱 57：`RemainAfterExit=yes` 的 oneshot 会让 timer 永远空转），
本板暂未做——挪动不频繁就不值得那个复杂度。

---

## 四点七、LXC 侧（你的宿主机 192.0.2.4）本轮改动

现役配置在 `/opt/iecu-edge/`，源文件同步在项目 `deploy/edge/`，
原件备份 `*.bak-20260817`（LXC 上）与 `deploy/edge/backup-20260817/`（项目里）。

`docker-compose.yml` 两处**新增**（上一块板的映射一处未动）：

```yaml
iecu-frps.ports:        + "127.0.0.1:__SSH_TUN2__:__SSH_TUN2__"   # 新板 SSH 隧道
iecu-edge-caddy.ports:  + "__PUBLIC_PORT2__:__PUBLIC_PORT2__"             # 新板面板站点
```

⚠ **容易漏**：Caddy 容器原本只映射 `__PUBLIC_PORT1__`，光在 Caddyfile 里加 `:__PUBLIC_PORT2__` 站点是不够的，
**必须同时加容器端口映射**，否则站点起来了但外面进不来。

`Caddyfile` **追加**一个与 `:__PUBLIC_PORT1__` 完全并列的 `:__PUBLIC_PORT2__` 站点（上游
`iecu-frps:__PANEL_TUN2__` + 回退 `192.0.2.15:9000`，`/v1` 与 `/embed` 同样 403 拦截）。
**`:__PUBLIC_PORT1__` 那一段是上一块板的，一个字没改。**

端口分配（用户已在路由器上配好 __PUBLIC_PORT2__ 转发；**相邻端口往往已被其它服务占用，分配前先确认**）：

```
公网 __FRP_BIND__ → LXC:__FRP_BIND__   frps，两块板共用一个入口
公网 __PUBLIC_PORT1__ → LXC:__PUBLIC_PORT1__   上一块板面板
公网 __PUBLIC_PORT2__ → LXC:__PUBLIC_PORT2__   新板面板
LXC 127.0.0.1:__SSH_TUN1__      上一块板 SSH 隧道（跳板用，不对外）
LXC 127.0.0.1:__SSH_TUN2__      新板 SSH 隧道（跳板用，不对外）
```

**端到端实测判据**（2026-08-17 21:40）：

| 测什么 | 结果 |
|---|---|
| LXC 上 `nc 127.0.0.1 __SSH_TUN2__` | **`SSH-2.0-OpenSSH_9.3`** ← 板子的 banner，整条隧道通 |
| LXC 上 `nc 127.0.0.1 __SSH_TUN1__` | 无响应（上一块板离线，两板互不干扰） |
| 公网 `https://…:__PUBLIC_PORT2__/` | **503**（能连到 Caddy = 路由器转发通；503 因面板未装） |
| 公网 `https://…:__PUBLIC_PORT2__/v1/models` | **403**（数据面拦截在公网侧生效） |
| frps 日志 | `client login ip [192.0.2.1:39452] arch [arm64]`，两个 proxy `success` |

frps 日志里源 IP 是路由器 `192.0.2.1`，说明板子走的是**公网域名 → 路由器 → 反代宿主机**
（NAT 回环），所以挪到外网时同一份配置直接可用，不需要改。

⚠ **验证脚本里一处判据是坏的**（留作教训）：
`if docker run ... caddy validate ... | tail -5` —— 管道的退出码是 `tail` 的，永远 0，
所以那个 `if` 永远成立。实际输出里有 `open /certs/…crt: no such file or directory`
（一次性容器没挂 certs）。配置确实是对的（错误发生在证书加载阶段，语法解析已过，
且 Caddy 最终正常启动），但**那句"✓ 语法通过"是侥幸，不是验证**。
写这类判据要 `set -o pipefail` 或把退出码单独存下来。

---

## 四点八、装机（阶段 3~5）实测记录 2026-08-17 夜

### ★ baseline 的五个真实缺口（本轮补上，装第三块板前必读）

`baseline/` 原本**只覆盖生图栈**，按它走一遍会在五处卡住：

| 缺口 | 现象 | 本轮怎么补的 |
|---|---|---|
| **没有 node** | 面板、全部工具脚本、下载器都跑不了 | 下 `node-v22.23.2-linux-arm64`（glibc 2.28+，板上 2.31 满足），只取 `bin/node`，归档 **`baseline/bin/node`**（116.5 MB） |
| **没有 git 的 deb** | `install-git.sh` 要 6 个 deb，项目里没有 | 板子能出网，`apt-get download` 四个 + 从 jammy 手取 nettle 两个，归档 **`baseline/debs/git/`** |
| **★ 板上根本没装 ca-certificates** | git 报 `CAfile: none`，pip/requests 全部 TLS 失败 | 见下方专条。新增 **`deploy/comfyui/fix-ca-certs.sh`** |
| **`65-verify-on-board.sh` 写死 chroot 路径** | 解包部署的板子没有 `chroot-focal`，脚本直接 `not found` | 参数化：`VENV` 环境变量 > 生产 venv > 构建 chroot |
| **`models.tsv` 的下载源假设是错的** | 那句"国内走 ModelScope：把域名换成 modelscope.cn 即可"—— 实测 8 个文件里 **ModelScope 只有 3 个仓库存在**，其余 404 | 写 `probe-model-urls.js` 逐个实测三个源，按源分流 |

**还缺一样（本轮未解决）**：`llama.cpp` 的 CUDA 版 `llama-server`。`baseline/` 里没有，
`deploy/build/` 只有交叉编译脚本不是产物，官方 release 的 arm64 包不带 CUDA。
两个来源：从上一块板复制（`scripts/clone-llama-from-old-board.ps1`，会顺路归档进 `baseline/llama/`），
或重新交叉编译。**归档之后装第三块板就不必再编。**

### ★ CA 证书：厂商镜像根本没装（影响面比看起来大）

```
/etc/ssl/certs/ca-certificates.crt   不存在
/usr/lib/ssl/cert.pem                不存在
/usr/share/ca-certificates           不存在
/etc/ssl/certs                       空目录
dpkg -l ca-certificates              → un（从未安装）
```

⚠ **`comfyui313/run.sh` 里那条 A-136「TLS 证书修复」指向的就是不存在的
`/etc/ssl/certs/ca-certificates.crt`** —— 那个"修复"在本板上是个空指针。
表现分两种，都是同一个根因：不设变量报 `CAfile: none`，
设了指向不存在的文件则报 `Problem with the SSL CA cert (path? access rights?)`。

**解法**：`fix-ca-certs.sh` 从 **node 内置的 145 个根证书**（`tls.rootCertificates`）
生成 `/var/lib/llm/ca-bundle.crt`（217268 字节），零额外依赖。
落点刻意不在 `gitroot` 下 —— `install-git.sh` 开头会 `rm -rf $G`。
`run.sh` 与 git 包装器都改成「优先用它、系统那份存在时才回落」。

**判据**（都已实测通过）：`git ls-remote` 拿到 ref、python `urlopen("https://pypi.org/simple/")` 返回 200、
ComfyUI 重启后证书类报错 0 次、从 `/proc/<pid>/environ` 读到 `SSL_CERT_FILE=/var/lib/llm/ca-bundle.crt`。

**为什么 node 和 dl.js 一直能下载**：node 自带 CA bundle，不看系统那份。
这也是"下载能用但 git 不能"这个怪现象的解释 —— 两者的信任源不是一个东西。

### 存储布局（与 models.tsv 有三处出入，都是本板的特性所迫）

```
/opt/m       vblkdev50 30G  LLM 模型 19.7G（主模型 + mmproj + embedding）→ 剩 13G
/opt/update  vblkdev54 40G  stage 2.7G + cuda122 2.4G + comfyui313 2.4G + 生图模型 12G → 剩 19G
/var/data    mergerfs  95G  ComfyUI 输出、临时、将来的模型
/opt/m0      ——        不放任何模型（与 /opt/other 同设备，是 /var 的宿主）
```

**为什么模型不放 mergerfs 合并视图**：llama.cpp 靠 **mmap** 读 18 GB 模型，
而 FUSE 上 mmap 大文件的性能未经验证，拿主模型去试代价太大。
合并视图保留给输出/临时/新模型 —— "合并硬盘"的能力在，只是不让它承担 mmap。

⚠ `mount-stack313.sh` 原本写死实体根 `/opt/m0`，已参数化
（`STACK_ROOT` 环境变量 > 已存在的 `/opt/update` > 默认 `/opt/m0`），两块板共用一份脚本。
⚠ `extra_model_paths.yaml` 做了本板专用版（`-audi.yaml`），**删掉 `/opt/m0` 那个搜索根**，
物理上防止将来往那儿放模型。

### 阶段 3 完成判据【实测 BOARD-ALL-PASS，13 项全过】

```
torch 2.11.0 | cuda 编译期 12.2 | cudnn 92000 | device: Orin | capability (8,7)
★ CUDA 驱动 API 实测 12010（CUDA 12.1）—— 整条版本链的前提，不再是推断
  判据：dlopen libcuda.so.1 → cuInit(0)=0 → cuDriverGetVersion → 12010
  参照：/sys/module/nvidia/version = 541.1.2 是**驱动包版本**，不是 CUDA API 版本
① 首次矩阵乘 3.25s（基线板 4.49s，更快 —— 说明没有 PTX JIT）
② flash attention OK   ③ mem-efficient OK
④ 注意力峰值 math 1213 MiB → flash 33 MiB（省 97%，与基线板数字一致）
⑤ flex / gqa / pep585 全部原生
⑥a CPU-GPU matmul 最大差 0.000e+00
⑥b CPU matmul 30 次 NaN 0 次   ← 自编 OpenBLAS 0.3.29 生效
⑥c cuDNN conv2d OK   ⑦ CUDA Graph 捕获回放 OK
libtorch_cpu.so 解析到 /var/lib/llm/cuda122/ 下的 OpenBLAS 与 libstdc++（不是系统那份）
```

解包核对：`cuda122` = 27 普通文件 + 25 符号链接 = **52**（文档说的约 52 是含符号链接的）；
`comfyui313` 结构是 `comfyui313/{ComfyUI,venv,run.sh}` **两层**，本体在 `ComfyUI/` 子目录里；
文件总数 47116（文档说约 49260，差值未追究，关键路径与 torch 全部可用）。

### 阶段 4：ComfyUI 与面板【实测】

```
ComfyUI  8188 在听，启动 22 秒（首次 46 秒是因为 Manager 因缺 git 失败重试）
         IMPORT FAILED 0 / PRESTARTUP FAILED 0 / 证书类报错 0
         九个节点包全部加载，ComfyUI-Manager V3.41 正常，network_mode public
         Set vram state to HIGH_VRAM，Total VRAM 29415 MB（统一内存识别正确）
面板     9000 在听 1 秒；/ 200、/api/auth/state 200、/api/status 200(5971 字节)
         局域网免登录 / 公网要登录 / /v1 与 /embed 仅限局域网
         memory-guard 已启用（available<0.35GiB 且空闲且 5 分钟无请求 → 重启）
```

⚠ **面板部署必须把 `dist/` 摊平到 `panel/` 根**（陷阱 39）：`server.js` 的 `ROOT=__dirname`，
`dist/` 子目录不在服务路径上。判据：`index.html` 引用的 `index-*.js`/`.css`
必须与 `assets/` 里实际存在的文件同名 —— 本次核对 `index-BoPHwHQW.js` / `index-BP3elTQ5.css` 对得上。

两条无害但会误导的启动日志：`You need pytorch with cu130 or higher`（cu122 下部分优化路径不可用，
主路径正常）；`SeedVR2: Flash Attention ❌` —— 它检查的是 **`flash-attn` pip 包**，
而我们的 torch 是把 FA 编进 SDPA 后端的（13 项验证里 `fa PASS`、省 97% 内存），**两个不同的东西**。
另有 `KJNodes` 报 `PatchTritonVAE requires triton`，异常被捕获、包本身加载成功，
triton 在 aarch64 装不了，不影响文生图。

### 阶段 5：模型【8/8 完成，字节数逐个精确匹配】

| 文件 | 字节 | 源 | 速度 |
|---|---|---|---|
| `Qwen3.6-35B-A3B-MTP-UD-IQ4_XS.gguf` | 18209036576 | ModelScope | 36 MiB/s / 472s |
| `z_image_turbo-Q8_0.gguf` | 7224707136 | ModelScope | **42 MiB/s** / 161s |
| `Qwen_3_4b-Q8_0.gguf` | 4280404704 | hf-mirror | 13 MiB/s / 313s |
| `mmproj-F16.gguf` | 899283680 | hf-mirror | 11 MiB/s |
| `Qwen3-Embedding-0.6B-Q8_0.gguf` | 639150592 | ModelScope | 19 MiB/s |
| `ae.safetensors` | 335304388 | hf-mirror | 12 MiB/s |
| `4x-UltraSharp.pth` / `RealESRGAN_x4plus.pth` | 66961958 / 67040989 | hf-mirror | 7 MiB/s |

**本轮口径**（用户指定）：不装 27B、不装 ControlNet、不装三个 LoRA、不装 SeedVR2 视频超分。
⚠ 主模型上游文件名是 `Qwen3.6-35B-A3B-UD-IQ4_XS.gguf`（无 MTP- 前缀），板上存成带前缀的名字；
非 MTP 仓库有同名文件但字节数是 17730509792，下错会失去 MTP 投机解码。

### 生图实测【两个工作流都拿到真实图片文件】

| 工作流 | 结果 | 基线板 |
|---|---|---|
| `z-image-gguf` 首张（含载入） | **79.6 秒**，`zimage_00001_.png` 1154 KB | 82.1 秒 |
| `z-image-gguf` 连续出图 | **30.2 秒 × 2 次**（不同种子、不同文件名与体积） | 30.4 秒 |
| `老照片修复`（denoise 0.4 + 4 倍超分） | **57.4 秒**，`restored_00001_.png` 17571 KB / 4096² | 约 100 秒 |

模型被 ComfyUI 扫到的判据（不是"目录里有文件"而是"加载器下拉里有它"）：
`UnetLoaderGGUF → z_image_turbo-Q8_0.gguf`、`CLIPLoaderGGUF → Qwen_3_4b-Q8_0.gguf`、
`VAELoader → ae.safetensors`，节点类型总数 1363。
⚠ 测连续出图**必须换种子**，相同种子返回缓存（3 秒、文件名不变），那是假数据。

运行时内存（`--highvram` 全常驻，模型总量约 11.2 GB）：
`used 20954 MB` / `nvmap 8.06 GB` / `available 8000 MB`。

### 本轮踩到的两次同一个坑（写进判据纪律）

**管道吞掉退出码**，犯了两次：
`if docker run ... caddy validate | tail -5` 和 `if git ls-remote ... | head -3` ——
管道的退出码是最后一个命令的，永远 0，于是**失败被读成"✓ 通过"**。
两次都是我自己写的判据在骗自己。要么 `set -o pipefail`，要么把命令的退出码单独存下来，
要么干脆不接管道（现在 `install-git.sh` 里那段就是重定向到文件再看退出码）。

**PowerShell 内联命令的引号**，犯了四次（`wc -l`、`$(...)`、`\"`、`rm -f` 被权限系统拦下）。
CLAUDE.md 早就写了"凡是带引号/变量/管道的命令一律用 `exec.js --file`"，
这一轮为了省一个文件反复吃亏。**没有例外，全部落成脚本文件。**

---

## 五、下一步

1. ~~验证 CUDA 驱动 API 版本~~ **已实测 12010**，见 §四点八
2. **确认那 4~5 个 SOME/IP 进程**（`ExecutionManagement` + `routingmanagerd_17/22/48`）再决定处置
3. **探一次 `/eol` 里的摄像头工具**（`nvsipl_camera_display_all`、`nvsipl_drv/`）
   ——基线板没有的资产，对能力边界 C 档「视频输入/摄像头」是直接入口
4. **`/dev/ptp0`**（车载 gPTP 硬件时间同步）从未探测，同属 C 档
5. **`nvidia` 账户的密码入口**：有密码 + `/bin/bash` + `PermitRootLogin yes`，待用户决定是否收敛
6. **推理栈与运维面板**（阶段 3~6）：模型放 `/var/data`（95G 合并视图），
   **不要放 `/opt/m0`**（与 `/opt/other` 同一设备，会挤爆 `/var`）

~~局域网地址~~、~~校时~~、~~数据盘布局~~、~~原始状态存档~~ 已完成，见 §四点五 / §四点六。
