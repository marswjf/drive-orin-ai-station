# 部署资产总览 —— 把这套系统复制到另一块板子

本目录是 IECU 3.1 上跑的**全部软件的源码与配置**。板上的一切都能从这里重建；
板子只是这些文件的落地副本，清理板子不会丢东西。

> 大二进制（模型、编译产物）不进本目录（同步盘），位置见下方「不在本目录的东西」。

---

## 目录地图

| 目录 | 内容 | 板上落点 |
|---|---|---|
| `panel/` | 运维面板后端（零依赖单文件 Node 服务）+ 登录页 + 聊天界面汉化脚本 + 构建产物 | `/var/lib/llm/panel/` |
| `panel-ui/` | 面板前端源码（React + Tailwind + Vite），`build.ps1` 构建 | 产物进 `panel/dist/` 再推板 |
| `llama/` | llama.cpp 启动包装 + **v10 对话模板** | `/var/lib/llm/` |
| `comfyui/` | 工作流导入工具链（`tools/` 四个工具）、板上能力快照（`capability/`）、四张现役工作流（`workflows/`）；py3.8 时代的补丁脚本也在这里，已不再使用 | 工具在本机跑，工作流推到 `/var/lib/llm/comfyui313/ComfyUI/user/` |
| `torch-py313/` | **现役生图环境**：Python 3.13.15 + torch 2.11.0 / torchvision 0.26.0 / torchaudio 2.11.0 + CUDA 12.2（Tegra）+ cuDNN 9.20 + OpenBLAS 0.3.29，Flash Attention 开启。编号脚本 50~65、完整推导与 13 个坑的记录、切换与回滚清单、复制到新板子的手册 | `/var/lib/llm/comfyui313/`、`/var/lib/llm/py313/`、`/var/lib/llm/cuda122/`、`/opt/m0/torchbuild/` |
| `torch-py310/` | **上一代**（Python 3.10 + torch 2.4.1，无 Flash Attention）。板上已移除、本发布包不含；其推导结论已并入 `torch-py313/` | 已退役 |
| `config/` | `config.json` 与两个推理预设（已脱敏） | `/var/lib/llm/` |
| `systemd/` | 全部 unit 文件 | `/etc/systemd/system/` |
| `net/` | 局域网地址、站点识别与出网通道、日志封顶 | `/var/lib/llm/net/` |
| `edge/` | 公网入口：Caddy + frps + compose | 你自己的公网宿主机 `/opt/iecu-edge/` |
| `build/` | 交叉编译 llama.cpp：WSL 与 Docker 两套 | 构建机 |
| `install.sh` | 首次部署脚本 | — |
| `verify-boot.sh` | 断电重启后的自检 | — |

---

## 为什么有两套同名配置

本目录里有几组文件成对存在，一份带 `-audi` 后缀，一份不带：

| 不带后缀（第一块板） | 带 `-audi` 后缀（第二块板） |
|---|---|
| `config/config.json` | `config/config-audi.json` |
| `systemd/iecu-egress.service` | `systemd/iecu-egress-audi.service` |
| `systemd/iecu-frpc.service` | `systemd/iecu-frpc-audi.service` |
| `systemd/iecu-lan-ip.service` | `systemd/iecu-lan-ip-audi.service` |
| `comfyui/extra_model_paths.yaml` | `comfyui/extra_model_paths-audi.yaml` |
| `comfyui/capability/` | `comfyui/capability-audi/` |

这套方案先后在两块同源板卡上部署过。两块板的分区挂载关系与网络接口并不相同，
因此留下了两套配置。

**部署手册 `iecu-provision/WORKFLOW.md` 使用的是带 `-audi` 后缀的那一套**，
不带后缀的是第一块板的配置，保留下来供对照。选错不会立刻报错：`iecu-frpc.service`
依赖的是 `iecu-egress.service`，而手册安装的是 `iecu-egress-audi.service`，
单元名对不上，反向隧道起不来。

文档里对这两块板还有另外的称呼：第一块板称「基线板」「批次A」「上一块板」，
第二块板称「本板」。

两套的实际差异：

| 项 | 第一块板 | 第二块板（`-audi`） |
|---|---|---|
| `/opt/m0` 的宿主设备 | vblkdev23，26G 独立 | vblkdev56，20G，**与 `/opt/other` 是同一个设备** |
| 局域网地址所在接口 | `eth.254`（VLAN 子接口） | `eth`（母接口） |
| 出网方案 | `net/site-egress.sh`，站点识别 | `net/audi-egress.sh`，table 100 加法规则 + IECU_GUARD 入站防线 |
| 配置项 | — | 多一项 `generalEgress` |

⚠ 存储这条差异会造成实际事故：在第二块板上往 `/opt/m0` 写入大文件，等于挤占 `/var`
的可写层。照第一块板的做法放 16.5 GiB 多模态模型，会把 `/var` 写满。
逐项实测记录见 `../.claude/skills/iecu-provision/references/board-diff-audi-20260817.md`。

**你手上的板卡属于哪一种，要在部署阶段 3 实际采集之后才能确定**，不要凭型号推断。

---

## 板上的服务全景

| unit | 端口 | 作用 | 开机自启 |
|---|---|---|---|
| `iecu-panel` | 9000 | 运维面板 + `/v1/*` 聚合 + 反代 | ✅ |
| `llm-server` | 8080 | Qwen3.6-35B-A3B（对话，128K 上下文） | ✅ |
| `llm-embedding` | 8081 | Qwen3-Embedding-0.6B（向量，CPU 档） | ✅ |
| `comfyui` | 8188 | ComfyUI（图像/视频生成），跑 `/var/lib/llm/comfyui313`（py3.13 + 自编 torch 2.11.0 + Flash Attention） | ❌ 手动 |
| `iecu-frpc` | — | 反向隧道，板子挪到哪都能连 | ✅ |
| `iecu-lan-ip` | — | 按站点设局域网地址 | ✅ |
| `iecu-egress` + `.timer` | — | 识别所在站点、给 frpc 开出网通道 | ✅ |
| `application_start` | — | 厂商智驾栈 | ❌ 已停 |

**三种运行模式互斥**（内存装不下两套）：

```
智驾模式        application_start          占 11 GB
对话模式        llm-server + embedding     占 20.4 GB(GPU映射) + 3.2 GB
生图模式        comfyui + embedding        进程 RSS 约 10 GB + nvmap 约 10 GB
                                           向量服务可同时在线
```

⚠ **生图模式的模型总量上限约 14 GB**，且 `comfyui.service` 必须带 `--highvram`——
统一内存下 offload 省不出内存却要真搬运，默认策略会算错账直接 OOM（A-124）。
装不下就换更低的 GGUF 量化档，不要退回 offload。

`comfyui.service` 与 `llm-server`、`application_start` 声明 `Conflicts`，
systemd 会自动互斥。**故意不与 `llm-embedding` 互斥**——向量服务是基础设施，
CPU 档只占约 1.3 GB，生图容得下；要腾这块内存时由面板显式停它。

---

## 复制到另一块板子

前提：目标板同为 DRIVE AGX Orin + DRIVE OS 6.0.9，能 SSH 进去。

```
1. 基础目录        mkdir -p /var/lib/llm/{bin,llama,panel,net,frp,py}
2. Node 运行时     推 bin/（aarch64 Node 20，95 MB）
3. llama.cpp       推 llama/bin-cuda/（787 MB，见下方来源）
4. 启动脚本        推 llama/run-*.sh、3.6_chat_template-v10.jinja
5. 配置            推 config/*.json 到 /var/lib/llm/，按新板改 sites 里的地址
6. 面板            推 panel/（含 dist/ 里的构建产物）
7. 网络脚本        推 net/，改站点表
8. systemd         推 systemd/*.service 到 /etc/systemd/system/，daemon-reload
9. 模型            从 <你的模型目录>\models\ 或 NAS 传（19 GB，走 10G 局域网约 3 分钟）
10. 面板密码       板上跑 panel/set-panel-password.sh '新密码'
11. frp token      板上手工填 /var/lib/llm/frp/token（本仓库已脱敏）
12. 自检           verify-boot.sh
```

ComfyUI 那套单独走 `comfyui/README.md`（它的依赖链和补丁较复杂，独立成篇）。

---

## 不在本目录的东西（大文件）

| 东西 | 大小 | 位置 | 怎么再拿到 |
|---|---|---|---|
| GGUF 模型 | 19 GB | `<你的模型目录>\models\`；板上 `/opt/m/llm`、`/opt/m0/llm` | 从 HuggingFace 重下，或从现役板子拷 |
| llama.cpp 编译产物 | 854 MB | **`baseline/llama/llama-b10498-5ecbe1ac1-cuda-cpu.tar.gz`（418 MB，CUDA+CPU 一个包）**；板上 `/var/lib/llm/llama/` | `build/3-fetch-dflash2.sh` → `4-build-dflash2.sh`（CUDA）→ `5-build-cpu-and-pack.sh`（CPU + 打包）|
| Node 20 aarch64 | 95 MB | 板上 `/var/lib/llm/bin/` | nodejs.org 官方 aarch64 包 |
| ComfyUI 的 site-packages | 1.6 GB | 板上 `/var/lib/llm/py/root/` | 照 `comfyui/README.md` 重装 |
| SD 模型 | 10.4 GB | 板上 `/opt/m0/sd-models`、`/opt/m/sd-models` | HuggingFace / Civitai |
| Z-Image GGUF | 11.4 GB | 板上 `/opt/update/sd-models/diffusion_models/`；本机 `D:\tmp\zimage-gguf\` | `jayn7/Z-Image-Turbo-GGUF` 的 Q8_0（主力）与 Q4_K_M |
| ComfyUI-GGUF 节点 | 31 KB | 板上 `/var/lib/llm/comfyui/custom_nodes/ComfyUI-GGUF/` | `city96/ComfyUI-GGUF` + `gguf==0.17.1` wheel |
| 原厂恢复镜像 | 21.57 GB | 你的备份目录 `opt-update\` | **唯一的恢复素材，绝不能删** |

**当前板上的 llama.cpp 版本（2026-08-19 起，两半已统一）**：

| 目录 | 版本 | 谁在用 |
|---|---|---|
| `bin-cuda/` | **`0.1.2-dev (build 10498, commit 5ecbe1ac1)`** | 推理服务 :8080 |
| `bin/` | **同上，同一个 commit** | 向量服务 :8081（CPU 档）|
| `bin-cuda-b1-dd1ea52/` | `1 (dd1ea52)` | 回滚位，**别删** |
| `bin-b1-dd1ea52/` | `1 (dd1ea52)` | 回滚位，**别删** |

换 CPU 版那一半时做过向量数值等价性验证（陷阱 34：向量变了就要整库重建）：
**七条语料余弦全部 1.000000、单维最大差 0.00e+0，逐位相同，知识库不必重建。**

都是 nvcc 12.1 交叉编译、GNU 9.4.0、aarch64、sm_87。
回滚一条命令：`sh /var/lib/llm/llama/promote-bin-test.sh rollback`。
两个包的角色、版本差异、升级验收结论见 **`baseline/llama/README.md`**，
换版本要过的清单见 **`deploy/llama/UPGRADE-CHECKLIST.md`**。

---

## 改东西之后

| 改了什么 | 怎么发布 | 别忘了 |
|---|---|---|
| 面板前端 | `pwsh -File panel-ui/build.ps1 -Push` | 产物同时更新 `panel/dist/`，**核对 `index.html` 引用的文件名确实在 `assets/` 里**（陷阱 39）|
| 面板后端 | 推 `panel/server.js` → `systemctl restart iecu-panel` | **会打断全部在途请求**（调用方走的就是 9000），不只是"正在转发的几条"；重启前先问调用方 |
| 面板的三道闸 | 改 `panel/server.js` 顶部的 `CHAT_GATE` / `CHAT_TIMEOUT_MS` / `MAX_BODY_BYTES` | 现值 并发 3 / 900 秒 / 60 MB。**改 `--predict` 就要同步重算超时**，两者配套；口径见 `references/llm-deploy.md`「面板层的三道闸」|
| llama 启动参数 | 面板「模型与参数」改，或直接改 `config/*.json` 后推板 | 三份配置（config + 两个 preset）要一起改 |
| 对话模板 | 推 `llama/3.6_chat_template-v10.jinja` → 重启 llm-server | ⚠ **别删中文预填那一行**，改完必须回归测 tool_calls |
| ComfyUI 升级 | 拉新版后重跑两个补丁脚本 | 见 `comfyui/README.md`「升级之后」|
| 网络脚本 | 推 `net/` → 重启对应 unit | 改网络只做加法，别动主路由表 |

**所有改动都要先落到本目录再推板**，不要只在板上改——板子是副本，不是源。
