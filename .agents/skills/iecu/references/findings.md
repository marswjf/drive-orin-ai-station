# 分领域发现（速查）

> 数据采集于 2026-08-10 全量只读勘察。每条结论的证据强度见 `evidence-levels.md`；这里给可操作的速查事实。
> 完整图文（结构图/曲线/预算表）在 `report/index.html`。

---

## 平台与虚拟化

- 板号 `p3663-XXXX`（tegra234 / Orin），DRIVE OS Linux 6.0.9.0，内核 `5.15.116-rt-tegra`（PREEMPT_RT），Ubuntu 20.04，SELinux enforcing。
- 你在 **Guest OS VM**。同机还有：Storage Server VM（独占物理盘，切成 vblkdev 下发）、其他 VM（CAN 网关、显示等）、FSI 功能安全岛（SoC 内独立安全核，31 通道 `FsiComAppChConf*`：LIDAR_PERCEPTION/LOCALIZATION/NP_PLANNING…）。
- 资源由 Hypervisor 的 **PCT（Platform Configuration Table，`pct=linux`）静态分配**，Guest 内改不了。
- **独立芯片 Aurix TC397**（ASIL-D 安全 MCU）在 `172.31.200.34` 在线，管电源时序 / watchdog / FORCE_RECOVERY / 交换芯片配置 / 刷机恢复。SSH 够不到。

## CPU / GPU / 加速器

- 12× Cortex-A78AE，3 簇×4 核，锁 2009.6 MHz（governor=performance，空载不降频）。`isolcpus=5` 隔离 1 核给实时/安全任务，`nproc`=11。
- GPU：Ampere GA10B，`17000000.ga10b`，2 GPC×4 TPC ≈ 2048 CUDA / 64 Tensor 核。设备节点 `/dev/nvhost-*`、`/dev/nvidia0`。
- **2× NVDLA + 1× PVA 完全闲置**（时钟常开 @1331/@1011，负载 0%）——白捡的算力，`trtexec --useDLACore=0/1` 可分流。
- 软件栈：CUDA 11.4.460（**无 nvcc**）、TensorRT 8.6.12、cuDNN 8.9.2、DriveWorks 5.16.61。架构 aarch64 + SM 8.7。

## 内存（三段缩水，细节见 evidence-levels + report 第3节）

- 物理 32GB → Guest 30.45 GiB（PCT）→ MemTotal 28.7 GB（内核保留）→ 停栈后可用 **24.6 GB**。
- 停智驾栈释放 **11.1G**（用户态进程实占）。剩下的 4.1G `used` 里进程仅 ~200MB，**约 3.9G 是内核级隐形预留，停服务拿不回**（构成未完全查清，见 C 档）。
- GPU 内存走统一内存：大块从 iovmm 动态分配（即从那 24.6G 出），小块连续走 generic-0 的 1GB carveout 池。

## 存储 / 分区

| vblkdev | 容量 | 挂载 | 属性 | 用途 |
|---|---|---|---|---|
| 0 | 6.9G | `/` | **ro** 91% | 根，仅剩 383MB |
| 1 | 256M | `/persistent` | rw | `/etc` overlay 上层落这 |
| 23 | 26G | `/opt/m0` | rw 31% | 日志/coredump |
| 50 | 30G | `/opt/m` | rw 2% | **28G 空闲，放模型/权重首选** |
| 51 | 4G | — | rw | 与 /app 同 UUID，A/B 备槽 |
| 52 | 4G | `/app` | **ro** 92% | 智驾应用本体 |
| 54 | 40G | `/opt/update` | rw 58% | OTA：app.img 4.1G + 地图 4.3G |
| 56 | 20G | `/opt/other` | rw 4% | `/var` overlay 上层；**Docker data-root 建议放这** |

- 可回收约 7.8G：`/opt/m0/tmp_logs`(3.9G) + `corefile`(2.5G) + `*.tar.gz`(0.8G) + `/var/log`(641M)。清前确认不需要做故障回溯。
- 根只读 → `apt install` 会失败，别往 `/` 装东西。

## 网络（详见 report 第6节 + 结构图）

- 物理 `eth` = MGBE3 万兆口（10Gb/s），内核里由 `mgbe3_0` 改名而来。MAC `02:80:5E:1F:01:26`，MTU **1466**（非1500）。
- 16 个 VLAN 子接口，IP 全由 `tn_eth_init.sh` 硬编码。关键几条：`eth.254`=172.31.254.38（诊断口，PC 直连走这个，PVID=254），`eth.200`=Aurix 链路，`eth.8`=默认网关（车不在不通），`eth.3`=感知域（16 个摄像头/雷达 MAC）。
- 交换芯片 Marvell **88Q5072**，Tegra 侧 `status=disabled`，由 Aurix 配置，Guest 改不了物理口↔VLAN 映射。
- 接局域网：IP 配在 `eth.254`（PC 直连能通 254 说明该口 PVID=254）。已配 `__BOARD_LAN_IP__/24`，网关 __ROUTER_IP__，运行时生效未持久化。持久化用独立 systemd unit，别改 `tn_eth_init.sh`。
- DNS 指公网（223.5.5.5 等），`/etc/hosts` 有阿里云 OSS 内网地址；配合 recorder/shadow 进程，**接外网前想清楚是否接受数据外传**。

## 温度（详见 report 第5节）

- 11 温区可读，Guest 内**无 trip_point / cooling_device**，控温在 Hypervisor/BPMP/Aurix 下层，且收不到告警 → **监控必须自己做**。
- 满载 tj 峰值 72.8°C，停栈空载稳在 ~67°C。67°C 是"地板"（省电全关所致），非散热不良。
- 板级传感器（EXT0-remote，tmp451）比 SoC 低约 12°C。
- 加载后温度未测。自定行动线 85°C（系统真实阈值读不到）。

## 后台服务

- 平台层（**别停**）：`nv_fsicom_daemon`、37×`nv_tzvault_daemon@*`、`nv_mcc_daemon`、`nv_virtual_shutdown`、`nv_gosvm_nvlog`、`idps`（车载入侵检测，抓 eth.3/4/7/8/9）。
- 应用层（**可停，已验证可逆**）：33×`mfrlaunch`（Momenta 智驾栈，`MODEL_ENV_ID=orinx_6090.1_linux`）+ TTTech MotionWise + AUTOSAR Adaptive（`execution-manager`/`routingmanagerd`）。入口 `/app/application_start.sh` → `auto_startup.sh`。
- 三个 failed unit：`docker`（overlay-on-overlay，可修）、`nv_rootfs_expand`（根分区没扩满，别碰）、`nv_networkd_wait_online`（等外网超时，接网自消）。

### 停栈 SOP（已验证，替代危险的 shutdown_service.sh kill）

```bash
systemctl stop application_start.service          # 停 systemd 入口
pkill -TERM -f 'bin/crash_monitor'                # 停看门狗防自动拉起
pkill -TERM -f 'obf_em/bin/execution-management'  # 停 EM
pkill -TERM -f mfrlaunch                           # 停所有 mfrlaunch
pkill -TERM -f 'CpAp.*_FreeRunning'; pkill -TERM -f msfss_maincc; pkill -TERM -f HmiServiceExec
# 验证：pgrep -c mfrlaunch 应为 0；free -m 可用应涨到 ~24.6G；观察 20s 确认没被拉起
# 恢复：systemctl start application_start.service（或重启板子）
```

## 外设

- 摄像头：无 `/dev/video*`，走 NvSIPL/DriveWorks；底层 `tegra_camera_rtcpu`/`nvhost_vi5`/GMSL 串行器驱动齐全。当前全黑图（车不在）。
- CAN：Guest 内无 `can0`、无 mttcan 驱动，走 IVC。想玩 SocketCAN 在此 VM 做不到。
- I²C 7 条、GPIO 164+32 线（`gpioinfo` 可用）、无 ttyTHS/ttyUSB、控制台 ttyS2@115200。

## 远程看画面（详见 report 第8b节）

- **无 Web 界面**（无 80/443/8080，无 web server 进程）。对外只有 SSH 22 + RTSP 8554。
- RTSP 8554 服务在跑但当前无流（摄像头黑图）。接 GMSL 摄像头后才有意义。
- x11vnc/Xorg/xterm 已装，可起 dummy 虚拟屏 + VNC（`/dev/dri` 有渲染节点但无显示连接器，别指望 HDMI 出画面）。
- SSH 端口转发可用（无 `AllowTcpForwarding no`）：`ssh -L 8554:127.0.0.1:8554 -L 5900:127.0.0.1:5900 root@__BOARD_LAN_IP__`。

## 刷机与恢复（详见 report 第9节）

- SSH 里很难变砖（引导链全在 Guest 外：`/boot` 空、无 extlinux、无 efivars、无 mtd、无 nvbootctrl）。唯一从 SSH 变砖的路是写 `/dev/vblkdev*`。
- 真要恢复：Aurix 串口（115200 8N1）发 `tegrarecovery on` → Orin 进 RCM → 主机 `bootburn.py` 重刷。**需要串口 pinout + DRIVE OS SDK + 签名镜像，目前都没有。**
- 有回滚素材：`tn_backup.sh`、`/opt/backup`（标定+vehicle.yaml）、vblkdev51 A/B 备槽、`/opt/update/app.img`。
- 动手前先备份：`tar czf /opt/m/backup-<date>.tar.gz /etc/systemd/scripts /etc/systemd/system /etc/fstab /etc/ssh /opt/backup /opt/etc /app/application_start.sh` 再 scp 回本地。
