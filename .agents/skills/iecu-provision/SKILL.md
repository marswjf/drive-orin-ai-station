---
name: iecu-provision
description: 把一块出厂状态（裸车机）的创时智驾 IECU 3.1 域控制器，从直连网线接入开始，一步步部署成与现有基线板完全一致的状态——网络、出网、存储规划、运行时基座、LLM 推理栈、生图栈、运维面板、反向隧道。当用户说"新板子""再来一块板""重装""刷回去""部署到另一台""裸机开始""按基线装一台"时使用。关键词：新板子、裸机部署、provision、复制基线、172.31.254.38、直连、DRIVE AGX Orin、p3663、整机部署、恢复基线。
---

# 把一块新板子部署成基线状态

> 这个 skill 只管**从零到基线**。板子已经在跑、要日常维护或改东西，用 `iecu` skill。
> 要导入 ComfyUI 工作流，用 `comfyui-import` skill。

## ★ 动手前先读 WORKFLOW.md

**`WORKFLOW.md` 是可操作的完整顺序**（14 个阶段，每步带判据），
在**两块不同牌子的同源板子**上实走验证过：批次A（2026-08 上中旬）、
本板（2026-08-17 一天内从裸板到全栈）。

本文件（SKILL.md）讲的是**为什么这么做**与不可逾越的红线；
`WORKFLOW.md` 讲的是**按什么顺序做、每步怎么验**。两者配套：

```
WORKFLOW.md                     ← 照着做（顺序 + 命令 + 判据 + 坑）
  ├─ references/board-diff-audi-20260817.md   两块板的逐项差异实测
  ├─ references/phase-*.md                     每阶段的深度原理
  └─ ../iecu/scripts/                          全部工具脚本
```

## ★★ 最重要的一条：同源 ≠ 同配置

两块板的**板号、DRIVE OS、glibc、内核、CUDA 驱动 API 全部一致**
（所以 `baseline/` 的编译产物能直接用），但**软件配置差得很多**：
诊断口要不要打 VLAN tag、跑不跑 DHCP、默认路由指哪、`/opt/m0` 是独立分区还是
与 `/var` 共设备、SELinux 是 enforcing 还是 Permissive、镜像里有没有别人的 SSH 公钥、
装没装 `ca-certificates`——**这些每一项在两块板上都不一样**。

**唯一不变的只有 `172.31.254.38` 这个直连诊断地址。**

→ **每块新板都必须重新做一遍全量探索（WORKFLOW 阶段 3），不能照抄上一块。**

---

## 一句话策略

**不重编，只落地。** 四小时的编译产物、整套 CUDA 运行时、Python 解释器、ComfyUI 环境、
llama.cpp 二进制都已经打好包并校验过，新板子上是解包 + 配路径 + 起服务，不是重新构建一遍。

归档位置：

| 内容 | 位置 |
|---|---|
| 全部部署产物与配置 | 项目 `baseline/`（**23 个文件 约 3.3 GB**，自足，不依赖外部位置）|
| wheel（重编要四小时，唯一不可再生的部分） | `baseline/wheels/` |
| CUDA 运行时 / ComfyUI 环境 / Python 解释器 | `baseline/runtime/*.tar.gz` |
| **llama.cpp 整套（CUDA + CPU 双后端）** | **`baseline/llama/llama-b10498-5ecbe1ac1-cuda-cpu.tar.gz`** |
| **Node 22.23.2 单二进制** | **`baseline/bin/node`** |
| **git 及其依赖的 6 个 deb** | **`baseline/debs/git/`** |

⚠ **打包存放，不要在同步目录里解开**。同步盘的瓶颈是小文件数量，
不是总体积——`comfyui313-env.tar.gz` 打成包只占一个条目。
`llama` 那个包更要打包：里面有 **26 个符号链接**，
`libggml-cuda.so → .so.0 → .so.0.19.0` 三层指向同一个 719 MB 实体，
逐文件复制若解引用会膨胀到 2.1 GB，而丢掉链接结构后 `llama-server` 起不来。

### 后三项是 2026-08-17 才补上的 —— 之前 baseline 装不出一台完整设备

在本板上实走一遍才发现，原来那 14 个文件**只覆盖生图栈**：
没有 llama.cpp（对话推理完全起不来）、没有 node（面板与全部工具脚本都跑不了，
而板上没有 curl/wget，连模型都下不了）、没有 git 的 deb（ComfyUI-Manager 直接失败）。
另外还有两处是**脚本假设错了**（`65-verify-on-board.sh` 写死构建 chroot 路径、
`models.tsv` 的"ModelScope 换域名即可"），以及一个**镜像层面的坑**
（厂商镜像根本没装 `ca-certificates`）。全部记在 `baseline/README.md` 与 `WORKFLOW.md`。

---

## 开工前必须核对：目标板是不是同一种板

**这一步不做，后面全白干。** 整套版本组合是围着本板的驱动版本反推出来的，
换一块环境不同的板子，编译产物直接不能用。

```bash
cat /proc/device-tree/model              # 期望 p3663-XXXX
cat /proc/cmdline | tr ' ' '\n' | grep -E 'root=|board_name|aurixfw|isolcpus'
dpkg -l 2>/dev/null | grep nv-driveos-linux | head -1    # 期望 6.0.9.0-1
ldd --version | head -1                  # 期望 glibc 2.31
uname -r                                 # 期望 5.15.116-rt-tegra
```

| 项 | 基线值 | 不一致会怎样 |
|---|---|---|
| 板号 | `p3663-XXXX` | GPU 架构可能不是 sm_87，wheel 里只有 sm_87 的 cubin 且不带 PTX，加载即失败 |
| DRIVE OS | `6.0.9.0-1` | 驱动 API 版本可能不同，整条版本链的前提消失 |
| CUDA 驱动 API | `12.1`（12010） | **这是锁死一切的那个数**。更高的话应该也能用更高的 CUDA 与 torch，值得重新推一遍 |
| glibc | `2.31` | wheel 与运行时库都按 2.31 编 |
| 内核 | `5.15.116-rt-tegra` | 影响 nvmap 与统一内存行为 |

**驱动 API 版本怎么读**：板上没有 `nvidia-smi`。用 `dlopen("libcuda.so.1")` 调
`cuInit(0)` 再 `cuDriverGetVersion(&v)`，`v` 应为 `12010`。
`/sys/module/nvidia/version` 读到的 `541.1.2` 是**驱动包版本号，不是 CUDA API 版本**，两回事。

---

## 阶段划分

**照着 `WORKFLOW.md` 做**（14 个阶段，每步带命令与判据）。
下面这张表是它与旧七阶段文档的对应关系——`phase-*.md` 仍然是每个阶段的原理来源，
但**操作顺序以 WORKFLOW.md 为准**（它是实走两块板之后重排的，粒度更细、依赖更清楚）。

| WORKFLOW 阶段 | 做什么 | 原理参考 |
|---|---|---|
| 1 接触 | 三条入口、**VLAN 254 那一课**（ARP 通但 TCP 全不通） | `phase-0-contact.md` |
| 2 身份核对 | 五项 + 驱动 API 12010，不过就停 | `phase-0-contact.md` |
| 3 **全量探索** | 六件必查的事、`du` 的两个骗人方向 | 本轮新增，见 `board-diff-audi-20260817.md` |
| 4 清理车机数据 | 备份→校验→才删；哪些能删哪些绝不能删 | `phase-2-storage.md` |
| 5 **存储整合** | mergerfs 把碎分区并成一块大盘 | 本轮新增 |
| 6 网络 | **DHCP + 固定双保险；固定地址要问用户** | `phase-1-network.md` |
| 7 对时 | `set-ntp true` 才会建 symlink | `phase-1-network.md` |
| 8 出网 + 防线 | 三条加法 ip rule + 动态网关探测 + `IECU_GUARD` | `phase-1-network.md` |
| 9 **SSH 入口收敛** | 清掉镜像里别人的公钥（删不掉就配置屏蔽） | 本轮新增 |
| 10 运行时基座 | node → **CA 证书** → git → Python/CUDA/torch，顺序有依赖 | `phase-3-runtime.md` |
| 11 模型 | **先探源再下载**（不要照着 models.tsv 拼 URL） | `phase-5-models.md` |
| 12 服务 | ComfyUI → 面板 → 推理 | `phase-4-services.md` |
| 13 公网入口 | 隧道 vs DNAT；两块板并行时三处必须错开 | `phase-4-services.md` |
| 14 验收 | 模式互斥、断电重启、生图与对话都要拿到真实产物 | `phase-6-verify.md` |

---

## 贯穿全程的六条纪律

这些不是建议，是本板子上用代价换来的。违反任何一条都出过事。

1. **绝不跑 `/app/shutdown_service.sh kill`** —— 触发 Hypervisor 整机关机，
   而**没有远程上电手段**。停智驾栈用 `systemctl stop application_start`。
2. **绝不对 `/dev/vblkdev*` 写** —— 这是唯一能从 SSH 把板子变砖的路径。
3. **改网络只做加法**。可以加地址、加独立路由表、加 ip rule；
   **不动主路由表的默认路由、不动厂商的 `fwmark 0x12c → table 123`、不删 `172.31.254.38`**。
   没有串口，失联等于只能等人到现场。
4. **停服务只用 `systemctl`**。`pkill` 只允许用于编译进程（cicc / cc1plus / ninja / nvcc）。
5. **远程命令一律 `node exec.js --file <本地脚本>`**，不在 PowerShell 里拼引号。
   引号嵌套超过两层就把脚本落成文件再执行。
6. **`libcuda.so.1` 与任何 `libnvrm*` / `libnvos*` 永远用目标板自己的**，
   绝不从归档里分发——那是驱动的一部分，与内核模块配套。

---

## 判据纪律：什么算"做完了"

本板子上，看起来对的东西经常是错的。每一步的完成判据都必须是**产物**，不是状态：

| 不算数 | 才算数 |
|---|---|
| `systemctl is-active` 说 active | `ss -lntp` 里端口真的在听 |
| 端口在听 | HTTP 有响应（`llama-server` 8080 只要 6 秒就在听，但 `/health` 还回 `503 Loading model`，模型要 88 秒） |
| `systemctl is-enabled` 说 enabled | 重启后 `is-active` 真的是 active（`systemd-timesyncd` 就是 enabled 但从未启动过） |
| `torch.cuda.is_available()` 是 True | 真跑一个 kernel 不抛异常 |
| 编译 rc=0、架构报对 | 建张量、做矩阵乘、强制走 flash attention 都不报错 |
| ComfyUI 报 `status=success` | 拿到图片文件名，**且文件名与上一次不同** |
| `tar` 退出码 0 | 条目数与**符号链接数**都对得上 |
| 目录里有模型文件 | **加载器的下拉候选里能看到它**（搜索根没登记就等于没有） |
| 命令没报错 | 回读一遍，内容真的变了 |
| `if cmd \| tail -5` 成立 | **管道的退出码是最后一个命令的，永远 0** —— 见下 |

最后两条是本轮（2026-08-17）用代价换来的：

**① 管道吞掉退出码，一天里犯了两次。**
`if docker run ... caddy validate | tail -5` 和 `if git ls-remote ... | head -3`
两次都把**失败读成了"✓ 通过"**，因为管道的退出码是 `tail`/`head` 的。
要么 `set -o pipefail`，要么重定向到文件再看退出码，要么别接管道。

**② 工具缺失会伪装成功能缺失，本项目已栽四次。**
`strings` 全报 no（没装 binutils）、`command -v python3` 空（只缺一个可执行文件）、
`su` 不存在（导致"配置读不到"的假警报）、`ldd` 报 not found（其实是没设 `LD_LIBRARY_PATH`）。
**判断某个东西在不在，至少两种独立方式交叉验证。**

还有一条老规矩：**"没报错"从来不是"做对了"的证据**。
传输会静默损坏、环境变量名传错会静默回落、批量替换会静默毁文件——
这三种都真的发生过，共同点是全程零报错。

⚠ **操作纪律**：凡是带引号/变量/管道的远程命令，一律 `node exec.js --file <脚本>`。
本轮为省一个文件，在 PowerShell 内联命令的引号上**连踩五次**
（`$(...)` 被提前展开、`\"` 被吃掉、`wc`/`systemctl` 被当成本机命令、
`rm -f` 的参数被权限系统解析成 `/` 而拦下）。**没有例外。**

---

## 与另外两个 skill 的分工

```
iecu-provision  ── 新板子从零到基线（本 skill）
      │
      └─ 部署完成后交给 ↓
iecu            ── 日常运维、改配置、换模型、排障、继续开发
      │
      └─ 要导入工作流时 ↓
comfyui-import  ── 社区工作流的体检、改写、真跑验证
```

三者共用同一套工具脚本：`.Codex/skills/iecu/scripts/`
（`exec.js` 执行 / `push.js` 上传 / `pull.js` 下载 / `probe.js` 批量采集）。
**不要在本 skill 里复制一份**。
