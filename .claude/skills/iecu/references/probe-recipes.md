# 采集配方 — cmdset 格式与可复用命令库

配套脚本 `scripts/probe.js`（断点续跑批量执行）+ `scripts/dump.js`（JSON→分组文本）。

## cmdset.json 格式

一个数组，每项一条命令：

```json
[
  {"group":"cpu", "name":"lscpu", "cmd":"lscpu", "timeout":20},
  {"group":"cpu", "name":"cpu-freq", "cmd":"for c in ...; do ...; done"}
]
```

- `group`：dump.js 按此分文件（如 `cpu.txt`）。
- `name`：断点续跑的键。**probe.js 会跳过 out.json 里 code 为 0/1 的同名项**——所以改了命令内容后要么删旧 out.json，要么换 name，否则读到的是旧结果。
- `cmd`：单条 shell（bash）。`pty:false` 执行，所以别用交互式命令。JSON 里转义反斜杠要写 `\\`，如 `tr -d '\\000'`。
- `timeout`：秒，默认 20。`tegrastats`/`ping`/端口扫描这类要显式加大。

运行：
```powershell
node scripts/probe.js cmdset.json out.json   # 断线自动重连、增量落盘、可反复跑续采
node scripts/dump.js out.json txtdir/         # 拆成 txtdir/<group>.txt，并列出空/失败项
```

## 坑（都踩过）

- **PowerShell `... | Out-String` 缓冲到进程结束**：看不到 probe 的实时进度。要么 `run_in_background` 后轮询 out.json，要么直接读脚本 stderr 的产物。别从"无输出"推断"在跑"。
- **ECONNRESET 会中途断**：这块板子长会话易断（网络抖动），probe.js 已做重连+续跑，断了重跑同一条命令即可从断点继续。
- **密码硬编码**在脚本里（root/nvidia，出厂默认）。改目标用环境变量 `IECU_HOST/IECU_USER/IECU_PASS`。
- **只读优先**：探查一律用只读命令。唯一执行过的写操作是 `ip addr add`（网络配置，运行时可逆）。破坏性动作先查 SKILL.md 红线。

## 可复用命令库（按领域，直接抄进 cmdset）

**身份定性**（第一步永远先跑这个，别假设是 Jetson）
```
tr -d '\000' < /proc/device-tree/model; echo
cat /proc/cmdline
lsmod | grep -iE 'tegra_hv|vblk'
dpkg -l | grep -iE 'driveos|nvidia-l4t' | awk '{print $2,$3}'
```

**CPU/调频/电源**
```
lscpu; cat /sys/devices/system/cpu/{online,offline,isolated}
for c in /sys/devices/system/cpu/cpu[0-9]*/cpufreq; do echo -n "cur="; cat $c/scaling_cur_freq; echo -n "gov="; cat $c/scaling_governor; done
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_available_governors
cat /etc/systemd/scripts/disable_power_features_linux.sh
for f in railgate_enable elpg_enable aelpg_enable; do echo "$f=$(cat /sys/devices/platform/17000000.ga10b/$f)"; done
```

**内存精确归因**（PSS，不要用 RSS 相加）
```
free -m; grep -E 'MemTotal|MemFree|MemAvailable|Cached|Slab|Shmem' /proc/meminfo
# 逐进程 PSS：
for p in $(ls /proc|grep -E '^[0-9]+$'); do [ -r /proc/$p/smaps_rollup ]||continue; pss=$(awk '/^Pss:/{s+=$2}END{print s}' /proc/$p/smaps_rollup); [ "$pss" -gt 2000 ]&&echo "$pss $(cat /proc/$p/comm)"; done|sort -rn|head -40
# used 归因：
awk '/MemTotal/{t=$2}/MemFree/{f=$2}/^Cached/{c=$2}/Buffers/{b=$2}/Slab/{s=$2} END{print "used="(t-f-c-b)/1024"MB slab="s/1024"MB"}' /proc/meminfo
cat /sys/kernel/debug/nvmap/generic-0/size            # carveout 池大小
cat /sys/kernel/debug/nvmap/iovmm/clients             # GPU 客户端占用
```

**存储/分区**
```
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,RO; df -hT; blkid; cat /etc/fstab
du -xh --max-depth=1 /opt/m0 2>/dev/null | sort -rh | head
```

**网络**
```
ip -br a; ip r; ip neigh show | grep -v FAILED
ethtool eth 2>&1 | grep -E 'Speed|Duplex'; ethtool -i eth
grep -rIn '172.31' /etc/systemd/scripts/tn_eth_init.sh | head
ss -tulpn | head -60
```

**温度/功耗**（一次性快照；持续监控用 thermal-monitor.js）
```
for z in /sys/class/thermal/thermal_zone*; do echo "$(cat $z/type)=$(cat $z/temp)"; done
for c in /sys/class/thermal/cooling_device*; do echo "$(cat $c/type) cur=$(cat $c/cur_state)/$(cat $c/max_state)"; done
timeout 6 tegrastats --interval 1000
```

**服务/进程**
```
systemctl list-units --type=service --state=running --no-pager --no-legend
systemctl list-units --state=failed --no-pager
ps -eo pid,rss,pcpu,comm --sort=-rss | head -25
```

**扫邻居 VM / 开放端口**（确认哪些能登录）
```
for ip in 172.31.200.34 172.31.254.34; do for p in 22 23 80 443; do timeout 1 bash -c "echo >/dev/tcp/$ip/$p" 2>/dev/null && echo "$ip:$p OPEN"; done; done
```

## 已执行的命令集清单（scratchpad，session 级会被清）

本次 16 个 cmdset（cmdset1..16）覆盖：系统/CPU/内存/GPU/存储/引导/网络/CAN/摄像头/外设/服务/温度/安全 → hypervisor 边界/厂商脚本 → Aurix/备份 → 网络配置 → web 界面/RTSP → AVM 流 → 邻居 VM 扫描 → PSS 归因 → 隐形内存追踪 → 调频。原始 JSON 与分组文本当时在 scratchpad，**不持久**；要复现直接用上面命令库重采。
