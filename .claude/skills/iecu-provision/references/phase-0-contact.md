# 阶段 0 — 直连接触、身份确认、原始状态存档

目标：**在改动任何东西之前**，确认本板子和基线板是同一种，并把出厂状态留档。

---

## 0.1 物理接入

板子出厂时 `eth.254` 上带 `172.31.254.38/24`，这个地址是**救命通道**——
后面所有网络改动都不能碰它。

PC 侧配同网段地址后直连网线：

```powershell
# 记下原配置，做完要还原
Get-NetIPAddress -InterfaceAlias '以太网' | Format-Table
New-NetIPAddress -InterfaceAlias '以太网' -IPAddress 172.31.254.100 -PrefixLength 24
```

```powershell
$env:IECU_HOST="172.31.254.38"; $env:IECU_PORT="22"
node .claude\skills\iecu\scripts\exec.js "uname -a; id"
```

登录是 **root / nvidia**。本板子不走 infra skill 的私钥体系。

> 本机 Windows 没有 sshpass / plink / python，系统 `ssh.exe` 在非交互 shell 里无法输密码。
> 密码认证自动化只有 Node + `ssh2` 这一条路，脚本在 `.claude/skills/iecu/scripts/`，
> 首次用要在该目录 `npm install`。

---

## 0.2 身份五项核对

```bash
cat /proc/device-tree/model | tr -d '\0'
dpkg -l 2>/dev/null | grep nv-driveos-linux | head -1
ldd --version | head -1
uname -r
cat /proc/cmdline | tr ' ' '\n' | grep -E 'root=|board_name|aurixfw|isolcpus'
```

基线值：

```
p3663-XXXX
nv-driveos-linux-*  6.0.9.0-1
glibc 2.31
5.15.116-rt-tegra
root=/dev/vblkdev0  board_name=p3663-a01  aurixfw=AFW  isolcpus=5
```

**五项必须全对。** 任何一项不同，先停下来判断影响，不要直接往下装。

### CUDA 驱动 API 版本（最关键的一项，单独说）

整套版本组合是围着它反推的：驱动 12.1 → CUDA 必须 <12030 → Tegra 变体只有 12.2 →
12.2 的 fp16 头文件在 C++20 下编不过 → torch 必须 C++17 → torch 只能 2.11。

板上没有 `nvidia-smi`。读法是 `dlopen("libcuda.so.1")` → `cuInit(0)` → `cuDriverGetVersion(&v)`，
期望 `v == 12010`。

⚠ `/sys/module/nvidia/version` 读到的 `541.1.2` 是**驱动包版本号**，不是 CUDA API 版本。

---

## 0.3 这是 DRIVE OS，不是 Jetson

**所有 Jetson / JetPack 教程在这里成体系失效**：`flash.sh`、`jetson_clocks`、
改 extlinux、改设备树 carveout、`nvargus` 全都不适用。

你 SSH 进去的 Linux 是 **Type-1 Hypervisor 上的一个 Guest VM**。
判据：`lsmod` 有 `tegra_hv`；根设备是 `/dev/vblkdev0` 这种虚拟块设备。

按 Jetson 的思路检索资料，两轮下来会全部作废——这是实际发生过的事。

---

## 0.4 原始状态存档

改任何东西之前先采一次全量快照，出问题时这是唯一的对照基准：

```powershell
node .claude\skills\iecu\scripts\probe.js cmdset.json 出厂快照.json
node .claude\skills\iecu\scripts\dump.js 出厂快照.json 出厂快照文本\
```

至少要留下的几项：

```bash
df -h                          # 分区布局与出厂占用
mount                          # 挂载选项，注意 /opt/* 普遍带 noexec
ip -br addr; ip route; ip rule  # 网络原状
iptables -S                    # 防火墙原状
systemctl list-unit-files --state=enabled   # 厂商开机自启了什么
dpkg -l                        # 厂商装了什么
ls -la /opt/update/            # FOTA 固件包，腾空间时要迁走的东西
```

---

## 0.5 完成判据

- [ ] SSH 能进，`id` 返回 root
- [ ] 身份五项与基线一致
- [ ] `cuDriverGetVersion` 返回 12010
- [ ] 出厂快照已落盘到本地

判据不过就不要进阶段 1。**尤其是驱动版本**——不一致的话，
后面解包的 wheel 会在第一次碰 GPU 时报错，而错误信息完全指不到根因。
