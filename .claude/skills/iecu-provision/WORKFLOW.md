# 新板装机 WORKFLOW —— 经过两块板实走验证的完整顺序

> 这份文档的每一步都在**两块不同牌子的同源板子**上真实跑过：
> 批次A（2026-08 上旬～中旬）与本板（2026-08-17 一天内从裸板到全栈）。
> **顺序是有依赖的，不要跳步**；每步都给了「判据」，判据不过就不要进下一步。
>
> 配套文档：
> - `references/board-diff-audi-20260817.md` —— 两块板的逐项差异实测
> - `references/phase-*.md` —— 每个阶段的深度背景与原理
> - `baseline/README.md` —— 部署资产清单（25 个文件 4.36 GB）
> - `../iecu/SKILL.md` —— 装完之后的日常运维

---

## 零、先记住这一课：同源 ≠ 同配置

两块板的**板号、DRIVE OS、glibc、内核、CUDA 驱动 API 全部一致**（所以 `baseline/`
的编译产物能直接用），但**软件配置差得很多**。下面这些是本板上实测到的差异，
说明**每块新板都必须重新探索，不能照抄上一块**：

| 项 | 批次A | 本板 |
|---|---|---|
| 直连诊断地址 | `172.31.254.38` | `172.31.254.38` ← **只有这个不变** |
| 诊断口 VLAN 行为 | PVID=254，**不用打 tag** | **必须自己打 802.1Q tag 254** |
| `eth` 母接口地址 | 无 | `<SITE2_IP>/24`（改造加的） |
| 是否跑 DHCP | 不跑 | **跑**（`dhclient -1 eth`，10 秒超时后回落静态） |
| 主路由默认网关 | `__HYPERVISOR_GATEWAY__` | `<SITE2_GW>`（DHCP 成功时变成当前网段网关） |
| VLAN 子接口 | 16 个，含 `eth.3` 感知域 | 11 个，**无 `eth.3`/`eth.4`** |
| `/opt/m0` 的宿主 | vblkdev23，**独立 26G** | **vblkdev56，与 `/opt/other` 同设备**（是 `/var` 的宿主！） |
| vblkdev23 | 挂 `/opt/m0` | **未挂载，空白 26G** |
| SELinux | enforcing | **Permissive** |
| `/eol` 产线工具 | 未记录 | 有 `nvsipl_camera_display_all` 等 |
| 卖家公钥 | 未发现 | **`vendor@buildhost` 装在镜像里**（root + nvidia 两处） |
| `ca-certificates` | （未查） | **根本没装** → 所有 TLS 失效 |

**结论**：阶段 1 的探索不能省，而且要**用脚本全量采集**，不要凭上一块板的印象。

---

## 阶段 1 · 接触（把板子连上）

### 1.1 三条可能的入口，按顺序试

| 入口 | 什么时候用 | 本机要做什么 |
|---|---|---|
| **A. 网线直连 + VLAN 254** | 最可靠，永远有效 | 配 `172.31.254.x/16` **且网卡设 VLAN ID 254** |
| **B. 网线直连，不打 tag** | 板子的 PVID 恰好是 254 时 | 只配 `172.31.254.x/24` |
| **C. 插路由器** | 板子跑 DHCP 时 | 什么都不用配，看路由器租约表 |

### 1.2 ★ 最容易浪费一小时的现象：ARP 通但所有 TCP 端口都不通

本板实测：不打 VLAN tag 时，**ARP 能拿到 MAC，但全部 65535 个 TCP 端口扫不开**。

机制（查明后很清楚）：
- ARP 请求进 `eth` 母接口（untagged），内核 `arp_ignore=0` 允许**跨接口应答**，
  应答也从 `eth` untagged 发回 → **ARP 成功**
- TCP 的 SYN 进得去，但 SYN-ACK 按路由表 `172.31.254.0/24 dev eth.254`
  **带 tag 254 出去**，没配 VLAN 的网卡直接丢弃 → **握手永远不成**

⚠ `rp_filter` 是 `2`（loose），**不是它拦的** —— 这条已实测排除，别往那个方向查。

**Windows 上配 VLAN**（实测通，Realtek USB GbE）：

```powershell
# 管理员 PowerShell
New-NetIPAddress -InterfaceIndex <网卡idx> -IPAddress 172.31.254.1 -PrefixLength 16
Set-NetAdapterAdvancedProperty -Name "<网卡名>" -RegistryKeyword "RegVlanID" -RegistryValue 254
# 网卡会重置几秒；之后确认手工地址还在（重置可能清掉它）
Get-NetIPAddress -InterfaceIndex <idx> -AddressFamily IPv4
```

先确认网卡支持：`Get-NetAdapterAdvancedProperty -Name "<网卡名>"` 里要有 `RegVlanID`。

### 1.3 扫描工具（都在 `../iecu/scripts/`）

```powershell
node lanscan.js 192.168.1 22,9000 1500     # 扫一个 /24 的指定端口
node portscan.js <IP> common 1500          # 单机常见端口；也支持 1-65535
node arpsweep.js 172.31 22 700 800         # 扫整个 /16 触发 ARP，再读 arp -a
node vehicle-probe.js 30                   # DoIP(13400) + SOME/IP(30490) 车载协议探测
```

### 1.4 判据

- [ ] `ssh root@172.31.254.38` 能进（密码 `nvidia`）
- [ ] **不要**从"扫不到"直接推断"板子不在线"——先确认自己有没有打 VLAN tag

---

## 阶段 2 · 身份核对（不过就停）

整套 `baseline/` 是围着**驱动 CUDA API 版本**反推出来的，五项必须全对：

```bash
cat /proc/device-tree/model                      # 期望 p3663-XXXX
cat /proc/cmdline | tr ' ' '\n' | grep -E 'root=|board_name|aurixfw|isolcpus'
dpkg -l | grep nv-driveos-linux | head -1        # 期望 6.0.9.0-1
ldd --version | head -1                          # 期望 glibc 2.31
uname -r                                         # 期望 5.15.116-rt-tegra
```

**第六项要等阶段 5 有了 Python 才能测，但它最关键**：

```python
# CUDA 驱动 API 版本，期望 12010。板上没有 nvidia-smi。
import ctypes
lib = ctypes.CDLL("libcuda.so.1"); lib.cuInit(0)
v = ctypes.c_int(); lib.cuDriverGetVersion(ctypes.byref(v)); print(v.value)
```

⚠ `/sys/module/nvidia/version` 报的 `541.1.2` 是**驱动包版本**，不是 CUDA API 版本，两回事。

现成脚本：`../iecu/scripts/phase0-identity.sh`、`probe-cuda-driver-version.sh`

### 判据

- [ ] 五项 + 驱动 API 全部与基线一致 → `baseline/` 可直接用
- [ ] 任何一项不同 → **停下来重新推导版本链**（见 `phase-3-runtime.md` §3.1）

---

## 阶段 3 · 全量探索（这一步决定后面所有决策）

**用脚本采集，不要人工看几眼就下结论。** 现成的四个脚本按顺序跑：

```powershell
node exec.js --file phase0-identity.sh      # 身份 + 网络 + 存储 + 服务概览
node exec.js --file phase0-toolchain.sh     # 工具链 + 根分区归因 + 厂商网络脚本
node exec.js --file phase0-verify.sh        # 接口标志 + rp_filter + 真实挂载关系
node exec.js --file inventory-data.sh       # 数据盘点（含只读挂载未挂的分区）
```

### 3.1 必须搞清楚的六件事

| 要查什么 | 为什么 | 怎么查 |
|---|---|---|
| **每个 vblkdev 的真实挂载关系** | 本板的 `/opt/m0` 与 `/opt/other` 是**同一设备**，而 `/opt/other/overlay/upper` 是 `/var` 的可写层宿主 —— 往 `/opt/m0` 放 7G 模型会直接吃掉 `/var` | `grep vblkdev /proc/mounts`，**不要只看 `df`**（df 对同设备多挂载点只显示一次） |
| **有没有未挂载的空分区** | 本板白捡 26G（vblkdev23 出厂空白 ext4，挂上即用，不用 mkfs） | `cat /proc/partitions` 对比 `/proc/mounts`，可疑的**只读挂载**看一眼 |
| **`tn_eth_init.sh` 被改过没** | 它决定地址、默认路由、ARP 开关、是否跑 DHCP | `ls -l /opt/update/tn_eth_init.sh*`，有 `.before_*` 备份就 `diff` 一下 |
| **`ca-certificates` 装了没** | 没装 → git/pip/requests 全部 TLS 失败，而报错信息指不到根因 | `dpkg -l ca-certificates`、`ls -l /etc/ssl/certs/ca-certificates.crt` |
| **有没有别人的 SSH 公钥** | 本板的镜像里装着卖家的 `vendor@buildhost`，root 与 nvidia 两处 | `cat /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys` |
| **智驾栈占了哪些空间** | 决定阶段 4 能腾出多少 | `du -shx /opt/*/*`，⚠ 见下方 du 的坑 |

### 3.2 ★ `du` 在本板上两个方向都会骗人

```
du -sh  /var/lib/llm/llama   → 853M   ← 真值
du -shx /var/lib/llm/llama   → 12K    ← 偏小 99%！
```

原因：`/var` 是 **overlay**，下层文件的 `st_dev` 与挂载点不同，`-x`（不跨设备）把它们全跳过了。
反过来 `du -sh /var` 会**钻进 chroot 的 bind 挂载**把别的分区重复计入，偏大 5 倍。

**判断分区用量一律 `df`**；`du` 只用于比较**同一挂载点内部**的相对大小，且不要加 `-x`。

### 3.3 判据

- [ ] 画得出「vblkdev → 挂载点 → 是否与别的挂载点同设备 → 能不能放大文件」的完整表
- [ ] 知道哪些分区是空的、能动
- [ ] 知道 `tn_eth_init.sh` 的当前行为（尤其**有没有 dhclient**）

---

## 阶段 4 · 清理车机数据（备份 → 校验 → 才删）

### 4.1 板上有什么、能不能删

| 位置 | 内容 | 能删吗 |
|---|---|---|
| `/opt/update/source` + `package` | **原厂 A/B 刷机恢复镜像**（本板 8.3 GB） | ✅ 备份后可删。⚠ 板子**没有串口**，这是唯一救砖素材（红线 5） |
| `/app` | 智驾栈本体（Momenta，本板 1.3 GB） | ❌ **只读分区**，且 vblkdev51 是它的 A/B 备份槽（红线 12） |
| `/opt/m0` 的 `link_mtbf`/`lidar`/`tmp_logs`/`calib_shadow`/`vsomeip_*.log` | 智驾运行残留（约 20 MB） | ✅ |
| `/opt/m0/overlay` | **`/var` 的 overlay upperdir** | ❌❌ 删了 `/var` 就没可写层，服务成片异常 |
| `/var/log/syslog*` | 日志（本板 553 MB） | ✅ `journalctl --vacuum-size=50M` + 截断 |
| `/eol` | 产线测试工具（13 MB，含摄像头工具） | ❌ 在只读根分区上；**留着有用** |

### 4.2 顺序（一步都不能颠倒）

```
挂 NAS（NFSv4）→ tar 打包到 NAS → 核对文件数与字节数 → 算 SHA-256 → 才删板上的
```

**用 tar 不用逐文件复制**，三个理由：保留权限/SELinux 上下文/符号链接；
对 NAS 的机械盘是顺序写（infra 红线 7：几千个小文件并发写曾造成 7834 次 NFS 重传）；
一个文件一个校验值。

⚠ **打包 `/opt/m0` 时必须 `--exclude='opt/m0/overlay'`** ——
那里面有个 `ls` 显示 100G 的 docker devicemapper **稀疏文件**，tar 会把它展开成真的 100G。

现成脚本：`../iecu/scripts/backup-board-to-nas.sh`、`delete-adas-data.sh`

### 4.3 NAS 侧的两个坑

- 板子**只支持 NFS 不支持 CIFS**（内核没有 cifs 模块）。用 `-o vers=4` 挂，
  不需要 rpcbind（v3 才需要，而 rpcbind 在本板上启动失败）。
- NAS 的 NFS 导出**不一定包含你想要的共享**。本板那次只导出了
  `/volume1/media`、`<NAS私有共享>`、`/volume1/backup` 三个，
  目标共享没开 NFS → 直接放 `backup` 下，或者让用户在 NAS 管理界面里加 NFS 权限。
- ⚠ **NAS 是单盘无冗余**（infra 红线 6）。删掉板上副本后 NAS 是唯一一份，
  **这件事必须明确告知用户再动手**。
- 备份完**卸载 NFS**，不要常挂（NAS 掉线会让访问挂起）。

### 4.4 判据

- [ ] NAS 上的 tar 能 `tar tzf` 列出正确的条目数与符号链接数
- [ ] 删除后 `df` 显示腾出了预期的空间
- [ ] **`/opt/m0/overlay` 与 `/opt/other/overlay/upper` 仍然存在**（这条必须单独确认）

---

## 阶段 5 · 存储整合（把碎分区变成一块大盘）

### 5.1 为什么不能真合并

那 13 个 `vblkdev` 不是真分区，是 **Hypervisor 的 PCT（Platform Configuration Table）
静态切好、由 Storage Server VM 下发的虚拟块设备**，Guest 内改不了 PCT。

三条可行路，实测结论：

| 路 | 前提 | 代价 | 结论 |
|---|---|---|---|
| **mergerfs**（FUSE 联合挂载） | `/dev/fuse` + `fuse.ko` + `fusermount` **两块板都有** | FUSE 开销（实测测不出来） | ✅ **推荐** |
| LVM | device-mapper 内核支持有，但 `pvcreate`/`vgcreate`/`mdadm` **一个都没装** | 要装 lvm2 + 格式化 + mask `opt-update.mount`（触红线 4） | ❌ 代价不成比例 |
| 符号链接分流 | 无 | 全手工管 | 兜底 |

### 5.2 mergerfs 落地（本板实测 95 GB / 写 283 MB/s / 读 855 MB/s）

```
分支：/var/lib/llm/disks/d23/data  +  /opt/update/data  +  /opt/m/data
视图：/var/lib/llm/data （软链 /var/data）
选盘策略：category.create=mfs（写新文件时选剩余空间最多的分支）
```

**四个设计要点**：

1. **只并入各分支的 `data/` 子目录**，厂商原有文件不进视图，看起来干净
2. **挂载点必须放 `/var/lib/llm` 下** —— `/opt` 在只读根分区上，`mkdir /opt/xxx` 直接失败
3. **`vblkdev23` 出厂就是格式化好的 ext4，只挂载不 `mkfs`** ——
   全程不对块设备写，红线 2 不触及
4. 持久化用**独立 `.mount` + `.service` unit**，不改 `/etc/fstab`（红线 4：
   改错了开机挂载失败，而板子没有串口）

```
deploy/systemd/var-lib-llm-disks-d23.mount   挂 vblkdev23
deploy/systemd/iecu-data.service             mergerfs 合并
deploy/storage/mergerfs                      静态链接版二进制（不要用 deb，glibc 不够）
```

### 5.3 两个限制（必须让用户知道）

- **单个文件不能跨分支**，上限是最大分支的剩余空间
- `/opt/m` 与 `/opt/update` 在 fstab 里带 **`noexec`**，
  所以合并视图只放数据；**可执行文件仍然只能放 `/var/lib/llm`**（红线 7）

### 5.4 ★ 模型不要放合并视图

**LLM 模型必须放真实分区**（`/opt/m/llm`）。理由：llama.cpp 靠 **mmap** 读 18 GB 模型，
而 FUSE 上 mmap 大文件的性能未经验证 —— 拿主模型去试代价太大。
合并视图留给 ComfyUI 输出、临时文件、将来的模型。

### 5.5 判据

- [ ] `df -h /var/lib/llm/data` 显示三个分支容量之和
- [ ] 连写三个文件，`ls` 各分支确认自动分散
- [ ] 重启后两个 unit 自恢复、视图自动挂回来

---

## 阶段 6 · 网络（DHCP + 固定地址双保险）

### 6.1 ★ 先问用户要哪个固定地址

**这一步必须问，不要自己挑**：

- 固定地址用哪个？（本板用 `__BOARD_LAN_IP__`，因为上一块板占了 `.15`）
- 是否已在路由器 DHCP 池之外？（家网池通常是 `.100-.249`）
- 是否与现有设备冲突？（先扫一遍：`node lanscan.js 192.168.1 22 1200` + 看 `arp -a`）

### 6.2 双保险的原理

| 地址 | 来源 | 特性 |
|---|---|---|
| DHCP 拿到的（如 `__SWITCH_IP__28`） | 厂商 `tn_eth_init.sh` 里的 `dhclient -1 eth`（10 秒超时） | 会随租约变，**不可靠** |
| **固定地址（如 `__BOARD_LAN_IP__`）** | 我们的独立 unit | **始终可靠，日常入口用它** |
| `172.31.254.38` | 厂商硬编码，永远存在 | 直连救命通道，**任何改动都不能碰** |

### 6.3 ★ 固定地址加在哪个接口 —— 两块板不一样

| | 批次A | 本板 |
|---|---|---|
| 加在 | `eth.254`（靠交换芯片 PVID=254 剥 tag） | **`eth` 母接口（untagged）** |

**判断方法**：如果不打 VLAN tag 时 TCP 不通（见阶段 1.2），说明诊断口不剥 tag，
那么固定地址就**必须加在母接口**，否则要求链路两端都处理 VLAN 254。

```ini
# deploy/systemd/iecu-lan-ip-audi.service
ExecStart=/sbin/ip addr replace __BOARD_LAN_IP__/24 dev eth
ExecStop=-/sbin/ip addr del __BOARD_LAN_IP__/24 dev eth
```

用 `replace` 而非 `add`（幂等）。**只做加法**（红线 3）：不动主路由表默认路由、
不动厂商的 `fwmark 0x12c → table 123`、不删 `172.31.254.38`、不改 `tn_eth_init.sh`（红线 4）。

### 6.4 判据

- [ ] `ip -4 addr show dev eth` 同时看到 DHCP 地址与固定地址
- [ ] `172.31.254.38` 仍在 `eth.254` 上
- [ ] 主路由表默认路由**没被我们改**
- [ ] 厂商 `ip rule` 的 `32765 fwmark 0x12c lookup 123` 完好
- [ ] **`sync` 后确认 unit 落到了 `/persistent/driveos/security/etc/systemd/system/`**
      （`/etc` 是 overlay，实体在那里；不确认这步就断电，配置可能没落盘）

---

## 阶段 7 · 对时（板子没有 RTC，不校时会跑出几个月偏差）

### 7.1 做什么

```bash
timedatectl set-timezone Asia/Shanghai
cat > /etc/systemd/timesyncd.conf <<'EOF'
[Time]
NTP=ntp.aliyun.com ntp1.aliyun.com ntp2.aliyun.com
FallbackNTP=cn.pool.ntp.org time.windows.com
EOF
systemctl restart systemd-timesyncd
timedatectl set-ntp true        # ★ 这一条不能省，见下
```

### 7.2 ★ `systemctl enable` 不够，必须 `timedatectl set-ntp true`

本板实测：重启后 `is-enabled` 报 `enabled`，但 `is-active` 是 **`inactive`**，
`journalctl` 里 `-- No entries --`（**根本没启动过**）。
根因是缺 `sysinit.target.wants/systemd-timesyncd.service` 这个 symlink，
**只有 `timedatectl set-ntp true` 会创建它**。

### 7.3 厂商的 `nv_timesync` 不冲突

它的 ExecStart 是 `nv_timesync.sh save 10` / `load` ——
作用是「关机存时钟、开机读回」，正是补偿没有 RTC 的机制，与 timesyncd **互补**，不要停它。

### 7.4 判据

- [ ] `timedatectl` 显示 `System clock synchronized: yes` **且** `NTP service: active`
      （`is-enabled` 说 enabled **不算数**）
- [ ] `journalctl -u systemd-timesyncd` 里有 `Initial synchronization to time server`
- [ ] symlink 实体在 `/persistent/driveos/security/etc/systemd/system/sysinit.target.wants/`

---

## 阶段 8 · 出网 + 入站防线（两件事必须一起做）

### 8.1 为什么要策略路由

厂商 `tn_eth_init.sh` 的 WAN 段是「先 DHCP，拿不到才回落静态 `<SITE2_IP>` + 网关 `<SITE2_GW>`」。
拿到 DHCP 时主表默认路由是对的；拿不到时那个网关在现场多半不存在，出网就断。
红线 3 不许改主路由表默认路由，所以用**三条加法 ip rule + 独立路由表 100**：

```
30480  fwmark 0x12c lookup 123                    复制厂商 fwmark 语义
       （不加这条，带 fwmark 的厂商流量会被下面两条截走，行为被改变）
30490  from all lookup main suppress_prefixlength 0
       查 main 但抑制默认路由 → 所有具体路由照常生效
30500  from all lookup 100                        回落到表 100 的默认路由
```

### 8.2 ★ 网关必须动态探测，不能写死

写死的后果：板子挪到别的网络时，dhclient 明明在主表设好了正确网关，
却被 `30490` 抑制规则跳过，表 100 指向不存在的网关，**出网直接断**。

```sh
detect_gw() {
  # ① 主表现有默认网关（dhclient 设的，最可信；跳过厂商的 <SITE2_GW>）
  # ② eth 各地址同网段的 .1
  # ③ 兜底 <SITE2_GW>
  # 每一步都 ping 验证可达
}
```

⚠ **遗留限制**：探测只在 unit 启动时做一次。**换了网络要重启板子或
`systemctl restart iecu-egress-audi`**。上一块板用 timer + 独立 `-recheck` unit 自动接管
（注意陷阱 57：`RemainAfterExit=yes` 的 oneshot 会让 timer 永远空转）。

### 8.3 入站防线是必需件不是可选项

板子是 **root + 弱口令 `nvidia`**。出网一旦打通，路由器上任何指向它的历史端口转发
都会把 SSH 直通公网，几小时必被爆破。

```sh
iptables -N IECU_GUARD
iptables -A IECU_GUARD -i lo -j RETURN
iptables -A IECU_GUARD -s 127.0.0.0/8    -j RETURN
iptables -A IECU_GUARD -s 10.0.0.0/8     -j RETURN     # ★ 整个 RFC1918 都放行
iptables -A IECU_GUARD -s 172.16.0.0/12  -j RETURN     #   只列当前网段的话，
iptables -A IECU_GUARD -s 192.168.0.0/16 -j RETURN     #   换网络后连本地都进不来
iptables -A IECU_GUARD -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -A IECU_GUARD -m conntrack --ctstate NEW -j DROP
iptables -C INPUT -j IECU_GUARD 2>/dev/null || iptables -I INPUT 1 -j IECU_GUARD
```

脚本：`deploy/net/audi-egress.sh` + `deploy/systemd/iecu-egress-audi.service`

### 8.4 判据

- [ ] `getent hosts modelscope.cn` 能解析（DNS）
- [ ] `ping -c2 223.5.5.5` 通
- [ ] `nc -z -w4 modelscope.cn 443` 通（TCP）
- [ ] `ip route show | grep default` **仍是厂商/DHCP 的那条**（我们没改主表）
- [ ] `iptables -C INPUT -j IECU_GUARD` 成功
- [ ] 从公网侧试一次：非内网源的新连接应被 DROP

---

## 阶段 9 · SSH 入口收敛（清掉别人的钥匙）

### 9.1 检查（三件：公钥、弱口令、AllowUsers）

```bash
cat /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys 2>/dev/null
sshd -T | grep -iE 'authorizedkeysfile|passwordauthentication|permitrootlogin|allowusers|maxauthtries'
awk -F: '$2 !~ /^[!*]/ && $2 != "" {print $1}' /etc/shadow      # 有密码的账户
```

⚠ **`AllowUsers` 一定要查** —— 本板厂商配置里有 `AllowUsers root`，
意味着**除 root 外的账户根本不能 SSH**，不管密码多弱。不查这条会误判攻击面
（本项目就误判过一次，把"nvidia 不能登录"写成了"nvidia 可登录"）。

### 9.1b ★ 测账户密码是不是厂商默认弱口令（部署到不可信网络前必做）

本板实测 **root 和 nvidia 密码都是 `nvidia`**（等于用户名，最弱）。
放到单位内网时 `IECU_GUARD` 只挡公网源，**内网同事是放行的**，所以内网账户安全必须做实。

```sh
# ⚠ 不能用 su 测（板上没有 su，会全部假阴性）；py3.13 也没 crypt 模块。
# 用 openssl 对 /etc/shadow 的哈希比对候选口令：
H=$(awk -F: '$1=="root"{print $2}' /etc/shadow)
SALT=$(echo "$H" | awk -F'$' '{print $3}')
for pw in nvidia root admin password 123456 nvidia123 orin drive; do
  [ "$(openssl passwd -6 -salt "$SALT" "$pw")" = "$H" ] && echo "命中: $pw"
done
```
判据：**能用某密码 SSH 登录进来，就已经证明那是它的密码**（不必再测）。

改密码（`chpasswd` 从 stdin，不进进程表；密码不写进项目/对话）：
```sh
printf 'root:%s\nnvidia:%s\n' "$NEWPW" "$NEWPW" | chpasswd
# 验证：openssl 比对新哈希命中 + 旧口令失效 + 用新密码真的 SSH 登录一次
```

基本 sshd 加固（drop-in，不改主配置每一行，可回滚）：
```
# /etc/ssh/sshd_config.d/60-iecu-harden.conf
MaxAuthTries 3          # 原 6
LoginGraceTime 30       # 原 120
MaxStartups 3:50:10
PermitEmptyPasswords no
X11Forwarding no
# PermitRootLogin / PasswordAuthentication 按用户选择保留或收紧
```
⚠ 改完 `sshd -t` 通过才 `reload`（不 restart：配置有错时 reload 保留旧配置继续服务）。

### 9.2 ★ 公钥可能删不掉（在只读根分区上）

本板的卖家公钥 `vendor@buildhost` 在 `/root/.ssh/` 与 `/home/nvidia/.ssh/` 两处，
**时间戳都是镜像构建时间** —— 是**打进刷机镜像的，不是运行时写的**，
所以刷机/恢复后它会回来。而 `/root` 在只读根分区上，`rm` 直接失败。

**不要 `mount -o remount,rw /`**（那是写厂商根分区，触红线 2）。改走配置屏蔽：

```
# /etc/ssh/sshd_config （/etc 是 overlay，可写且持久，正好盖住镜像自带的东西）
AuthorizedKeysFile /etc/ssh/authorized_keys.d/%u
```

配套：`mkdir -p /etc/ssh/authorized_keys.d && : > /etc/ssh/authorized_keys.d/root`

### 9.3 改 sshd 的安全次序（改错了就彻底失联）

```
① 先确认 sshd -T 里 passwordauthentication yes（否则删完公钥自己也进不来）
② 备份 sshd_config
③ 改
④ sshd -t 语法测试 —— 不通过就回滚，绝不 reload
⑤ systemctl reload sshd（用 reload 不用 restart：配置有错时 reload 失败会保留旧配置）
⑥ 验证：sshd -T | grep authorizedkeysfile
```

### 9.4 判据

- [ ] `sshd -T` 的 `authorizedkeysfile` 指向我们控制的目录
- [ ] 那个目录下的文件是 0 字节
- [ ] **当前 SSH 会话仍然可用**（这是最实在的判据）
- [ ] 原公钥已备份（NAS + `/var/lib/llm/backup-sshkeys/`）

---

## 阶段 10 · 运行时基座（node → CA → git → Python/CUDA/torch）

**顺序有依赖，不能调**：node 是 CA 的前提（从它提取根证书），CA 是 git 的前提，
git 是 ComfyUI-Manager 的前提。

### 10.1 node（第一个，因为后面全靠它）

```
baseline/bin/node → /var/lib/llm/bin/node    （Node 22.23.2 linux-arm64，glibc 2.28+）
```
判据：`node -v`、`ldd` 无 not found、`require()` 十个内置模块、**HTTPS 能出网**。
⚠ 板上**没有 curl/wget**，没有 node 连模型都下不了。

### 10.2 ★ CA 证书（厂商镜像根本没装）

```
/etc/ssl/certs/ca-certificates.crt   不存在
/usr/share/ca-certificates           不存在
dpkg -l ca-certificates              → un（从未安装）
```

⚠ **`comfyui313/run.sh` 里那条 A-136「TLS 修复」指向的就是这个不存在的文件** ——
那个修复是空指针。表现分两种（同一根因）：不设变量报 `CAfile: none`，
设了指向不存在的文件报 `Problem with the SSL CA cert (path? access rights?)`。

```bash
bash deploy/comfyui/fix-ca-certs.sh    # 从 node 内置的 145 个根证书生成
                                       # /var/lib/llm/ca-bundle.crt（217 KB）
```

**落点刻意不在 `gitroot` 下** —— `install-git.sh` 开头会 `rm -rf $G`。

判据：`git ls-remote` 拿到 ref、python `urlopen("https://pypi.org/simple/")` 返回 200。

**为什么 node/dl.js 一直能下载而 git 不能**：node 自带 CA bundle，不看系统那份。
两者信任源不是一个东西。

### 10.3 git（解包版，不能 apt install）

```
baseline/debs/git/*.deb → dpkg-deb -x → /var/lib/llm/gitroot
包装器 /var/lib/llm/bin/git（设 LD_LIBRARY_PATH + GIT_EXEC_PATH + GIT_SSL_CAINFO）
```

⚠ **一定要用包装器**，只设 `PATH` 会漏掉 `GIT_EXEC_PATH`，表现为
`fatal: unable to find remote helper for 'https'` —— git 本体能跑但找不到子命令。

判据：`git --version`、`git-remote-https` 存在且依赖全齐、**`git ls-remote` 成功**。

### 10.4 Python 3.13 + CUDA 12.2 + torch 2.11（解包，不编译）

```bash
tar -C /var/lib/llm -xzf baseline/runtime/py313.tar.gz          # → /var/lib/llm/py313
mkdir -p <STACK_ROOT>/cuda122 && tar -C <STACK_ROOT>/cuda122 -xzf baseline/runtime/cuda-runtime-libs.tar.gz
tar -C <STACK_ROOT> -xzf baseline/runtime/comfyui313-env.tar.gz  # → <STACK_ROOT>/comfyui313
sh /var/lib/llm/mount-stack313.sh                                # bind 回来并去掉 noexec
```

**`<STACK_ROOT>` 按板子选**：批次A `/opt/m0`（独立 26G）；
**本板 `/opt/update`**（它的 `/opt/m0` 与 `/var` 同设备，放 6G 会挤压系统）。
`mount-stack313.sh` 已参数化（`STACK_ROOT` 环境变量 > 已存在的 `/opt/update` > 默认 `/opt/m0`）。

解包核对（都是实测值）：
- `cuda122` = **27 普通文件 + 25 符号链接 = 52**（文档说的"约 52"是含链接的）
- `comfyui313` 是 **`comfyui313/{ComfyUI,venv,run.sh}` 两层**，本体在 `ComfyUI/` 子目录
- 🔴 `cuda122` 里**绝不能出现** `libcuda.so*` / `libnvrm*` / `libnvos*`（那是驱动，必须用板子自己的）

### 10.5 判据：13 项 BOARD-ALL-PASS

```bash
bash deploy/torch-py313/65-verify-on-board.sh
```

⚠ 该脚本原本写死构建 chroot 的 venv 路径，**解包部署的板子会直接 `not found`**，
已参数化（`VENV` > 生产 venv > 构建 chroot）。

本板实测（与基线板逐项对照）：

```
torch 2.11.0 | cuda 12.2 | cudnn 92000 | device Orin | capability (8,7)
① 首次矩阵乘 3.25s（基线 4.49s；分钟级说明在现场编 PTX，架构没对上）
② flash attention OK  ③ mem-efficient OK
④ 注意力峰值 math 1213 MiB → flash 33 MiB（省 97%）
⑤ flex / gqa / pep585 全部原生
⑥a CPU-GPU matmul 最大差 0.000e+00   ⑥b CPU matmul 30 次 NaN 0 次
⑥c cuDNN conv2d OK   ⑦ CUDA Graph OK
→ BOARD-ALL-PASS
```

⑥b 那条最阴险：**用错 OpenBLAS 不报错，只是所有 CPU 数值变成 NaN**。
必须确认 `libtorch_cpu.so` 解析到的是 `/var/lib/llm/cuda122/` 下的 0.3.29，不是系统的 0.3.8。

---

## 阶段 11 · 模型（先探源，再下载）

### 11.1 ★ 不要照着 `models.tsv` 的"换域名"拼 URL

那句「国内走 ModelScope：把域名换成 modelscope.cn 即可」**是错的**。
实测 8 个文件里 **ModelScope 只有 3 个仓库存在**，其余 404 ——
ModelScope 与 HuggingFace 是两个独立平台，仓库名不保证同名同在。

```powershell
node exec.js --file <(推 probe-model-urls.js 后跑)   # 对每个文件 × 三个源实测
```

`probe-model-urls.js` 用 `Range: bytes=0-0` 拿 `Content-Range` 里的总大小
（比 HEAD 可靠，HF 的 CDN 对 HEAD 行为不一致），并与 `models.tsv` 的期望字节数比对。

实测源分布：**hf-mirror.com 八个全有**（主力，7~13 MiB/s）；
ModelScope 只有 Embedding / z_image_turbo / Qwen3.6 主模型三个（但快，19~42 MiB/s）。

### 11.2 落点（与 `models.tsv` 有出入时以板子实际为准）

```
LLM   → /opt/m/llm                真实分区（mmap，不放 FUSE）
生图  → /opt/update/sd-models      真实分区
放大  → /opt/update/sd-models/upscale_models
        ⚠ models.tsv 原本落 /opt/m0，本板的 /opt/m0 与 /var 同设备，改这里
```

⚠ 主模型上游文件名是 `Qwen3.6-35B-A3B-UD-IQ4_XS.gguf`（**无 MTP- 前缀**），
板上存成带前缀的名字。非 MTP 仓库有同名文件但字节数是 `17730509792`，
下错会失去 MTP 投机解码。

### 11.3 下载

```bash
systemd-run --unit=iecu-model-dl --collect /bin/sh /var/lib/llm/tmp/download-models-audi.sh
```
用 `dl.js`（断点续传 + Content-Length 校验），后台跑，从小到大排序
（小文件先跑通链路，避免 18G 下到一半才发现问题）。

### 11.4 判据

- [ ] 每个文件的字节数与 `models.tsv` **精确相等**（字节数就是校验值）
- [ ] **ComfyUI 的加载器下拉里能看到模型名** —— 这才是搜索根生效的判据，
      不是"目录里有文件"。查 `/object_info/UnetLoaderGGUF` 的 `unet_name` 候选。

---

## 阶段 12 · 服务（ComfyUI → 面板 → 推理）

### 12.1 ComfyUI

```
deploy/torch-py313/comfyui.service.new → /etc/systemd/system/comfyui.service
deploy/comfyui/extra_model_paths-audi.yaml → comfyui313/ComfyUI/extra_model_paths.yaml
```

⚠ **搜索根要按板子改**：本板版**删掉了 `/opt/m0` 这个根**，物理上防止将来误放。
每加一类模型，**每个根都要同步加同一行**，否则模型放进去照样"找不到"。

⚠ **ComfyUI 有两套启动档，不能只照抄旧的 `--highvram` 单档**（2026-09-02 已验证）：

| 档位 | 参数 | 用途 | 结论 |
|---|---|---|---|
| `image` | `--highvram --disable-smart-memory` | 单模型生图 | 必需。统一内存下 offload 省不出物理内存却要真搬，DynamicVRAM 档实测慢 14~38% |
| `video` | `--disable-smart-memory --disable-pinned-memory` | MiniMax-H3 多阶段视频 | 必需。DynamicVRAM 能释放上阶段模型，243 帧 / 10.13 秒已跑通 |

切换用 `deploy/comfyui/comfy-profile.sh`，**不要另造第二个 unit**：两个档本质是同一个
`comfyui.service` 的两组参数，第二个 unit 会产生两套 Conflicts 与两个 is-active 判据。

⚠ **`video` 档与 `deploy/torch-py313/sitecustomize.py` 必须同进同退**：
去掉 `--highvram` 后 comfy-aimdo 的 C 扩展会先占用 glibc 2.31 的 static TLS，
随后 import torch 报 `libc10.so: cannot allocate memory in static TLS block`，服务起不来，
与内存余量无关。`comfy-profile.sh video` 会先检查它在不在；**删掉这个文件就必须把
`--highvram` 加回去。**

**判据**（三条都要）：
- [ ] 端口 8188 真的在听（`systemctl is-active` 不算数，ComfyUI 要 20~50 秒才开始监听）
- [ ] `journalctl -u comfyui | grep -c 'IMPORT FAILED'` **为 0**
- [ ] 启动耗时正常（本板 22 秒；一个带 matplotlib 的节点包曾让它涨到 408 秒）

两条会误导的日志：`You need pytorch with cu130 or higher`（cu122 下部分优化路径不可用，主路径正常）；
`SeedVR2: Flash Attention ❌` —— 它检查的是 **`flash-attn` pip 包**，
而我们的 torch 是把 FA 编进 SDPA 后端的（13 项验证里 `fa PASS`），**两个不同的东西**。

### 12.2 面板

```
deploy/panel/server.js           → /var/lib/llm/panel/server.js
deploy/panel/dist/index.html     → /var/lib/llm/panel/index.html        ★ 摊平！
deploy/panel/dist/assets/*       → /var/lib/llm/panel/assets/*          ★ 摊平！
deploy/config/config-audi.json   → /var/lib/llm/config.json
deploy/llama/3.6_chat_template-v10.jinja → /var/lib/llm/
panel/set-panel-password.sh '<密码>'
```

⚠ **`dist/` 必须摊平到 `panel/` 根**：`server.js` 的 `ROOT = __dirname`，
`dist/` 子目录**不在服务路径上**。上一块板曾因此跑了 13 小时的旧界面。

**判据**：`grep -oE 'index-[A-Za-z0-9_-]+\.js' index.html` 必须与 `assets/` 里实际文件同名；
`/`、`/api/auth/state`、`/api/status` 都返回 200。

### 12.3 推理

```
baseline/llama/llama-b10498-5ecbe1ac1-cuda-cpu.tar.gz → tar -C /var/lib/llm -xzf
deploy/llama/run-server.sh    → /var/lib/llm/llama/run-server.sh    ★ 在 llama/ 下！
deploy/llama/run-embedding.sh → /var/lib/llm/llama/run-embedding.sh
```

⚠ unit 的 `ExecStart` 指的是 `/var/lib/llm/llama/run-server.sh`，
**不是 `/var/lib/llm/run-server.sh`** —— 差一层就 `203/EXEC`。
⚠ 解包会覆盖启动脚本，**解包后要重推 `deploy/` 里的版本**（deploy 才是源）。

**二进制判据**（必须设 `LD_LIBRARY_PATH`，否则 `ldd` 会假报 not found）：
```bash
LD_LIBRARY_PATH=/var/lib/llm/llama/bin-cuda ldd .../llama-server | grep 'not found'   # 应为空
LD_LIBRARY_PATH=/var/lib/llm/llama/bin-cuda ldd .../llama-server | grep libcuda
#   → 必须解析到 /usr/lib/libcuda.so.1（板子自己的驱动）
```

**服务判据**（`8080` 在听 ≠ 能用）：
```
/health 返回 503 {"message":"Loading model"} → 还在 mmap，继续等
/health 返回 200                              → 才算加载完（本板 88 秒，基线 78~95 秒）
```

加载日志里应看到：`creating MTP draft context`（投机解码）、
`loaded multimodal model`（mmproj）、`n_ctx_slot = 131072`、`model loaded`。

### 12.4 速度实测（以 `/metrics` 为准，不看感觉）

```
llamacpp:tokens_predicted_total / tokens_predicted_seconds_total → 解码 tok/s
llamacpp:prompt_tokens_total    / prompt_seconds_total           → prefill tok/s
```
本板实测：解码 **35.5 tok/s**（基线板 MTP 档 33 tok/s）。

### 12.5 内存归因（本板最容易看错的地方）

```
真实占用 = nvmap（/sys/kernel/debug/nvmap/iovmm/clients） + RssAnon（/proc/<pid>/status）
```
本板推理态：nvmap 20.35 GB + RssAnon 2.56 GB（主推理）+ 0.97 GB（向量）。
**`systemd` 报的 `MemoryCurrent` 与 `ps` 的 RSS 都会差一个数量级**（权重经 nvmap 映射，不计入 cgroup）。

---

## 阶段 13 · 公网入口（转发）

### 13.1 两条路，先判断哪条成立

| | 反向隧道（frps） | 端口转发（DNAT） |
|---|---|---|
| 批次A | **只能用这条** | ❌ 默认路由指向 Hypervisor 内部网关，回包进黑洞（陷阱 19） |
| 本板 | 可用 | ✅ 也可用（走 table 100，回程通） |

隧道的好处：板子挪到任何网络都不需要那边开端口。**推荐用隧道。**

### 13.2 两块板并行时，三处必须错开

| | 批次A | 本板 |
|---|---|---|
| frps proxy 名 | `iecu-panel` / `iecu-ssh` | **`iecu2-panel` / `iecu2-ssh`** |
| 隧道端口 | <PANEL_TUN1> / <SSH_TUN1> | **<PANEL_TUN2> / <SSH_TUN2>** |
| Caddy 站点 | `:<PUBLIC_PORT1>` | **`:<PUBLIC_PORT2>`** |

**frps 对重名 proxy 直接拒绝注册。** 端口撞了同理。

### 13.3 LXC 侧（frps + Caddy 在 你的宿主机 __FRPS_LAN_IP__）

```yaml
# docker-compose.yml
iecu-frps.ports:       + "127.0.0.1:<SSH_TUN2>:<SSH_TUN2>"   # 新板 SSH 隧道
iecu-edge-caddy.ports: + "<PUBLIC_PORT2>:<PUBLIC_PORT2>"             # ★ 容易漏！
```

⚠ **光在 Caddyfile 里加站点是不够的** —— Caddy 容器原本只映射 `:PUBLIC_PORT1` 那个端口，
不加容器端口映射，站点起来了但外面进不来。

Caddyfile 追加一个与 `:PUBLIC_PORT1` 那段**完全并列**的站点（上游 `iecu-frps:<PANEL_TUN2>` +
回退 `__BOARD_LAN_IP__:9000`，`/v1` 与 `/embed` 同样 403 拦截）。
**`:PUBLIC_PORT1` 那一段是上一块板的，一个字都不要改。**

### 13.4 路由器侧

**只动防火墙的端口转发，其余一律不碰**（家用路由器是家庭网络的关键设备）。
公网端口**由用户分配后告知**，不要自己挑（同号段可能已给别的服务）。

### 13.5 板子侧

```
baseline 里没有 frpc → 从 GitHub 取对应版本（必须与 frps 大版本一致，本例 0.70.1 arm64）
deploy/frp/frpc → /var/lib/llm/frp/frpc
frpc.toml：serverAddr 写**域名不写 IP**（家里是 DDNS，一天内就可能变）
以专用非特权用户 iecufrp(uid 998) 运行，配置 600 权限
```

**token 的处理**：在 LXC 上生成完整 frpc.toml → 传到本机 → 推板 → 两边删临时文件。
**token 全程不进对话记录。**

### 13.6 判据（端到端，不是"注册成功"）

```bash
# 在 LXC 上打隧道口，应该拿到板子的 SSH banner
echo | nc 127.0.0.1 <SSH_TUN2>      # → SSH-2.0-OpenSSH_9.3
```
- [ ] frps 日志里两个 proxy 都 `start proxy success`
- [ ] 公网 `https://<域名>:<PUBLIC_PORT2>/` 能连到 Caddy（面板未起时回 503 也算通）
- [ ] 公网 `/v1/models` 返回 **403**（数据面拦截在公网侧生效）
- [ ] frps 日志里客户端源 IP 是路由器地址 → 说明走的是公网域名 → NAT 回环正常 → 挪到外网同样可用

---

## 阶段 14 · 验收（每条都要真做）

### 14.1 模式互斥

```
起 comfyui  → 8080 应停、8188 起、8081 与 9000 不动
起 llm-server → 8188 应停、8080 起
comfyui 必须保持 disabled（生图是临时态，断电重启回推理模式）
```
本板实测：切生图时 nvmap 从 20.36 GB 降到 1.04 GB，available 从 4.0 GB 回到 19.9 GB。

### 14.2 断电重启

**这一步不能省**，板子会放在别处。重启后确认：

- [ ] 固定地址、DHCP 地址、`172.31.254.38` 三个都在
- [ ] 出网通（DNS + ping + TCP）
- [ ] `IECU_GUARD` 挂在 INPUT
- [ ] 合并视图自动挂回来
- [ ] 隧道自动重连（可能报一次 `proxy already exists`，30 秒后成功 —— frps 那边旧注册
      还没到 90 秒心跳超时，正常）
- [ ] 推理与面板自启，ComfyUI 保持不启
- [ ] **NTP 仍然 `synchronized: yes`**（这条最容易漏，见阶段 7.2）

### 14.3 生图与对话都要拿到真实产物

- [ ] 文生图：`status=success` **不算**，必须拿到图片文件名并下载看图
      （本板：首张 79.6s，连续 **30.2s**，1024²/8 步）
- [ ] ⚠ 测连续出图**必须换种子** —— 相同种子返回缓存（3 秒、文件名不变），那是假数据
- [ ] 对话：`/v1/chat/completions` 返回正文，`/metrics` 有实际计数

---

## 附录 A · 本项目反复吃亏的两类判据错误

### A.1 管道吞掉退出码（本轮犯两次）

```bash
if docker run ... caddy validate | tail -5 ; then echo "✓ 通过" ; fi    # ★ 永远成立
if git ls-remote ... | head -3 ; then echo "✓ 可用" ; fi                # ★ 永远成立
```
管道的退出码是**最后一个命令**的，永远 0 —— **失败被读成"通过"**。
要么 `set -o pipefail`，要么重定向到文件再看退出码，要么别接管道。

### A.2 PowerShell 内联命令的引号（本轮犯五次）

`$(...)`、`\"`、`|`、`$var` 都会被 PowerShell 先解释；`rm -f` 的参数还可能被
权限系统解析成 `/` 而被拦下。

**CLAUDE.md 早就写了：凡是带引号/变量/管道的命令，一律 `exec.js --file <脚本>`。
没有例外。** 为省一个文件反复吃亏是本轮最不该发生的事。

### A.3 "上游说成功"与"我要的生效"是两个命题

同一族的坑本项目已记录七个：`systemctl is-active` active ≠ 端口在听；
API 返回 200 ≠ 机制生效；传输成功 ≠ 生效；`is-enabled` enabled ≠ 会启动；
`scan()` 说无需改写 ≠ 补丁应用了；命令行参数传进去 ≠ 生效（llama.cpp 取**第一个**重复参数）；
`tar` 报 0 ≠ 内容完整（要核对条目数与符号链接数）。

**判据必须落在"用户关心的那件事"上**：端口探测、拿到图片文件、`/metrics` 有计数、
`sshd -T` 的实际输出、`/proc/<pid>/environ` 的实际环境。

### A.4 工具缺失会伪装成功能缺失（本项目栽过四次）

`strings` 全报 no（其实没装 binutils）；`command -v python3` 空（其实只缺一个可执行文件）；
`su` 不存在（导致"读不到配置"的假警报）；`ldd` 报 not found（其实是没设 `LD_LIBRARY_PATH`）。

**判断某个东西在不在，至少两种独立方式交叉验证。**

---

## 附录 B · 脚本索引（全在 `../iecu/scripts/`）

| 阶段 | 脚本 |
|---|---|
| 1 接触 | `lanscan.js` `portscan.js` `arpsweep.js` `vehicle-probe.js` `udplisten.js` |
| 2-3 探索 | `phase0-identity.sh` `phase0-toolchain.sh` `phase0-verify.sh` `inventory-data.sh` `probe-cuda-driver-version.sh` |
| 4 清理 | `backup-board-to-nas.sh` `verify-before-delete.sh` `delete-adas-data.sh` |
| 5 存储 | `setup-merged-storage.sh` `check-storage-merge.sh` |
| 6 网络 | `enable-lan-ip.sh` |
| 7-8 对时/出网 | `post-router-setup.sh` `fix-ntp.sh` |
| 9 SSH | `remove-vendor-sshkey.sh` `block-vendor-sshkey.sh` |
| 10 基座 | `verify-node.sh` `fetch-git-debs.sh` `diagnose-ca-certs.sh` `apply-ca-fix.sh` `unpack-runtime.sh` `phase3-mount-and-check.sh` |
| 11 模型 | `probe-model-urls.js` `download-models-audi.sh` `board-dl.js` |
| 12 服务 | `setup-comfyui.sh` `verify-git-and-comfyui.sh` `verify-panel.sh` `deploy-llama.sh` `verify-llama-binaries.sh` `wait-and-bench-llm.sh` |
| 13 隧道 | `check-lxc-frps.sh` `lxc-gen-frpc-audi.sh` `lxc-apply-edge-config.sh` `enable-frpc.sh` |
| 14 验收 | `verify-mode-exclusion.sh` `final-state-check.sh` |
| 跨板搬运 | `clone-llama-from-old-board.ps1` `pack-llama-on-old-board.sh` `inspect-old-llama-deep.sh` |
