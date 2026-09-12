# baseline —— 部署根基

把一块新设备装成当前状态所需要的**全部东西**都在这里。
配套的操作步骤见 `.claude/skills/iecu-provision/`。

**这个目录是自足的**：不依赖同步盘之外的任何位置。

---

## 目录内容

| 路径 | 内容 | 大小 |
|---|---|---|
| `wheels/` | 自建的 torch / torchvision / torchaudio（cp313） | 185 MB |
| `runtime/cuda-runtime-libs.tar.gz` | CUDA 12.2 + cuDNN 9.20 + gcc 运行时 + OpenBLAS 0.3.29 | 1.60 GB |
| `runtime/comfyui313-env.tar.gz` | ComfyUI 完整运行环境，含九个节点包与 venv | 1.02 GB |
| `runtime/py313.tar.gz` | CPython 3.13.15 整个 prefix | 102 MB |
| **★ `llama/llama-b10498-5ecbe1ac1-cuda-cpu.tar.gz`** | **llama.cpp 现役基线（2026-08-19 起）。`bin-cuda/`（CUDA）+ `bin/`（CPU）+ 两个启动脚本，两半是同一个 commit。含 DFlash2。26 个符号链接，解开 854 MB** | **418 MB** |
| `llama/README.md` | 现役包的内容、版本来历、升级验收结论、回滚命令、三个编译陷阱 |  |
| **`bin/node`** | **Node 22.23.2 linux-arm64 单二进制。面板、全部工具脚本、板上下载器都依赖它** | **117 MB** |
| **`debs/git/`** | **git 2.25.1 及其 5 个依赖 deb（含从 jammy 取的 nettle 3.7）。根分区只读装不进 /usr，用 `dpkg-deb -x` 解到 `/var/lib/llm/gitroot`** | **5.2 MB** |
| `VERSIONS.txt` | 版本矩阵 + 构建时源设备的板号 / DRIVE OS / 驱动 / glibc / 内核 |  |
| `llama/*.sha256` | llama.cpp 现役包的校验值 |  |
| `pip-freeze-comfyui313.txt` | 图像生成环境的 144 个 Python 包及版本 |  |
| `models.tsv` | 模型清单：文件名、字节数、来源仓库、落点 |  |

合计 **23 个文件、约 3.3 GB**。

> **llama.cpp 只需要用一个包**：`llama-b10498-5ecbe1ac1-cuda-cpu.tar.gz` 里 CUDA 版与 CPU 版
> 是同一个 commit 编出来的，解到 `/var/lib/llm/` 两半就都齐了。
> 详见 `llama/README.md`。

---

## ★ 2026-08-17：补上的三个缺口（这之前 baseline 装不出一台完整设备）

在这块板上按七个阶段实走一遍，发现原来的 14 个文件**只覆盖生图栈**，
另外三样东西一个都没有，而它们是"能不能装出一台完整设备"的前置：

| 补的东西 | 缺了会怎样 | 来源 |
|---|---|---|
| `llama/llama-b10498-5ecbe1ac1-cuda-cpu.tar.gz` | **对话推理完全起不来**。`deploy/build/` 里只有交叉编译脚本不是产物；llama.cpp 官方 release 的 arm64 包**不带 CUDA** | 从基线板 `/var/lib/llm/llama/` 打包取回，SHA-256 已双向核对 |
| `bin/node` | 面板、`exec.js`/`push.js`/`pull.js`、板上下载器 `dl.js` 全都跑不了；而且**板上没有 curl/wget**，没有它连模型都下不了 | nodejs.org 官方 linux-arm64（glibc 2.28+，板上 2.31 满足） |
| `debs/git/` | ComfyUI-Manager 直接 `Failed to initialize: Bad git executable.`，装任何节点包都失败 | `apt-get download` 四个 + ports.ubuntu.com 手取 nettle 两个 |

**打包 llama 而不是逐文件存的原因**：那个目录里有 **26 个符号链接**，
`libggml-cuda.so → .so.0 → .so.0.19.0` 三层指向同一个 **719 MB** 的实体。
逐文件复制若解引用会膨胀到 2.1 GB，而丢掉链接结构后 `ldd` 找不到库、
`llama-server` 起不来。tar 里必须能看到 26 个 `l` 开头的条目才算对。

另外两处**不是文件缺失、而是脚本假设错了**，已在 `deploy/` 里修掉：

- **`65-verify-on-board.sh` 写死构建 chroot 的 venv 路径** —— 解包部署的设备没有 chroot，
  脚本直接 `not found`。已参数化（`VENV` > 生产 venv > 构建 chroot）。
- **`models.tsv` 那句"国内走 ModelScope：把域名换成 modelscope.cn 即可"是错的** ——
  实测 8 个文件里 ModelScope 只有 3 个仓库存在，其余 404（两个平台仓库名不保证同名同在）。
  正确做法是用 `scripts/probe-model-urls.js` 逐个实测三个源（ModelScope / hf-mirror / HF）。

还有一个**镜像层面的坑**（不属于 baseline，但装机必踩）：
**厂商镜像根本没装 `ca-certificates`**，所以 `run.sh` 里那条 A-136「TLS 修复」
指向的 `/etc/ssl/certs/ca-certificates.crt` 是个不存在的文件。
解法见 `deploy/comfyui/fix-ca-certs.sh`：从 node 内置的 145 个根证书生成 bundle。

---

## 为什么大文件放在同步目录里

同步盘的性能瓶颈在**小文件数量**，不在总体积——机械盘的 4K 随机读写慢，
成千上万个碎片文件会让同步与备份都变得很慢；而几个大块的连续文件传输很快。

因此这里的原则是：

- **打成 tar 包再放**，不要把解开后的目录树放进来。
  `comfyui313-env.tar.gz` 压缩成一个 1 GB 的包只占一个条目。
- 部署时在目标设备上解包，不在同步盘里解。

---

## 完整性校验

`llama/` 的归档带独立的 `.sha256` 文件；其余文件可按上表字节数核对。
发布包如需重算全量清单，在打包前执行：

```bash
cd baseline && find . -type f ! -name '*.sha256' -exec sha256sum {} \; > archive-manifest.sha256
```

发布前的文件清单与字节数以本 README 表格为准。

---

## 怎么用

| 场景 | 入口 |
|---|---|
| 装一块新设备 | `.claude/skills/iecu-provision/WORKFLOW.md`，按 14 个阶段依次执行 |
| 改现有设备 | `.claude/skills/iecu/SKILL.md` |
| 了解版本约束 | `VERSIONS.txt`（目标设备必须匹配的版本清单） |
| 了解硬件能力边界 | `.claude/skills/iecu/SKILL.md` 的「板子能力边界」一节 |

**模型不在本目录**，合计约 45 GB，清单与下载地址见 `models.tsv`。
每一项的来源都经 HuggingFace 或 ModelScope API 查询，并按字节数完全一致确认。

---

## 配置文件在 `deploy/`

按用途分好，都是小文件，跟随项目同步：

| 目录 | 内容 | 设备上的落点 |
|---|---|---|
| `deploy/config/` | `config.json` 与两个推理预设 | `/var/lib/llm/` |
| `deploy/systemd/` | 全部 unit 文件 | `/etc/systemd/system/` |
| `deploy/net/` | 局域网地址、出站通道、站点识别 | `/var/lib/llm/net/` |
| `deploy/panel/`、`deploy/panel-ui/` | 运维面板后端与前端 | `/var/lib/llm/panel/` |
| `deploy/llama/` | llama.cpp 启动包装与对话模板 | `/var/lib/llm/` |
| `deploy/torch-py313/` | 图像生成栈的构建链、补丁、切换与回滚清单 | — |
| `deploy/comfyui/` | 工作流工具链、能力快照、四张现役工作流 | — |
| `deploy/edge/` | 公网入口 Caddy + frps | 家庭网络的 LXC |

**所有改动先落到 `deploy/` 再推送到设备。设备是副本，不是源。**
