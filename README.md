# DRIVE AGX Orin 本地 AI 工作站

把一块车规级智驾域控制器，部署成一台完全离线运行的 AI 工作站。

![License](https://img.shields.io/badge/license-MIT-blue)
![Platform](https://img.shields.io/badge/platform-NVIDIA%20DRIVE%20AGX%20Orin-76b900)
![Offline](https://img.shields.io/badge/%E8%BF%90%E8%A1%8C%E6%96%B9%E5%BC%8F-%E5%AE%8C%E5%85%A8%E7%A6%BB%E7%BA%BF-lightgrey)

---

## 这是什么

创时智驾 IECU 3.1 是一块智驾域控制器，主芯片为 NVIDIA DRIVE AGX Orin（P3663）。
它出厂用于自动驾驶计算，硬件规格足以承担通用 AI 负载。

本仓库是把它改造成 AI 工作站的完整方案。部署完成后，板卡可以运行本地大模型对话、
文生图、图生图、老照片修复、视频生成，全部计算在设备本地完成，不调用任何云端接口。

仓库包含三部分：

| 内容 | 位置 | 说明 |
|---|---|---|
| 源码与配置 | `deploy/` | 全部服务的完整副本：推理、生图、运维面板、网络、系统服务单元 |
| 已编译运行时 | `baseline/` | torch、CUDA、Python、llama.cpp、Node 的 aarch64 编译产物，你不必自行编译 |
| AI agent 技能 | `.claude/skills/`<br>`.agents/skills/` | 四个技能。你的 Claude Code 或 Codex 读取之后，可以直接执行整个部署过程 |

第三部分是本仓库与常见部署文档的区别所在：部署手册不只写给人阅读，也写成了
AI agent 能够执行的形式。用法见下面的[让 agent 完成部署](#让-agent-完成部署)。

## 这块板卡不是 Jetson

DRIVE OS 与 Jetson 使用的 JetPack 是两套不同的系统。Jetson 的教程在这块板卡上
整套方法都不适用，根源是三点结构差异：

- **统一内存**。CPU 与 GPU 共用同一块物理内存（约 28.7 GiB），不存在独立显存。
  把模型卸载到 CPU 并不能释放内存，这是物理事实，不是配置不当。
- **Hypervisor 虚拟机**。系统运行在 Guest VM 之中，硬件型号要从
  `/proc/device-tree/model` 读取，不能凭外观推断。
- **根分区只读**。软件包无法安装到 `/usr`，所有运行时都装在独立目录。

项目文档记录了二十多次「看起来合理、实测却不成立」的判断，集中在
`.claude/skills/iecu/SKILL.md` 的认知陷阱一节。部署之前读一遍，能节省大量时间。

## 能做什么

下列性能数据全部在实机上测得，不是理论推算。

| 能力 | 使用的模型 | 实测性能 |
|---|---|---|
| 本地大模型对话 | Qwen3.6-35B-A3B，支持思考模式、工具调用、128K 上下文 | 生成约 33 tok/s，预填充 700+ tok/s |
| 图像理解 | 多模态视觉模型 | 1024² 图像约 4 秒 |
| 向量嵌入 | Qwen3-Embedding-0.6B | 1024 维单路输出 |
| 文生图 | Z-Image Turbo | 1024²、8 步，**30.4 秒** |
| 图生图与局部重绘 | Z-Image + 重绘工作流 | 768×1024，**36 秒** |
| 老照片修复 | 去噪去划痕 + 4 倍超分 | 832×464 放大到 5472×3072，**108 秒** |
| 视频生成 | MiniMax-H3，画面与 32kHz 立体声一次生成 | 608×352、24fps，最长 **10.13 秒** |
| 视频超分辨率 | SeedVR2，音轨保留 | 22 帧 78 秒 |

配置好的工作流可以直接打开运行：文生图 4K 加速版、局部重绘、老照片修复、
文生视频、多参考图生视频、视频超分辨率。

板卡上另有一个 React 运维面板（`:9000` 端口），可以查看运行模式、模型、生成速度、
内存占用、任务队列与失败统计，并在推理、生图、视频生成、车机四种模式之间切换。

### 三种模式互斥

统一内存容纳不下两套模型，因此推理、生图、视频生成同一时刻只能运行一种，
在面板上切换。切换过程约几十秒。

### 视频生成需要自行下载模型

视频生成的脚本、工作流与文档都在仓库内（`deploy/minimax-h3/`），完整可用，
但模型权重不随仓库分发。按 `deploy/minimax-h3/README.md` 的清单下载之后即可运行。
上表中 10.13 秒的数据就是用这套配置测得的。

## 硬件前提

开始之前先确认目标板卡与下列版本一致。`baseline/` 里的编译产物锁定了这一组版本，
其中任何一项不同，这些产物都不能直接使用。

| 项目 | 要求 |
|---|---|
| 板卡 | NVIDIA DRIVE AGX Orin，P3663 家族 |
| 系统 | DRIVE OS 6.0.9.0-1 |
| CUDA 驱动接口 | 12.1（12010） |
| glibc | 2.31 |
| 内核 | 5.15.116-rt-tegra |
| 内存 | 统一内存约 28.7 GiB |

完整版本清单见 [`baseline/VERSIONS.txt`](baseline/VERSIONS.txt)，里面写明了这组版本
为什么缺一不可。版本不一致时不要强行安装，先按该文件重新评估，必要时自行编译。

另外准备：一根网线（与板卡直连）、一台能运行 Node.js 的电脑（Windows、Linux、macOS 均可）。

## 下载到本地

### 1. 取得仓库

```bash
git clone https://github.com/marswjf/drive-orin-ai-station.git
cd drive-orin-ai-station
```

下载量约 18 MB，落地后目录占用约 60 MB（含 git 历史），包含全部源码、配置、
文档与 agent 技能。

### 2. 取得运行时归档

已编译的运行时共约 3.3 GB，其中六个文件单个超过了 GitHub 的 100 MB 上限，无法直接
放进仓库，因此存放在本仓库的 Releases 附件区，标签为 `runtime-v1`。这个标签只用于
存放大文件，不代表软件版本。

```bash
bash baseline/fetch-runtime.sh
```

脚本会把六个文件下载到 `baseline/` 下各自的目录，并校验 llama.cpp 归档的
SHA-256。需要 [GitHub CLI](https://cli.github.com/) 并已登录（`gh auth login`）。

也可以只下载需要的部分：

```bash
gh release download runtime-v1 --pattern "py313.tar.gz" --dir baseline/runtime/
```

六个文件的用途：

| 文件 | 大小 | 用途 |
|---|---|---|
| `cuda-runtime-libs.tar.gz` | 1.60 GB | CUDA 12.2、cuDNN 9.20、gcc 运行时、OpenBLAS |
| `comfyui313-env.tar.gz` | 994 MB | ComfyUI 完整环境，含九个节点包与虚拟环境 |
| `llama-b10498-5ecbe1ac1-cuda-cpu.tar.gz` | 418 MB | llama.cpp 现役版本，CUDA 与 CPU 两份同源构建 |
| `torch-2.11.0-cp313-cp313-linux_aarch64.whl` | 183 MB | 自行编译的 PyTorch，已开启 Flash Attention |
| `node` | 117 MB | Node 22.23.2 单文件二进制，运维面板与全部工具脚本都依赖它 |
| `py313.tar.gz` | 102 MB | CPython 3.13.15 完整目录 |

### 3. 模型权重需要自行取得

仓库不分发模型权重。各模型有各自的开源许可，请按
[`baseline/models.tsv`](baseline/models.tsv) 里的清单，从对应的开源仓库自行下载，
并遵守各自的许可条款。

## 让 agent 完成部署

这个仓库自带四个 AI agent 技能。把仓库克隆到本地之后，在仓库目录里启动
Claude Code 或 Codex，agent 会自动发现这些技能，并按其中的手册执行部署。

| 技能 | 负责什么 | 什么时候用得上 |
|---|---|---|
| `iecu-provision` | 从出厂状态的裸板部署到全栈可用，分 14 个阶段 | 手上是一块新板卡 |
| `iecu` | 日常运维、硬件能力边界、认知陷阱记录 | 板卡已经部署完成 |
| `comfyui-import` | 把任意来源的 ComfyUI 工作流改写成板上能运行的版本 | 想运行社区分享的工作流 |
| `board-discovery` | 面对陌生板卡，从查不到 IP 到能够稳定登录 | 手上的板卡与本项目型号不同 |

### 使用 Claude Code

```bash
cd drive-orin-ai-station
claude
```

技能位于 `.claude/skills/`，启动后自动生效。开场直接说明你的处境，例如：

> 我有一块出厂状态的 IECU 3.1 板卡，已经用网线直连到电脑。
> 请按 iecu-provision 技能里的部署手册，从第一阶段开始执行。
> 每个阶段的完成标准没有达到，就停下来告诉我，不要继续往下走。

### 使用 Codex

```bash
cd drive-orin-ai-station
codex
```

`.agents/skills/` 与 `.claude/skills/` 内容相同，Codex 从前者发现技能；
项目说明在仓库根目录的 `AGENTS.md`。

### agent 会做什么

它会读取 `.claude/skills/iecu-provision/WORKFLOW.md`，按 14 个阶段顺序执行。
每个阶段都写明了完成标准，没有达到就不进入下一阶段。

下列操作不可逆，agent 会先停下来征求你的确认：清除原厂智驾数据、
调整网络配置、重新划分存储。

它还会向你询问这几件事：板卡的地址与登录口令、运维面板的密码、
模型下载到哪个目录、是否需要配置外网访问。

### 不使用 agent 也可以

直接阅读 [`.claude/skills/iecu-provision/WORKFLOW.md`](.claude/skills/iecu-provision/WORKFLOW.md)。
这份手册在两块不同批次的板卡上实际执行验证过，每个阶段都写了完成标准和具体命令，
人工照着操作同样可行。

## 部署前要设置的五件事

发布包已经移除全部具体地址、域名与凭证。下列五项在部署过程中会用到，
agent 也会在对应阶段向你询问。

| 项目 | 怎么设置 | 说明 |
|---|---|---|
| SSH 口令 | 出厂板卡使用厂商口令 `root` / `nvidia`。部署阶段工具脚本默认使用 `root` / `iecupassword`，可用环境变量 `IECU_PASS` 覆盖 | 验证完成后立即改为你自己的强口令。**不要把板卡的 SSH 端口暴露到互联网**，弱口令加 root 账户，几小时内必被暴力破解 |
| 局域网地址 | 在 `deploy/net/set-lan-ip.sh` 里设置 `IECU_LAN_ADDR`，不填就不会自动添加地址 | 保留直连地址 `172.31.254.38` 作为救援通道 |
| 站点列表 | `deploy/config/config.json` 默认为空。需要局域网访问或反向隧道时，参照 `deploy/config/config.example.json` 填写 | 三个推理预设里的站点列表必须保持一致，否则切换预设会把它恢复成旧值 |
| 面板密码 | 在板卡上执行 `/var/lib/llm/panel/set-panel-password.sh '至少 12 位的强密码'` | 发布包没有默认密码。不设置时，外网登录返回 503，局域网默认免登录。要让局域网也需要登录，在 `config.json` 里设 `"requireLoginOnLan": true` |
| 外网入口（可选） | 进入 `deploy/edge/`，复制 `.env.example` 为 `.env`，填写自己的域名、证书目录与端口，用 `openssl rand -hex 32` 生成 frp token | 不需要外网访问就跳过这一步，局域网面板照常可用。frp 默认只转发面板端口，远程 SSH 请走你自己的 VPN 或受限跳板机 |

## 部署过程概览

完整手册见 [`WORKFLOW.md`](.claude/skills/iecu-provision/WORKFLOW.md)，下表只是路线图。
阶段之间有先后依赖，不要跳过。

| 阶段 | 做什么 |
|---|---|
| 1 | 用网线连接板卡，确认能够登录 |
| 2 | 核对板卡型号与系统版本，与 `VERSIONS.txt` 不一致就不要继续 |
| 3 | 采集板卡当前的网络、存储、服务配置 |
| 4 | 清除原厂智驾数据，释放空间。先备份、再校验，最后才删除 |
| 5 | 合并零散分区，整合成一块大容量逻辑盘 |
| 6 | 配置网络地址（DHCP 与固定地址同时保留） |
| 7 | 配置时间同步。板卡没有实时时钟，不校时会产生数十天的偏差 |
| 8 | 配置出网访问与入站防护 |
| 9 | 收敛 SSH 登录入口，清除镜像里预置的第三方公钥 |
| 10 | 安装运行时：Node、根证书、git、Python、CUDA、PyTorch、ComfyUI |
| 11 | 下载模型 |
| 12 | 启动服务：ComfyUI、运维面板、推理服务 |
| 13 | 配置外网入口（可选） |
| 14 | 逐项验收，每条都要实际执行一次 |

## 日常使用

部署完成后，日常操作都在运维面板完成：`http://<板卡地址>:9000`。

- **切换模式**：在推理、生图、视频生成、车机四种模式之间切换
- **生成图像**：从面板打开 ComfyUI，选择工作流，填写提示词，执行
- **调用对话模型**：OpenAI 兼容接口 `http://<板卡地址>:9000/v1`，仅限局域网访问
- **查看状态**：生成速度、内存占用、任务队列、温度

ComfyUI 有两套启动参数，用 `deploy/comfyui/comfy-profile.sh` 切换：

```bash
/var/lib/llm/comfy-profile.sh image   # 生图：模型全部常驻内存，速度最快
/var/lib/llm/comfy-profile.sh video   # 视频：按需调度内存，可以生成较长视频
```

`video` 参数依赖 `deploy/torch-py313/sitecustomize.py`。删除该文件后必须切换回
`image` 参数，否则服务无法启动。

从电脑上操作板卡的工具脚本在 `.claude/skills/iecu/scripts/`：

```bash
node exec.js "<命令>"              # 在板卡上执行命令
node push.js <本地路径> <远程路径>   # 上传文件
node pull.js <远程目录> <本地目录>   # 下载文件
```

## 禁止操作

下列八条都有明确的实机依据，违反其中任何一条都可能导致板卡失联或损坏。

1. **不要执行 `/app/shutdown_service.sh kill`**。它会触发 Hypervisor 整机关机，
   而远程没有任何上电手段。停止智驾栈请用 `systemctl stop application_start`。
2. **不要向 `/dev/vblkdev*` 写入**。这是唯一一条能够通过 SSH 让板卡无法启动、
   且无法远程恢复的操作。
3. **修改网络配置只做加法**。可以添加地址、添加独立路由表、添加路由规则；
   不要改动主路由表的默认路由，不要删除救援地址 `172.31.254.38`。板卡没有串口，
   失去 SSH 就失去了唯一入口。
4. **不要把板卡的 SSH 端口转发到互联网**。
5. **不要把它当 Jetson 部署**。DRIVE OS Guest VM 与 Jetson 是两套系统。
6. **生图模式下模型总量不要超过 14 GB**。装不下时改用量化程度更高的模型，
   不要退回到 CPU 卸载，那样并不能释放内存。
7. **测试图像生成速度时必须更换随机种子**。同一种子第二次运行命中的是缓存，
   不是真实生成。
8. **所有改动先修改 `deploy/` 目录，再同步到板卡**。板卡上的文件是副本，
   仓库才是源头。

## 仓库结构

```
├── README.md          本文件
├── LICENSE            MIT
├── CLAUDE.md          给 Claude Code 的项目说明
├── AGENTS.md          给 Codex 的项目说明
├── .claude/skills/    四个 agent 技能（Claude Code 读取）
├── .agents/skills/    同上内容（Codex 读取）
├── deploy/            全部源码与配置
│   ├── comfyui/       生图与视频系统、工作流、导入工具
│   ├── llama/         llama.cpp 启动脚本与对话模板
│   ├── torch-py313/   PyTorch 2.11 / CUDA 12.2 环境
│   ├── minimax-h3/    视频生成
│   ├── panel-ui/      运维面板前端（React）
│   ├── panel/         运维面板后端（单文件 Node）
│   ├── config/        运行配置模板
│   ├── systemd/       系统服务单元
│   ├── net/           网络地址、出网、时间同步
│   └── edge/          外网入口（Caddy 与 frp）
└── baseline/          运行时归档与版本约束
    ├── VERSIONS.txt   目标板卡必须匹配的版本清单
    ├── models.tsv     模型清单：文件名、大小、来源、安装位置
    └── （大文件从 Releases 下载，见上文）
```

## 许可

本仓库的代码与文档采用 [MIT 许可证](LICENSE)。

模型权重不属于本仓库。它们来自各自的开源项目（Qwen、Z-Image、MiniMax、SeedVR2 等），
下载与使用需遵守各自的许可条款。

## 致谢

这套方案建立在下列开源项目之上：

- [llama.cpp](https://github.com/ggml-org/llama.cpp) —— 本地大模型推理
- [ComfyUI](https://github.com/comfyanonymous/ComfyUI) —— 图像与视频生成
- [ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) —— 量化模型加载
- Qwen、Z-Image、MiniMax、SeedVR2 等开源模型
- Caddy、frp、systemd、mergerfs

感谢 [Linux.do](https://linux.do) 社区。这个项目的不少思路来自社区里的讨论，
那里认真的技术氛围和成员的热心帮助，让许多问题的解决比独自摸索快得多。

## 遇到问题

1. 先看 `.claude/skills/iecu/SKILL.md` 的**认知陷阱**一节。这块板卡上有二十多次
   「看起来合理、实测却不成立」的判断记录，很可能你遇到的问题已经在里面。
2. 部署过程中的问题，对照 `WORKFLOW.md` 里对应阶段的完成标准，确认是哪一步没有通过。
3. ComfyUI 工作流的问题，看 `.claude/skills/comfyui-import/SKILL.md`。
