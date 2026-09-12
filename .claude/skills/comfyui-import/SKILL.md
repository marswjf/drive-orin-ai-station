---
name: comfyui-import
description: 把任意来源的 ComfyUI 工作流（社区分享、教程附件、别人的 JSON、PNG 内嵌）转化成 IECU 3.1 板上能真正跑出图的版本。覆盖能力快照、体检、节点包安装、模型等价替换与量化、LoRA 与模型查找下载、三级验证、归档。当用户说"导入这个工作流""这个工作流报缺失""帮我把 XX 工作流弄到板子上""换个模型跑""找 LoRA""扫一下板上的工作流"时使用。关键词：ComfyUI、工作流、workflow、导入、缺失节点、缺失模型、LoRA、量化、GGUF、Z-Image、Qwen-Image、FLUX、SDXL、节点包、custom_nodes、ControlNet。
---

# ComfyUI 工作流导入与适配（IECU 3.1）

**目标**：拿到任何一个 ComfyUI 工作流，用固定的五个阶段判断它能不能跑、缺什么、怎么补，
最后**真的出一张图**才算交付。

## 边界：这份 skill 管什么、不管什么

| | 归谁 |
|---|---|
| **把一张工作流适配到板上**——体检、改写、格式转换、跑通验证、归档 | **本 skill** |
| **板上的生图环境本身**——torch/CUDA 版本、装什么节点包、模型库放哪、量化策略、内存与分辨率上限、能力边界 | **`../iecu/SKILL.md`**（那是环境的权威） |

**判断标准**：改的是**工作流文件**，看这里；改的是**板子上的东西**（装包、装模型、换 torch、调服务），
看 iecu skill，那边有红线、连接方式和证据档。

本 skill 里凡是提到环境的地方（第 2.2 节量化档、第 5 节硬约束）都只是**速查摘要**，
数值与结论以 `../iecu/references/evidence-levels.md` 为准——那里每条都标了实测日期与证据强度。

---

## 方法论：三个工具缺一不可，"我以为"不算数

这份 skill 的每条结论都来自三种动作的交叉验证。**任何一条缺席，判断就会出错**——
下面每一条都是真实翻过车的：

| 动作 | 用什么 | 不做会怎样（真实案例） |
|---|---|---|
| **上板实测** | `../iecu/SKILL.md` 的连接方式 + `scripts/exec.js` | 说"fp8 加载不了"——实测 `torch.float8_e4m3fn` 明明存在且能上 GPU，那是 torch 2.1 时代的旧结论 |
| **查平台 API / 找等价资源** | HuggingFace API、ModelScope、GitHub API、`infra` skill 上的服务器资源 | 说"SeedVR2 7B fp16 装不下"就排除了它——**没查量化档**，实际 3B Q4 只要 1.9 G，7B Q8 也才 8.4 G |
| **深度搜索社区实践** | `smart-search-cli`（exa-search / fetch / zhipu），并 **fetch 页面或调 API 确认**，不信摘要 | 以为 sm_87 上 flash attention 无解——社区（jetson-containers 维护者）早就编成功过，还给出了确切的版本组合 |
| **读板上源码** | 板上就有 ComfyUI 与各节点包的完整源码，`exec.js` 直接看 | 拿"二阶方法"的通性去推 `res_multistep` 每步两次调用——**只对 Runge-Kutta 类成立**。读一眼 `sampling.py:1418` 就知道循环体内只有一次 `model()` |

**五条纪律**：

1. **先量板子的实际情况，再谈方案。** 内存余量、驱动版本、已装什么，都是变量不是常量——
   同一张工作流，换个文本编码器就从"跑不动"变成"128 秒出图"。
2. **主动找等价资源，别停在"官方那个太大"。** 量化档、lite 版、社区重打包、镜像源，
   通常有一条能落地。**看到 fp16 体积就下结论，是这套流程里最容易犯的错。**
3. **旧结论要标日期，引用前先复验。** 板子在变（换了 torch、换了 Python、打通了出网），
   半个月前成立的限制现在未必成立。查 `../iecu/references/evidence-levels.md`
   看那条结论是哪一档、什么时候测的。
4. **源码与实测互为佐证，两者都要**（2026-09-02 两边各栽一次之后定的）。
   **只有实测**：知其然不知其所以然，换个场景不知道还成不成立。
   **只有源码**：会栽在"读对了代码、理解错了适用范围"——
   视频线判断 `--disable-smart-memory` 会自动卸载上一个模型时，
   `memory_to_free = 1e32` 那行**读得没错**（确实是"尽可能多卸"），
   **错在没问这个函数什么时候被调用**：它管的是"内存不够时腾多少"，
   不管"换模型时要不要主动腾"，实测下来编码器 9.59 GB 一直挂着。
   → **源码给机制，实测划范围。** 本轮 `res_multistep` 两条腿都走了：
   源码说"每步一次调用"，实测说"同步数 30.2 vs 30.2 一秒不差"，
   后者排除了"读对代码但理解错范围"的可能，前者解释了为什么。
5. **版本往高处走；只花编译时间和磁盘、不增加运行时内存的投入，都值得做。**（用户 2026-08-15 定）
   这块板子的稀缺资源是**运行时内存**，不是磁盘（`/opt/update` 十几 G 富余）
   也不是时间（编译可以挂后台过夜）。所以：宁可编两小时、多占几 G 磁盘，
   换取更高的库版本与更省内存的算子。**新版本还顺带消掉兼容补丁**——
   升到 torch 2.5 就能撤掉三个 backport 补丁，维护负担直接归零。

---

## 0. 开工前置（每次都做，不要跳）

### 0.1 连接板子

```powershell
# 连接的板子用 IECU_HOST 指定（直连救命地址或板上局域网 IP），密码用 IECU_PASS 覆盖。
# 出厂首次仍是 root/nvidia；部署收敛后设为自己的强密码。
$env:IECU_HOST="__BOARD_LAN_IP__"; $env:IECU_PORT="22"; $env:IECU_PASS="__DEPLOY_PASSWORD__"
$s = ".claude\skills\iecu\scripts"          # exec / push / pull 都在这
```

远程命令**一律** `node $s\exec.js --file <本地脚本.sh>`。
不要在 PowerShell 里拼远程命令字符串——`$(...)`、`$var` 会被 PowerShell 先展开。

### 0.2 刷新能力快照（判断任何事之前，先拿到当前事实）

```powershell
node deploy\comfyui\tools\cap-refresh.js        # 一步：拉 object_info + 生成快照 + 报告变化
```

它连哪块板取决于 `IECU_HOST`（与 `exec.js` / `push.js` / `wf-run.js` 同一个变量），
**所以开工时设一次环境变量，全套工具就都指向同一块板**——不会出现"exec 连对了、
跑图连错了"。拉不到时它会按"最常见的原因在前"列出排查顺序（服务没起？刚重启还没监听？连错板子？）。

**它同时回答"这一轮板子变了什么"**，多出/少掉的节点类型与模型都会列出来。
少掉模型时会明确警告——因为那意味着引用它们的工作流现在跑不了。

> ~~旧流程写的是「板上跑 `43-export-capability.sh` → 归拢 → `pull.js` → 再单独拉 object_info」~~
> **那个脚本并不存在，照着做第一步就会失败**（2026-09-01 发现，当时只好临时另写脚本绕过）。
> 现在的做法只需要一次 HTTP 请求，快照就地算出来，不必在板上跑任何东西。

> **快照过期是最常见的误判来源，而且两个方向都会骗人**：
> - 装完包/下完模型不刷新 → 体检器报你"缺"刚装好的东西
> - **别人删了东西你不刷新 → 体检器报"模型全部就位"，实际一跑就缺**
>
> 后一种更阴险，2026-09-01 撞上过：拿着 8-14 的快照体检，四张工作流全绿，
> 而板上的 ControlNet 与蒸馏 LoRA 早在某次清理中被删了。**"全绿"因此成了假象。**
>
> 判断标准：**这一轮动过 custom_nodes 或 models 目录，就必须重刷快照**；
> **隔了一段时间再动工作流，不管自己有没有动过，都先刷一次**——板子可能有别人在用。
> 下模型只需重刷快照（ComfyUI 会自己重扫模型目录），装节点包才需要重启服务。

### 0.2b 板子可能不止你一个人在用（2026-09-01 起，真实发生过）

**开工前先确认有没有别的会话在用同一块板**：`ListAgents` 看有没有同项目的会话，
再查一眼队列与最近日志。这不是客套，板子上有三种硬冲突：

| 冲突 | 后果 | 纪律 |
|---|---|---|
| **内存互斥** | 统一内存 28.7 GiB，`--highvram` 下上一个任务的权重**继续常驻**。两边的模型叠加 → 内核 SIGKILL，**在载入阶段 10~20 秒被杀**（不是采样阶段，这是判据） | **同一时刻只能有一边提交任务**。谈好独占窗口，说几分钟就几分钟 |
| **重启服务** | `systemctl restart comfyui` 会打断对方所有在途任务，且要 20~40 秒才重新监听 | 重启前先问。要拿干净内存就明说要一个窗口 |
| **磁盘** | 几个根共 30~40 GB，一边下满另一边就没法下 | 开工前 `df -h`，说清楚自己要往哪个盘写多少 |

还有一条不那么明显的：**对方装节点包、换模型会改变你的快照依据**。
这一轮的真实例子——中途对方把文本编码器从 `Q2_K_M` 换成 `Q4_K_M`，
`cap-refresh.js` 立刻报出"少了一个模型、多了一个模型"。
所以**协作场景下每次体检前都刷一次快照**，别信十分钟前的。

> 顺带一条协作本身的教训：两边都可能给对方错误信息。这一轮我建议对方把模型放 `/opt/m0`，
> 读了 `extra_model_paths.yaml` 才发现那块盘和 `/var` 是同一个设备、放进去还扫不到，
> 立刻发消息纠正。**给出去的建议发现错了要马上追一条改口**，
> 对方很可能正照着做——晚一分钟就是几 GB 写进错地方。

### 0.3 工具清单（都在 `deploy/comfyui/tools/`）

| 工具 | 干什么 |
|---|---|
| `cap-refresh.js` | **每次开工第一条命令**：刷新快照 + 报告这一轮板子变了什么 |
| `wf-doctor.js` | 体检：缺哪些节点类型、属于哪个包、缺哪些模型、板上同类有什么可替代 |
| `wf-adapt.js` | 按规则文件改写工作流（换类型/换参数/bypass/清残留输入） |
| `wf-quantize.js` | 批量把全精度加载器换成量化加载器 |
| `wf-to-api.js` | UI 格式 → API 格式（提交 `/prompt` 用） |
| `wf-verify-api.js` | **转换后的验收闸**：必填参数齐不齐、有没有悬空引用、有没有输出节点 |
| `wf-run.js` | 真提交、轮询、下载图片、分类报错 |
| `wf-scan-size.js` | 扫出写死尺寸的节点（比例 bug 的温床），分高危/中危/安全 |
| `gguf-probe-remote.js` | **下载前先探**：HTTP Range 取文件头，判断这个 GGUF 包是给谁打的 |
| `inject-lora.js`（scratchpad）| 往 API 格式里插 LoRA 节点做 A/B，不用改 UI 连线 |
| `skill-lint.js` | **查这份文档自己**：引用的文件还在不在、路径退没退役、结论有没有标日期 |

> **`skill-lint.js` 是这套流程的自检，改完文档就跑一次**（退出码非 0 表示有该修的）。
> 它存在的理由是本文档自己犯过的错：0.2 节——"判断任何事之前先拿到当前事实"这个
> 最该可靠的第一步——曾经让人去跑一个**根本不存在的脚本**，还在 L1 验证段又引用了一次。
> 通读发现不了（文档太长、看着都合理），一条 grep 就能查出来。
> 第一次跑它就查出 4 处失效引用、1 处早已过期的"现役环境"描述。
> 它自己也带一条纪律：**误报多的 lint 没人会看，等于没有**——所以它支持
> `<!-- lint:legacy-ok -->` 整份豁免（讲老环境的文档）、认得表头行与"讲过去错误"的反面教材列。

> **`gguf-probe-remote.js` 解决的是一类会白下十几 GB 的问题**（2026-09-01 视频那条线查出来的）：
> **GGUF 不是通用格式，同一个模型给 sd.cpp / llama.cpp / ComfyUI 打的包互不通用。**
> 实测过一个 unsloth 的编码器：大小精确等于源站、902 个张量全都读得出、文件完好，
> **但 `metadata_kv_count = 0`**——整个文件一个 metadata 键都没有，
> ComfyUI-GGUF 的 `loader.py` 读不到 `general.architecture` 就直接
> `raise ValueError("This gguf file is incompatible with llama.cpp!")`。
> 那个包是给 stable-diffusion.cpp 打的。**"size 对得上、文件完好、依然加载不了"三件事可以同时成立。**
>
> ```powershell
> node deploy\comfyui\tools\gguf-probe-remote.js <URL> [<URL> ...] [--mb 48]
> ```
> 它把 loader.py 的拦截判据做成了判定行：① `general.architecture` 在不在；
> ② 视觉塔张量在不在同一文件（为 0 说明是 llama.cpp 风格、视觉塔拆成了独立 mmproj，
> 而 ComfyUI 的 `CLIPLoader` 只有一个文件输入口、没有 mmproj 输入）；
> ③ **架构是否在 ComfyUI-GGUF 的白名单里**——它对文本编码器和扩散模型查的是**两张不同的表**，
> 所以探测时会先分清这个文件是哪一类（2026-09-01 修正，早先那版把 DiT 也按文本编码器判，会给错误的绿灯）。
> ⚠ **它只解析文件头，不校验权重本体**——答的是"这个包是给谁打的"，不是"有没有下坏"。
>
> **那两张白名单是写死在插件源码里的**（`IMG_ARCH_LIST` / `TXT_ARCH_LIST`），
> 不在表里的架构一律拒绝，**而且升级插件解决不了**——板上装的就是 city96 仓库的最新提交。
> 由此得到一条容易踩的通则：**ComfyUI 核心原生支持某个模型 ≠ 配套量化插件也支持**，
> 那是两个仓库、两种更新节奏。社区的绕法是重打包时把 arch 标成白名单里的近亲混过去
> （有人把 MiniMax-H3 的 DiT 标成 `wan`，标成 `ltx2` 的那版就进不去，差一个字母）。

---

## 1. 五个阶段

### 阶段 A — 体检：先知道缺什么

```powershell
node deploy\comfyui\tools\wf-doctor.js "某工作流.json"
# 也可以给目录，批量扫
node deploy\comfyui\tools\wf-doctor.js "workflows\上游原版"
```

**输出三件事**：缺的节点类型、它们属于哪个包（含仓库地址）、缺的模型与板上同类替代。
包的归属来自 ComfyUI-Manager 官方维护的 `extension-node-map.json`——**不要靠包名猜**，
"CR Text 听起来像 comfyroll"这种推断经常错。

**工作流的三种格式**（体检器都认）：
- **UI 格式**：有 `nodes`/`links`，网上下载和前端保存的都是这种
- **API 格式**：扁平的 `{"3":{"class_type":...}}`，脚本调用用
- **PNG 内嵌**：工作流存在图片里，把 .png 拖进 ComfyUI 界面即可提取

**阶段 A 的产出**：一份"缺 N 个节点、M 个模型"的清单。据此走阶段 B / C。

### 阶段 B — 补节点

```powershell
node $s\exec.js --file deploy\torch-py313\58-install-nodes313.sh   # 默认装 9 个包，与现役环境对齐
# 装别的包：把 URL 加进脚本的 DEFAULT 数组
```

**为什么不用面板里 Manager 的 install 按钮**：它走 pip 且不带约束，
第三方 requirements 的间接依赖会从 PyPI 拉 CUDA 版 torch，**把自编的 sm_87 版本顶掉**。
`42-install-nodes.sh` 每装一个包就回读一次 torch 版本，被顶了立刻停手。

**装陌生仓库前先看源码**（尤其个人仓库）：扫 `subprocess` / `requests` / `eval` / `exec` / 网络调用。

**通过判据**：重启服务后 `IMPORT FAILED` 计数为 0，且 `/object_info` 里能查到目标节点类型。
`ModuleNotFoundError: No module named 'triton'` 这类是**可选依赖缺失**，包照样加载成功，不用管。

### 阶段 C — 换模型：写规则，不要直接改工作流

规则是 JSON，放 `deploy/comfyui/workflows/adapt-rules/`，**每条改动必须写 `why`**。
半年后回看时，"为什么把 UNETLoader 换成 UnetLoaderGGUF"比改动本身值钱。

```powershell
node deploy\comfyui\tools\wf-adapt.js 原版.json 适配版.json --rules 规则.json
```

四种改动方式：

| 方式 | 用在什么时候 |
|---|---|
| `newType` | 换加载器（如 `UNETLoader` → `UnetLoaderGGUF`） |
| `widgets` | 换模型文件名 / 改参数 |
| `bypass` | **模型没有时首选**——mode=4，输入直通输出，链路不断 |
| `dropInputs` | 换 loader 后清掉旧类型特有的 widget-input（如 `weight_dtype`、`device`） |

> **模型缺失优先 bypass，绝不删节点**。删节点会把下游连线全断掉——界面上一堆断线就是这么来的。
> 等模型到位把 mode 改回 0 即可恢复。

具体换什么，见第 2 节的决策表。

### 阶段 D — 真跑（唯一算数的验证）

```powershell
node deploy\comfyui\tools\wf-to-api.js 适配版.json api.json --object-info deploy\comfyui\capability\object_info.json
node deploy\comfyui\tools\wf-verify-api.js api.json      # ★ 提交前先过闸
node deploy\comfyui\tools\wf-run.js api.json --save 输出目录 --timeout 480
```

> ★ **`wf-verify-api.js` 这一步不要跳**（2026-09-01 加）：转换器会随 ComfyUI 出新参数类型
> 而不断出现盲区——**它遇到不认识的类型就静默漏掉那个参数**，而它自己的自检
> 只查悬空引用、不查参数，所以转换阶段一路绿灯，直到提交才报 400（且不说少了什么）。
> 已知一例，2026-09-01 实测抓到：`SaveVideo.codec`（`COMFY_DYNAMICCOMBO_V3`，已修进转换器）。
> **与其追着修转换器（修掉一个还会有下一个），不如每次都过一遍这道与转换器无关的闸。**
> 它拿 `/object_info` 的 required 定义逐节点核对，将来再出什么新类型都拦得住。
>
> ⚠ **但闸门自己也要能分清"缺参数"和"参数换了个表示形式"**——这条是这道闸第一版就踩的。
> 有两个类型形似而性质相反，**不能一起处理**：
>
> | 类型 | 是什么 | 在 API 格式里 |
> |---|---|---|
> | `COMFY_DYNAMICCOMBO_V3` | 选项联动的下拉，**是 widget** | 占 `widgets_values` 一格，键名就是字段名（`codec`） |
> | `COMFY_AUTOGROW_V3` | **可增长的输入组**，走连线 | 展开成 `values.a` / `values.b`，**没有 `values` 这个同名键** |
>
> 第一版按"同名键必须存在"判，把一张**已经真跑出视频**的工作流报成缺 `values`。
> 现在按定义里的 `template.min` 数 `<字段>.*` 的项数（`min` 从 object_info 读，不写死），
> 既放行正常形式，又能抓住"输入组一项都没连"。
> ⚠ 也**不能反过来把 AUTOGROW 加进转换器的 widget 表**——那会让它以为 `values` 占
> `widgets_values` 一格，**后面所有参数依次错位**，就是本文档记过的
> `BasicScheduler` 拿到 `steps="sgm_uniform"` 那个老坑换了个入口。
>
> **一道会误报的闸，破坏力比没有闸更大**——它会让人去改本来正确的东西。
> 判据：报错之前先问"这是真的缺了，还是它换了种写法？"

**先自检转换器**：拿一个**已知能跑**的工作流过一遍转换器（板上基准是
`deploy/comfyui/workflows/z-image-gguf.json`），确认它转换后仍能出图，再去转新工作流。
否则出了问题分不清是工作流的锅还是转换器的锅。

> ⚠ **自检要用结构不同的几张，别只用一张简单的。** 基准工作流结构太干净，
> 漏掉过一个 bug：当 KSampler 的 `seed` 由别的节点（如 `Seed (rgthree)`）**连线驱动**时，
> `widgets_values` 里那一格的旧值**并不会被删掉**，转换时必须跳过并推进下标，
> 否则后面参数集体错位一格——表现是 `steps` 收到 `"randomize"`、`denoise` 收到 `"simple"`。
> `wf-to-api.js` 已修。**回归时至少覆盖：纯 widget 的、有 widget 转连线的、用 SamplerCustom 的。**

> ⚠ **每次跑之前确认内存是干净的。** `--highvram` 会让上一个任务的权重**继续常驻**，
> 换一张模型组合不同的工作流再跑，两套权重叠加就会 SIGKILL。
> 实测：928×1648 紧接着别的任务跑 → 15 秒被杀；重启服务后同一张图正常出。
> **判据**：被杀发生在 10~20 秒的加载阶段（而不是采样阶段），基本就是这个原因。
> 处理：`systemctl restart comfyui`，等 `/comfy/system_stats` 返回 200 再提交。
>
> ⚠ **探活别用 `curl`——板上没有 curl 也没有 wget。**
> 用 `/var/lib/llm/bin/node -e "require('http').get(...)"`。
> 这条 iecu 技能里早有记录，但记在「连接方式」一节，写探活脚本时没人会去翻那儿，
> 2026-09-02 视频线因此栽了一次：curl 探 8188 永远失败、循环 180 秒后继续，
> **看起来像"在等服务启动"，实际空转十几分钟且不报错**。
> `skill-lint.js` 现在会拦文档里这种写法（本地 PowerShell 的 curl 别名不误伤）。
> 同族纪律：**不要从"没有输出"推断"正在进行"**，要去查产物在不在。
>
> ⚠ **但同一张工作流内部串两个大模型时，重启救不了**——问题发生在这一次执行的中途。
> **`--disable-smart-memory` 不会在换模型时自动卸载上一个**（2026-09-01 视频线实测证伪：
> 曾按 `model_management.py` 里 `DISABLE_SMART_MEMORY → memory_to_free = 1e32` 推断它会积极卸载，
> 实际编码器 9.59 GB 一直挂着，下一个模型加载时直接叠加到 26.7 GB 被杀）。
> **解法是在工作流里显式插 KJNodes 的 `VRAM_Debug`（`unload_all_models=true`）**，
> 插在上一个模型的输出路径上，用完就卸——实测 used 从 26.7 掉到 14.4 GB。
> ⚠ 它卸不掉**刚用完还被引用着**的模型（在采样器输出后插一个想卸 DiT，
> 日志显示执行了但 `freed memory` 是负数）。那种情况只能降规格。
> ⚠⚠ **【适用范围 2026-09-02 存疑】上面这条"卸不掉"很可能只是 legacy 路径的产物**：
> 同一个 `VRAM_Debug` 节点、位置没动过，`--highvram` 下 freed 是负数，
> **切到 DynamicVRAM 路径（去掉 `--highvram`）后实测 freed 14.98 GiB**。
> 若确认，由它推出的"生图接大模型超分必须拆成两次任务"也跟着松动。
> **待复核后改写；在此之前别把"卸不掉"当通则引用。**
> **生图这边什么时候会用上**：Z-Image 接超分时超分模型只有 64 MB，不构成压力；
> 但要串两个 GB 级模型（比如换底模重绘、或接一个大的超分模型）就会撞上。

需要输入图的工作流：先 `push.js` 传一张到 `/var/lib/llm/comfyui313/ComfyUI/input/`，
再在 API json 里把 `LoadImage` 的 `image` 参数指过去。

### 阶段 E — 归档（三份都要留）

```powershell
node $s\push.js 适配版.json /var/lib/llm/comfyui313/ComfyUI/user/default/workflows/适配版.json
```

| 留在哪 | 是什么 |
|---|---|
| `workflows/上游原版/` | 原始文件，回溯基准，永远不改 |
| `workflows/板上适配版/` | 改造后的成品 |
| `workflows/adapt-rules/` | 规则文件，含每条改动的理由 |

---

## 2. 决策表

### 2.1 跨模型家族替换

板上目前只有 **Z-Image Turbo** 一套。任何家族的文生图骨架都是同一个：

```
模型加载 → 文本编码(正/负) → 空 latent → 采样 → VAE 解码 → 保存
```

**保留骨架、提示词、构图参数，只换加载器和采样参数。**

| 原工作流家族 | 识别特征 | 怎么换 |
|---|---|---|
| **Z-Image Base** | `UNETLoader(z_image_base_fp16)` | → `UnetLoaderGGUF(z_image_turbo-Q8_0.gguf)`，**同时 dropInputs `weight_dtype`** |
| **Qwen-Image** | `CLIPLoader type=qwen_image`、`qwen_image_vae` | CLIPLoader type 改 `lumina2`、VAE 改 `ae.safetensors`、UNet 改 GGUF |
| **FLUX** | `DualCLIPLoader`(clip_l+t5)、`FluxGuidance` | 换单个 `CLIPLoaderGGUF(lumina2)`，删 `FluxGuidance`（Z-Image 用 cfg），VAE 通用同一个 ae |
| **SDXL / SD1.5** | `CheckpointLoaderSimple` | 整合包换成分离式三件套；注意 SDXL 原生 1024²、SD1.5 原生 512² |

**CLIPLoader 的 type 是隐形陷阱**：板上有 28 个合法值，填错不报错但出图会跑偏。
**Z-Image 用 `lumina2`**（板上唯一实测出过图的值）。

### 2.2 量化档位（项目默认：能用量化就不用 fp16）

统一内存架构下，权重省的每一 GB 都变成采样余量，而余量决定能跑多大分辨率、能不能挂 ControlNet。

| 组件 | 默认档 | 说明 |
|---|---|---|
| **文本编码器** | **Q8_0**（缺内存可到 Q6_K / IQ4_XS）| **对量化最不敏感**。板上 `Qwen_3_4b-Q8_0.gguf` 载入 4.4 G，fp16 版是 7.7 G，**省 3.3 G** |
| **UNet / DiT 主干** | **Q8_0** | 安全档。再往下要实际比图 |
| **VAE** | **不量化** | 直接决定成像细节，且本来只有 160 MB，量化没意义 |

批量替换：`node deploy\comfyui\tools\wf-quantize.js 工作流.json [...]`

**外部佐证**：ComfyUI-GGUF 作者 city96 在官方 README 里写 "transformer/DiT models such as flux
seem **less affected by quantization**"，且文本编码器的量化加载器是他专门为省显存加的功能。
SECourses 的 Z-Image/FLUX 全系对比里，只有 **NVFP4（4-bit）那节标着 "Degradation Analysis"**，
Q8 档没有降质标注。板上实测也一致：换 Q8 编码器后质量无可见变化，速度反而更快。

### 2.3 采样参数必须跟着模型换

| 模型类型 | 步数 | CFG |
|---|---|---|
| 全量 Base 模型 | 25–40 | 4–7 |
| **Turbo / 蒸馏模型（板上这个）** | **8** | **1** |

板上验证过的基准：8 步 / cfg 1 / euler / simple（`z-image-gguf.json`，1024² 约 45 秒）。
**拿不准时以基准为准，不要照抄工作流作者的参数**——他的机器和模型档位跟你不一样。

> ### ★【A 档 · 2026-09-02 实测】`res_multistep` 4 步 ≈ `euler` 8 步，**耗时减半**
>
> 同机同法 A/B，唯一变量是采样器与步数，种子固定（比画面必须同种子），
> 每组都在重启后的干净内存下跑，基准工作流 `z-image-gguf.json`，1024²：
>
> | 配置 | 耗时 | 画面 |
> |---|---|---|
> | `euler` 8 步（现基准） | **30.2 / 33.3 秒** | 基准 |
> | `res_multistep` 8 步 | **30.2 秒** | 与基准相当，略亮略柔、锐度稍低 |
> | `res_multistep` 6 步 | 24.2 秒 | 未逐张细看 |
> | **`res_multistep` 4 步** | **15.5 秒** | **无崩坏**，细节略少于 8 步 euler |
>
> **两个题材各验一次**（太空猫、古典人像）。人像那组是特意选的——**人脸和手最容易崩**，
> 4 步下五官、手指、珠宝都正常。差异是"头冠与纱质的细节丰富度略低"，属取舍不属损坏。
>
> **两条结论**：
> 1. **同步数下 `res_multistep` 不会更慢**（30.2 vs 30.2，一秒不差）——
>    证实了源码分析，也推翻了"二阶 = 每步两次调用所以更慢"那个想当然。
> 2. **它的价值在于用更少的步数达到同等可用度**：4 步 15.5 秒 vs 8 步 euler 33.3 秒，
>    **2.15 倍**。要极致细节仍用 8 步 euler，要快就换 4 步 `res_multistep`。
>
> ⚠ **样本只有 2 个提示词 × 1 个种子**，够支持"能用、不崩、快一倍"，
> 不足以支持"任何题材都等效"。换题材（尤其密集文字、复杂手部交互）值得自己再验一次。
> ⚠ **这组数是在 `--highvram`（`comfy-profile.sh image`）档下测的**——生图本来就该用这档。
> DynamicVRAM 档下四份 bench 全面变慢，且**步数越少代价越大**（4 步 +38%、8 步 +17%），
> **4 步相对 8 步的优势从 2.15 倍降到约 1.7 倍**：按需搬权重是每步的固定开销，
> 步数少时它占比更高。→ **换档就要整组重测，别只挪用其中一个数。**
> ⚠ **板上工作流的默认值没有改动**——这是取舍不是升级，改不改由使用者定。
>
> ⚠⚠ **这条结论只覆盖单张图像，不要外推到视频**（2026-09-02 与视频线交叉确认）：
> **图像不崩坏 ≠ 视频帧间不抖动**，那是这套 A/B 完全没有触及的维度。
> 视频线现役就是 `res_multistep` 4 步、已稳定出片两次、画面与音画同步正常，
> **但没有 `euler` 对照组**，无法判断二阶方法是否引入帧间抖动。
> 【C 档 · 想推进要做的】摘掉 4 步 turbo LoRA 跑 `euler` 20 步基准
> （LoRA 本身按 4 步蒸馏，步数与采样器绑定，不摘就分不清是谁的效果），
> 再与 `res_multistep` 比逐帧差分。
>
> **机制**（为什么它每步只算一次还能有二阶精度）：`res_multistep` 是线性多步法，
> 板上源码 `comfy/k_diffusion/sampling.py:1418` 是循环体内**唯一**的 `model()` 调用，
> `:1445` 用 `b2 * old_denoised` 引入上一步的结果，注释标着论文 arXiv 2308.02157，
> 第一步没有历史值时退化成 Euler。**对照组**：`heun` 是 Runge-Kutta 类，
> `:285` 与 `:296` 确实两次调用——**"二阶 = 两次调用"只对 RK 类成立**。
>
> 这条留作两个纪律的实例：① 照抄配置前先问"它解决的问题在我这儿存在吗"（陷阱 17/64）——
> 视频线那个 2.46 倍来自压缩 50 步的冗余，我们 8 步没有冗余可压，**但换来的是另一种收益**；
> ② **推翻一条结论时，理由也要对**——我最初否定它的理由（更慢）被实测和源码双双证伪，
> 而正确的顾虑（蒸馏轨迹会不会坏画面）指向完全不同的验证重点：一个比秒表，一个比画面。
> **按错理由去测，会拿耗时数据得出"没收益"，然后错过真正该看的东西。**

### 2.4 加速 LoRA

原作指定的加速 LoRA 优先用回原作那个，**不要想当然替代**。
实测：`alibaba-pai/Z-Image-Fun-Lora-Distill-4-Steps-2602`（官方，542 MB）
比板上的 `z_image_turbo_distill_patch`（151 MB）**明显更好**——轮廓光更立体、
妆容更精细、衣物质感层次更多，耗时几乎一样。
（顺带推翻过一个想当然：「Turbo 已是蒸馏版，再叠 distill LoRA 会有害」，实测是反的。）

---

## 3. 数据源：先查平台 API，别从搜索引擎开始

**LiblibAI、吐司、Civitai 这类是聚合与分发平台，内容大同小异且多要登录，不是原始出处。**
绝大多数模型和 LoRA 本身开源，原始发布地在 **HuggingFace / ModelScope / GitHub**，板子可直连。

### 3.1 HuggingFace API（第一手段）

```powershell
# 按关键词搜，按下载量排序
Invoke-RestMethod "https://huggingface.co/api/models?search=z-image+lora&sort=downloads&direction=-1&limit=20"
# 查仓库文件清单与**精确字节数**（?blobs=true 才返回 size）
Invoke-RestMethod "https://huggingface.co/api/models/<owner>/<repo>?blobs=true"
```

下载直链固定是 `https://huggingface.co/<owner>/<repo>/resolve/main/<文件名>`。

搜索引擎返回的多是二手教程和聚合站转载；API 返回仓库本身，有下载量、文件名、确切大小，
**直接就能判断下不下得起、放哪个目录**。

### 3.2 已验证可用的 Z-Image 资源

| 仓库 | 内容 |
|---|---|
| `alibaba-pai/Z-Image-Fun-Lora-Distill` | **官方加速 LoRA**，2/4/8 步各版本（542 MB） |
| `alibaba-pai/Z-Image-Turbo-Fun-Controlnet-Union-2.1` | 官方 ControlNet，lite 1.9 G / 全量 6.4 G |
| `worstplayer/Z-Image_Qwen_3_4b_text_encoder_GGUF` | 文本编码器量化 Q8_0 / Q6_K / IQ4_XS |
| `wcde/Z-Image-Turbo-DeJPEG-Lora` | 去 JPEG 伪影（162 MB 与 649 MB 两档） |
| `DeverStyle/Z-Image-loras` | 风格 LoRA（arcane / archer 等） |
| `nphSi/Z-Image-Lora`、`SDim1973/Z-Image-Loras` | 人物角色 LoRA 合集，各 1000+ 个 |
| `Nurburgring/BEYOND_REALITY_Z_IMAGE` | 社区工作流里那个 BEYOND REALITY 底模 |

### 3.3 Manager 自带的三份离线数据（`deploy/comfyui/capability/`）

| 文件 | 用途 |
|---|---|
| `extension-node-map.json` | **节点类型 → 包** 的官方映射，体检器靠它 |
| `custom-node-list.json` | 全部节点包目录（5883 条），查包名与仓库地址 |
| `model-list.json` | Manager 收录的模型与直链 |

### 3.4 什么时候才回聚合站

中文风格 LoRA（"邵氏武侠""国风工笔"这类）HF/ModelScope 上确实搜不到，只在 LiblibAI 上全。
这时才让用户去浏览器下载，**并且必须提醒筛选「适用模型 = Z-Image」**——
FLUX/SDXL 的 LoRA 架构不通，装上无效。

### 3.5 下到板上

```bash
systemd-run --unit=iecu-dl-xxx --collect \
  /var/lib/llm/bin/node /var/lib/llm/tmp/dl.js "<URL>" "<目标文件>" "<日志>"
```

断点续传、结束时校验 Content-Length。**以日志里的 `DONE size=` 行为准**，别看进程还在不在。
板子已全局出网，root 直接跑即可（不再需要 iecufrp 身份）。

模型放哪（搜索根由 `extra_model_paths.yaml` 定义，**两块板不一样，先确认在哪块板上**）：

**这块板（__BOARD_LAN_IP__，现役主力）四个根**：

```
/opt/update/sd-models/…              ← iecu_update，主力（vblkdev54，40G）
/opt/m/sd-models/…                   ← iecu_m（vblkdev50，30G）
/var/data/sd-models/…                ← iecu_data，mergerfs 合并视图，单文件不能跨分支
/var/lib/llm/disks/d23/sd-models/…   ← iecu_d23，真实挂载点（大 GGUF 走 mmap 用它）
```

⚠ **这块板的 `/opt/m0` 故意不登记，绝对不要往那儿放模型**：它是 vblkdev56，
与 `/opt/other` 同一个设备，而 `/opt/other/overlay/upper` 正是 `/var` 的可写层宿主——
往 `/opt/m0/sd-models` 放一个 7G 模型，吃掉的是 `/var` 的空间，而 `/var` 装着
`/var/lib/llm` 整个运行时、面板密码、frpc、`/var/log`。
`df` 会把 `/opt/m0` 和 `/var` 都显示成"17 GB 空闲"，**那不是两块 17 GB，是同一块**。
放进去还有第二重后果：**四个根里没有它，ComfyUI 根本扫不到**。
（批次A的 `/opt/m0` 是 vblkdev23 独立 26G 设备，放模型没问题——**别把两块板的结论搬来搬去**。）

每类模型的目录名都一样：`{diffusion_models,text_encoders,vae,loras,controlnet,model_patches,upscale_models,clip,clip_vision,checkpoints,embeddings}`。

★ **Z-Image 的 ControlNet 放 `model_patches/` 不是 `controlnet/`**，由 `ModelPatchLoader` 加载。
看到 `controlnet/` 是空的不代表没有——2026-09-01 就因为只看了 `controlnet/` 而以为模型丢了。
**判据不是看目录，是看 `/object_info` 里 `ModelPatchLoader.name` 的下拉有没有值。**

> ⚠ **加新的模型类别时，`extra_model_paths.yaml` 三个根都要登记那个键**，
> 否则目录建了、文件放了，ComfyUI 也扫不到。`model_patches` 就漏配过，
> 导致 `ModelPatchLoader` 的下拉一直是空的。

---

## 4. 验证方案：三级，逐级都有明确判据

### L1 — 注册验证（节点真的可用吗）

```powershell
node deploy\comfyui\tools\cap-refresh.js                      # 目标类型出现在快照里了吗
node $s\exec.js "journalctl -u comfyui --since '-10min' --no-pager | grep -c 'IMPORT FAILED'"
```
**判据**：`IMPORT FAILED` 计数 = 0，且目标节点类型出现在 `/object_info` 里。
**假象**：`custom_nodes` 里有文件夹 ≠ 节点已注册。

⚠ **反过来，"快照里查不到"也不等于不可用**：纯前端节点（rgthree 那 15 个、`Note`、
`MarkdownNote`）本来就不在 `/object_info` 里。判断一个查不到的类型是"真缺"还是"前端节点"，
看它的包里 `web/` 下有没有对应的 js——有就是前端节点，界面上能用。

### L2 — 结构验证（连线和模型对得上吗）

```powershell
node deploy\comfyui\tools\wf-doctor.js 适配版.json
```
**判据**：缺节点 0、缺模型 0（bypass 的节点不计入）。
**假象**：前端打开不飘红 ≠ 能跑——**前端只查节点存在与否，不查参数类型**。

**反过来也有两种假象，2026-09-01 两个一起撞上**：

- **报"缺节点"未必真缺。** rgthree 有 15 个**纯前端节点**（`Label`、`Fast Groups Bypasser`、
  `Bookmark`、`Reroute` 等），只由 web/comfyui 下的 js 注册，Python 侧没有实现，
  所以 `/object_info` 里查不到——但界面上完全可用，也不在数据流上，转 API 时自动跳过。
  判据是拿 `web/comfyui/constants.js` 里的 `addRgthree("...")` 清单减去 `/object_info` 已注册的。
  这 15 个已写进 `wf-doctor.js` 的 `FRONTEND_ONLY` 白名单，不再误报。
- **报"不缺"也未必真不缺。** wf-doctor 把 bypass/mute 的节点整个排除在类型检查外，
  但**前端只看类型注册与否、不看 mode**——一个 bypass 掉的未注册类型，照样在界面上飘红。
  现已单列一行提示（不计入"不能跑"）。「文生图4K极速版」里的 `Qwen3_VQA_Plus` 和 `easy int`
  就是这么藏了半个月：体检一路绿灯，用户打开却是两个红框。

### L3 — 出图验证（唯一算数的）

```powershell
node deploy\comfyui\tools\wf-run.js api.json --save 输出目录
```
**判据**（三条都要过，缺一条都不算通过）：

1. **拿到图片文件名**，且耗时合理（几十秒起步）
2. **输出宽高比 ≈ 输入/预期宽高比** —— 见下方，这条最容易漏
3. **人眼看一下图**：内容对不对、有没有明显崩坏

> ⚠ **宽高比是必检项，不是可选项。**（2026-08-15 用户发现）
> 老照片修复工作流里有个 `ImageScale` 写死 `1024×1024` 且 `crop=disabled`，
> 意思是"**强制拉伸到正方形，不保持比例**"。任何 16:9 的输入进去都被压扁，
> 人物明显变形，最终恒定输出 4096×4096。**因为一直用方图测试，这个 bug 藏了很久。**
> 修法：换成 `ImageScaleToTotalPixels`（按总像素等比缩放，`megapixels=1.0`、
> `resolution_steps=8`），832×464 进 → 5472×3072 出，比例 1.781 vs 输入 1.793 ✓。
>
> 由此得出两条纪律：
> - **测试输入图必须保持宽高比**，否则测出来的"变形"是自己造成的
>   （我第一次就用 `DrawImage($src,0,0,512,512)` 把 16:9 拉成 1:1，误判成流程问题）
> - **测试要用非正方形的图**。方图会让所有比例 bug 隐身
>
> 凡是带 `width`/`height` 固定值的缩放节点（`ImageScale`、`EmptyLatentImage` 等），
> 导入时都要问一句：**这个尺寸是作者针对他的输入定的，对我的输入还成立吗？**
>
> ⚠ **换成 `ImageScaleToTotalPixels` 之后还有一个坑：`megapixels` 是 1024 进制。**
> 源码是 `total = megapixels * 1024 * 1024`，不是一百万。
> 2026-09-01 实测：要长边正好 3840（9:16 即 2160×3840），填 **7.92**；
> 填 8.3 会得到 2216×3928，比 4K 大 2.3%。**算法是 `值 × 1048576 = 目标总像素`**，
> 再被 `resolution_steps` 对齐（默认 8）。填错不报错，只是尺寸和你写在说明里的对不上——
> 而**文档与事实打架比数字略大更糟**。

**必须认识的假成功**（每一条都真实误导过一轮）：

| 现象 | 真实情况 |
|---|---|
| `Prompt executed in 0.01 seconds` + status=success + 无图 | 输出节点校验失败，ComfyUI **忽略输出但照样报 success**。去 journal 看 `Failed to validate prompt` |
| 队列空了但 history 查不到该任务 | **进程中途被 SIGKILL**（内存打爆）。`wf-run.js` 会在 5 次空轮询后判定并提示 |
| `wf-doctor` 报 ✅ 可直接跑 | **它查不出内存够不够**。局部重绘那张体检全绿，实跑照样被杀 |
| **同一个 prompt 第二次跑快得离谱（3 秒），status=success，也有图片文件名** | **ComfyUI 的提示词缓存命中，根本没重新生成**。2026-08-16 实测：首次 30.4 秒，同种子再跑 3.0 秒，**文件名与首次完全一样**。判据就是文件名——**没变就是缓存**。测性能必须每次换种子 |
| **`wf-to-api.js` 报「自检通过：无悬空引用」** | **它的自检只查引用、不查参数**。转换器遇到不认识的新参数类型会静默漏掉（已知 `COMFY_DYNAMICCOMBO_V3`、`COMFY_AUTOGROW_V3`），转换阶段一路绿灯，提交才 400。用 `wf-verify-api.js` 补这道闸 |
| **`wf-doctor.js` 报「模型全部就位」** | 它信的是快照。**快照旧了就会把已被删掉的模型报成"在"**（2026-09-01 真实发生）。体检前先 `cap-refresh.js` |

> 这几条是同一个模式的不同变体，值得单独记住这句话：
> **上游报告的"成功"和你要的"能用"是两个命题。**
> 看到任何工具说"通过/成功/OK"，先问一句——**它检查的是不是你关心的那件事？**
> 已经栽过的完整清单：API 返回 200（陷阱 30）、传输成功（39）、systemd 说 active（51）、
> 补丁脚本说"无需改写"（55）、命令行测通了（56）、参数追加"生效"了（63）、
> 转换器自检通过、体检器全绿。

### L4（可选）— A/B 对比

换 LoRA、换量化档、换采样器时的**画面对比**，用固定 seed 跑两次。
API 格式里 `noise_seed`/`seed` 是固定值（前端的 "randomize" 不会生效），所以天然可对比。

⚠ **但测速度必须反过来：每次换种子**。固定种子第二次就是缓存命中（见上表第四行），
测出来的是缓存读取时间，不是生成时间。两个目的对种子的要求相反，别混。
往 API 里插 LoRA 用 `inject-lora.js`，不必改 UI 连线。

---

## 5. 板子硬约束速查（摘要，权威在 `../iecu/SKILL.md`）

> 下面这张表是为了让你在适配工作流时不用跳出去查。**环境本身怎么改、怎么升级，
> 归 iecu skill 管**；这里只回答"当前环境下这张工作流能不能跑"。

| 约束 | 内容 |
|---|---|
| **总内存预算** | 权重总量 ≤ 14 GB，且**生图必须带 `--highvram --disable-smart-memory`**（`comfy-profile.sh image` 档）。⚠ **2026-09-02 复测：结论成立，但归因换了**——不是"ComfyUI 记账错"（comfy-aimdo 的记账其实是对的，它认出 Orin 并把 29415 MB 当共享池），**真实原因就是 A-118：统一内存下 offload 的搬运是纯开销，省不出一个字节却要真搬，所以全常驻才快**。同机 A/B：DynamicVRAM 档生图**慢 14~38%**，峰值内存反而涨到 24~25 GiB。**步数越少代价越大**（8 步 +14~17%、4 步 +23~38%），因为按需搬权重是每步的固定开销 |
| **分辨率** | **没有固定上限，取决于剩余内存**。同一张 1664×928：配 fp16 编码器时被 SIGKILL，换 Q8 编码器（省 3.3 G）后 128.6 秒跑通。**先压权重再谈分辨率** |
| **注意力** | ✅ **有 Flash Attention**（2026-08-16 起，torch 2.11 + CUDA 12.2 编入）。4096 序列注意力峰值 math 1213 MiB → flash **33 MiB**。~~"没有 flash / SDPA 只剩 math 后端"~~ 是旧栈（torch 2.4.1 / CUDA 11.4）的结论，已作废 |
| **ControlNet** | ✅ **能跑**。2026-08-16 512² 21.3 秒（A-156），2026-09-01 局部重绘 768×1024 **36.4 秒**。~~"采样一启动就被杀、512² 也一样"~~ 已作废——根因就是缺 FA，不是架构限制。⚠ 更高分辨率的上限仍未测 |
| **量化格式** | 板上是 **GGUF**（分块量化），不是 FP8 也不是 INT8 张量核心那个。**torch 路径加载不了 fp8 权重**（缺 dtype） |
| **单模型体积** | 7B fp16（14 GB）装不下，SeedVR2-7B、flux-2-klein-9b 这类直接排除，找 GGUF 量化档或更小的。**【算术】** 只要 14 GB 预算不变就成立，不随环境过期。⚠ 但"这个模型装不下"≠"这条路走不通"——**先查有没有量化档**，MiniMax-H3 就曾因为只算了 32B 编码器的 fp16 档被判死，实际社区有 7.91 GB 的 Q2_K（2026-09-01 视频线纠正）|
| **triton** | aarch64 无轮子，依赖 triton 的功能不可用（可选依赖时不影响包加载）。**【实测 2026-08-13】** 上游若发布 aarch64 轮子即作废，动工前值得复查一次 |
| **Crystools 监控** | 板上没有 NVML，它的硬件监控无效，但节点本身（如 Switch any）可用 |
| **"低显存优化"开关** | ⛔ **一律先问它省的是不是我们这种内存**。统一内存下 offload 到 CPU 省不出一个字节（A-124），所以这类开关多半是白搬运甚至直接报错。实例：SeedVR2 的 `blocks_to_swap`（BlockSwap）要求 `dit_offload_device` 与 `device` 不同（即 CPU），在本板上报 `BlockSwap enabled but dit_offload_device is invalid`（2026-09-02 实测）|
| **节点包自带的加速检测** | ⚠ **与板子"有 Flash Attention"是两回事**。A-156 那个 FA 是**自编 torch 2.11 编进去的**，走 torch 的 SDPA 路径；而 SeedVR2 这类包检测的是**独立安装的 pip 包** `flash-attn` / `sageattention` / `triton`，板上一个都没有，它的启动日志会打 `SageAttention ❌ \| Flash Attention ❌ \| Triton ❌` 并退回 math 路径。**同一个名字，两套东西**——用这类包撞上内存问题时，先看它自己的检测行，别拿 A-156 当依据（2026-09-02 视频线实测）|

板子红线（关机、写盘、网络）在 `../iecu/SKILL.md`，动板子前先看那份。

---

## 6. 已知不可行（别再试）

| 事项 | 原因 |
|---|---|
| ~~ControlNet 双分支链路~~ | **已作废，别再照这条放弃**。旧结论"采样期激活值爆内存、与分辨率无关"来自没有 FA 的旧栈；现役栈上 768×1024 实测 36.4 秒出图 |
| SeedVR2 7B / flux-2-klein-9b / FireRed 等大模型 | 单模型就超 14 GB 预算 |
| 云 API 型工作流（节点类型是 UUID） | 那是平台侧执行的，本地没有对应实现 |
| 面板里点 Manager 的 install | 走 pip 无约束，会顶掉自编 torch |
| 用 `pull.js` 拉单个文件 | 它只递归目录，会建出同名空目录。先在板上归拢到临时目录再拉 |

---

## 7. 排错索引

| 现象 | 去看 |
|---|---|
| 节点装了但用不了 | L1 验证；`IMPORT FAILED` 与可选依赖的区别 |
| 参数错位、0.01 秒"成功" | 两种成因：① COMBO 有新旧两种表示法 ② widget 被连线驱动时下标没推进。`wf-to-api.js` 两个都已修 |
| **提交就 400，`node_errors` 说不清少了什么** | 多半是转换器漏了一个它不认识的新类型参数。先跑 `wf-verify-api.js`——它按 `/object_info` 的 required 逐项核对，直接点名缺哪个字段 |
| 体检全绿、前端不飘红、一跑却缺模型 | 快照过期。跑 `cap-refresh.js`，它会列出"少了哪些模型"|
| 连不上板子 / 一堆 node 栈 | `wf-run.js` 与 `cap-refresh.js` 都会按"最常见原因在前"列排查顺序。先确认 `IECU_HOST` 指的是通电的那块板 |
| 出图被压成正方形 / 比例不对 | `wf-scan-size.js` 扫一遍，找 `ImageScale` 写死尺寸且 `crop=disabled` 的节点 |
| 加载阶段（10~20 秒）就被杀 | 上一个任务的权重还常驻，重启服务再跑 |
| 采样阶段才被杀 | 真的内存不够：先换更低量化档压权重，再考虑降分辨率 |
| 换 loader 后报多余入参 | `dropInputs` 没清干净（`weight_dtype` / `device`） |
| 下了模型仍显示缺失 | `extra_model_paths.yaml` 少登记那个类别键；或快照没刷新 |
| Manager 连不上 GitHub | 自建 CPython 的证书路径问题，跑 `deploy/torch-py313/57-comfyui313-setup.sh` 已内置证书环境变量 |
| 进程被 SIGKILL | 内存。先换量化档压权重，再考虑降分辨率 |

---

## 8. 文件索引

| 位置 | 是什么 |
|---|---|
| `deploy/comfyui/tools/` | 五个工具（doctor / adapt / quantize / to-api / run） |
| `deploy/comfyui/capability/` | 能力快照、object_info、官方节点映射、模型库 |
| `deploy/comfyui/workflows/{上游原版,板上适配版,adapt-rules}/` | 原始 / 成品 / 规则 |
| `deploy/torch-py313/50~65` | 现役生图栈的完整构建链（py3.13 / torch 2.11 / CUDA 12.2）|
| `deploy/torch-py313/` | 现役生图栈（py3.13 / torch 2.11 / CUDA 12.2）；其构建链与回滚细节见本目录 |
| `.claude/skills/iecu/SKILL.md` | 板子本体：连接、红线、能力边界 |
| `.claude/skills/iecu/references/evidence-levels.md` | 所有实测结论的出处与证据强度 |
