# MiniMax-H3 视频生成部署（IECU 这块板 __BOARD_LAN_IP__）

2026-09-02 建成并出片。**画面与 32kHz 立体声是模型一次联合去噪生成的**，不是后期合成
（输出 mp4 的 `hdlr` 实测有 `vide` + `soun` 两条轨，编码 avc1 + mp4a）。

> ★ **同日下午起，启动参数换成了 DynamicVRAM 档**，帧数上限从 22 提到 73。
> 机制、实验数据、踩过的坑都在 **[`dynamic-vram.md`](dynamic-vram.md)**，
> 跑测工具在 **[`tools/`](tools/)**，档位切换用 `../comfyui/comfy-profile.sh`。
> 本文件写"怎么用"，那份写"为什么是这些参数"。

## 一、现役组合与实测基线

**★ 2026-09-02 下午起，可选时长从 0.92 秒扩到 10.13 秒**（DynamicVRAM 档，见 `dynamic-vram.md`）：

| 时长 | 帧数 | 耗时 | 峰值 used | 最低 avail | 输出 |
|---|---|---|---|---|---|
| 0.92 s | 22 | 239.0 s | — | — | 138 KB |
| 3.04 s | 73 | 306.4 s | 27.56 GiB | 1.16 GiB | 315 KB |
| **10.13 s** | **243** | **510.6 s** | 28.37 GiB | 0.36 GiB | 874 KB |

全部 608×352 / 24fps / 4 步 / cfg 1.0，H.264 + AAC 双轨（`mvhd` 与 `hdlr` 实测）。
帧数走 17k+5 网格，秒数设定与帧数的换算表在 `tools/README.md`。

⚠ **跑长视频前必须 `systemctl restart comfyui`**。158 帧失败而 243 帧成功，
差别不在帧数而在起步内存（12.0 GB 脏 vs 7.7 GB 干净）——详见 `dynamic-vram.md` 第六节。

原始基线（`--highvram` legacy 档，作对照）：22 帧 / **230.8 秒** / 峰值 27.5 GB。

### 跑之前先确认在哪个启动档

```bash
# 板上，不带参数只看不改
/var/lib/llm/comfy-profile.sh

/var/lib/llm/comfy-profile.sh video   # 生视频档（DynamicVRAM），跑 H3 用这个
/var/lib/llm/comfy-profile.sh image   # 生图档（legacy，--highvram），跑 Z-Image 用这个
```

两档的参数与理由：

| 档 | 参数 | 适用 |
|---|---|---|
| `image` | `--highvram --disable-smart-memory` | Z-Image 等单模型生图（A-124） |
| `video` | `--disable-smart-memory --disable-pinned-memory`（**不带** `--highvram`） | MiniMax-H3 多阶段流水线 |

⚠ **`video` 档与 `deploy/torch-py313/sitecustomize.py` 同进同退**：
删掉那个文件，`video` 档就起不来（static TLS，与内存无关）。
`comfy-profile.sh` 切 `video` 前会检查它在不在，不在就拒绝切换并说明原因。

### 模型文件

| 文件 | 大小 | 落点 | 为什么是这个版本 |
|---|---|---|---|
| `MiniMax-H3-Ref2VA-Pruned-Q4_K_M.gguf` | 11.56 GB | `d23/sd-models/diffusion_models/` | **Abiray 版**，`general.architecture` 标成 `wan`（见第三节） |
| `qwen3vl-32B-MiniMax-H3-Q2_K.gguf` | 8.49 GB | `d23/sd-models/text_encoders/` | **realrebelai 版**，带完整视觉塔（`visual.*` 351 个张量） |
| `minimax_h3_video_vae_fp16.safetensors` | 5.21 GB | `/opt/update/sd-models/vae/` | 官方，VAE 不量化 |
| `minimax_h3_audio_vae_fp32.safetensors` | 0.61 GB | 同上 | 官方，要音频就必须有 |

⚠ `d23` = `/var/lib/llm/disks/d23`，2026-09-02 新登记进 `extra_model_paths.yaml` 的
`iecu_d23` 根，**用真实挂载点而不是 mergerfs 视图**（GGUF 走 mmap，FUSE 上的 mmap 性能未验证）。
这个 26 GB 的盘装完两个大件只剩约 5.8 GB，**不要再往里放东西**。

### LoRA 套装（`/opt/update/sd-models/loras/`）

| 文件 | 大小 | 用途 | 推荐用法 |
|---|---|---|---|
| `minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors` | 1866 MB | **现役**，Comfy-Org 官方 4 步 | 强度 1.0，配 4 步 |
| `h3_ref2va_acc_8step_pai.safetensors` | 1309 MB | 阿里 PAI 官方级 PDD 加速，**Ref2VA 专用** | 8 步无 CFG，待 A/B |
| `h3_turbo_v4_step600_ema.safetensors` | 744 MB | 社区金标准，修掉早期版本的塑料感 | 6~8 步，强度 1.0 |
| `h3_camera_motion_v1_3000.safetensors` | 148 MB | 镜头运动（推拉摇移、环绕、手持） | **触发词 `camera motion` 放提示词开头**，强度 0.8~1.0 |
| `h3_realism_people.safetensors` | 125 MB | 真实人物、皮肤与微表情 | 文件名自带 t2v-i2v-r2v，三种模式通用 |
| `h3_motion_adapter_r16.safetensors` | 60 MB | 快速运动修复（240fps 数据训练） | 打斗/动作场景，强度 1.0（0.75~0.8 可减少物体臆造） |

社区推荐的日常组合：**Turbo + Camera Motion(0.8) + 电影质感(0.7) + Motion Adapter（动作戏才加）**。

## 二、工作流

| 文件 | 用途 |
|---|---|
| `h3-t2v-gguf-q4.json` | 文生视频 |
| `h3-r2v-gguf-q4.json` | 多参考图生视频（≤9 图 / ≤3 视频 / ≤3 音频） |
| `h3-upscale-video.json` | **独立**视频超分（SeedVR2 3B），与生成分两次跑 |

板上位置 `/var/lib/llm/comfyui313/ComfyUI/user/default/workflows/`，
项目内在 `deploy/comfyui/workflows/板上适配版/`，改动理由在 `adapt-rules/`。

### 链路（四个节点是必需件，不是调优）

```
UnetLoaderGGUF ─ LoraLoaderModelOnly ─ MiniMaxLowVRAMAttention ─ MiniMaxChunkFeedForward ─ MiniMaxH3SigmaShift ─┬─ BasicScheduler
                                            (head_chunks=4)          (chunks=2)              (12, 3)            └─ BasicGuider
CLIPLoaderGGUF ─ MiniMaxH3ReferenceToVideo ─ VRAM_Debug(unload_all) ─ BasicGuider.conditioning
                          ↑ vae, audio_vae      ★ 编码完必须卸编码器
SamplerCustomAdvanced ─ VRAM_Debug ─┬─ VAEDecode ─ CreateVideo ─ SaveVideo(codec=auto)
                                    └─ VAEDecodeAudio ↗
```

1. **`VRAM_Debug(unload_all_models=true)` 在 conditioning 路径上** —— H3 全常驻要 29.4 GB，
   板子只有 28.7 GiB，必须编码完就卸编码器。`--disable-smart-memory` **不会**自动卸（陷阱 76）。
2. **`MiniMaxLowVRAMAttention` + `MiniMaxChunkFeedForward`** —— 压采样期瞬时峰值。
3. **`MiniMaxH3SigmaShift(12, 3)`** —— 官方采样文档要求，同时修补 sigma 调度与 transformer 内部；
   12/3 是训练值，音画同步靠两者耦合，**别改**。⚠ 官方 r2v 模板里没带这个节点。
4. **`SaveVideo` 必须传 `codec`** —— 当前 ComfyUI 版本新增的必填参数。

## 三、三个致命细节（换模型/换版本时先看这里）

### 1. DiT 的 `general.architecture` 必须是 `wan`

ComfyUI-GGUF 的 `IMG_ARCH_LIST` 白名单里**没有 minimax**，且插件至今未适配
（板上 `6ea2651e` 就是 city96 仓库最新提交，升级无用）。社区做法是借用 `wan` 这个名字混过检查。

| 候选 DiT | arch | 能用 |
|---|---|---|
| Abiray `MiniMax-H3-Ref2VA-Pruned-Q4_K_M` | `wan` | ✅ 现役 |
| unsloth `minimax_h3_ref2va_pruned-Q4_K` | 无（metadata 为空） | ✗ |
| ChrisColeTech `ref2va_turbo_Q4_K_M` | `ltx2` | ✗ 白名单里是 `ltxv`，差一个字母 |

### 2. 编码器只能用 Q2_K，且必须带视觉塔

- **Q4_K_M 装不下**：加载后实占 15.03 GiB（比文件大 1.45 GiB），而
  `MiniMaxH3ReferenceToVideo` 的 `clip` / `vae` / `audio_vae` 是**同时输入**、无法分时，
  加上两个 VAE 5.55 GB 就没余量做前向。停向量服务 + 清页缓存（多腾 3.5 GB）也救不回来。
- **不能用 4B 蒸馏版**（woodfireind MiniStack 那个 2.33 GB）：它是纯文本蒸馏，
  **没有视觉通路**，Ref2VA 的参考图进不去。
- 判据：GGUF 里要有 `visual.blocks.*`（351 个张量）与
  `visual.merger` 输出 `[4608, 5120]`（H3 要求的 5120 维 conditioning）。

### 3. ~~帧数上限 22~~ → **已解除，现为 243 帧 / 10.13 秒**（2026-09-02 下午）

> 本小节保留原文作推导过程。**结论已被 `dynamic-vram.md` 取代**，
> 当前上限是 243 帧，条件是走 DynamicVRAM 档且跑前重启服务。

73 帧在 VAE 解码阶段 OOM。**根因是 DiT 卸不掉**：解码时 DiT 11.3 GB 仍在内存，
加两个 VAE 5.5 GB 与解码激活就满。

**为什么卸不掉**（2026-09-02 源码定位，`comfy/model_management.py`）：
三个 offload 目标函数的判据不一样——

| 函数 | 行号 | 判据 | `--highvram` 下的目标 |
|---|---|---|---|
| `unet_offload_device()` | 1076 | `vram_state == HIGH_VRAM` | **GPU 自己 = 原地不动** |
| `text_encoder_offload_device()` | 1183 | `args.gpu_only`（我们没开） | CPU，卸得掉 |
| `vae_offload_device()` | 1252 | 同上 | CPU |

我们开着 `--highvram`，**UNet 的卸载目标被设成了 GPU 本身**。所以同一个 `VRAM_Debug`
节点，卸编码器时 `used` 从 26.7 GB 掉到 14.4 GB（有效），卸 DiT 时 `freed memory`
是负数、`used` 只增不减（无效）。

⚠ **这不是「采样器引用未断」**——那是最初的错误解释，已作废。

> ★ **2026-09-02 已推进，本节结论已被取代** —— 见 **`dynamic-vram.md`**。
> 根因不是"卸载写错了"，是**新的内存管理器整个没开**：`--highvram` 在
> `cli_args.py:315` 的 `enables_dynamic_vram()` 里是一票否决项，
> 板上装着的 `comfy-aimdo 0.4.13`（DynamicVRAM）从升级到 0.33.0 那天起从未生效。
> 去掉 `--highvram` 后同一个 `VRAM_Debug` 节点实测 **freed 12.68 GiB**（原先是负数）。
> ⚠ 去掉之前必须先装 `deploy/torch-py313/sitecustomize.py`，否则 ComfyUI 起不来
> （static TLS，与内存无关）。

~~**想推进**（C 档，没试过）：~~
1. ~~去掉 `--highvram` 跑一次~~ → **已做，有效**，见 `dynamic-vram.md` 第二、四节。
2. ~~或改用分块解码（`VAEDecodeTiled`、`VAEDecodeLoopKJ`）~~ → **这条路是死的，不必再试**。
   `comfy/sd.py:992` 的 H3 video VAE 分支写着 `self.handles_tiling = True`，
   注释是 `the model tiles internally (256px spatial, 17-frame temporal chunks)` 与
   `one decoded temporal chunk (with overlap) is all that ever sits in VRAM`——
   **VAE 解码峰值与总帧数无关**，模型自己就在流式分块解码；
   `MiniMaxH3VideoVAE.decode_tiled()` 内部直接 `return self.decode(z)`，
   套一层 `VAEDecodeTiled` 是重跑同一段代码。上游 issue #15453 亦确认此点。

## 四、放大参数的顺序

跑通后逐级加，**每次只动一个**，撞到 SIGKILL 就退回上一档：

1. 帧数按 **17k+5 网格**走：22 → 39 → 56 → 73 → 124 → 158 → **243（已达，10.13 秒）**
   ⚠ 每次跑之前 `systemctl restart comfyui`，否则起步内存不干净会在加载 DiT 阶段被杀
2. 分辨率 0.2 MP(608×352) → 0.3(736×416) → 0.4(864×480)
   ⚠ `ResolutionSelector` 的 `megapixels` 是 **1024 进制**（0.2 × 1024² = 209715）
3. 步数 4 → 6 → 8（配 turbo LoRA；无 LoRA 时官方推荐 `res_multistep` + 21 点）

## 五、下载源

**ModelScope 比 HuggingFace 快 3.6 倍**（同一文件同一时刻实测 47.83 vs 13.33 MB/s）。
⚠ **单连接**即可，多连接会被拒（12 连接时 11 块 `socket hang up`，退回单连接立刻恢复 46 MB/s）。

板上下载器：`/var/lib/llm/tmp/dl.js <URL> <目标> <日志>`（单连接、断点续传、结束校验 Content-Length）。
大文件挂后台：`systemd-run --unit=xxx --collect /var/lib/llm/bin/node /var/lib/llm/tmp/dl.js ...`

⚠ 跨源续传（ModelScope 下一半、HF 下另一半）**可行但必须校验**：
本轮两个大文件都这么下的，`sha256sum` 与 HF API 的 `lfs.oid` 逐位一致。


## 六、视频超分（SeedVR2 3B）—— 必须与生成分两次跑

### 实测基线（2026-09-02）

| 项 | 值 |
|---|---|
| 输入 | 608×352 / 22 帧 / 带音轨 |
| 输出 | **884×512**（1.45 倍），音轨原样保留 |
| 耗时 | **78.45 秒** |
| 内存峰值 | 12.9 GB（很宽松） |
| 参数 | `resolution=512`、`batch_size=1`、`color_correction=lab` |

### ⚠ 为什么不能和生成串在一条工作流里

试过，**必然 OOM**。H3 解码完成时 DiT 11.3 GB 与两个 VAE 5.5 GB **都释放不掉**
（采样器与解码器的引用还没断，`VRAM_Debug` 卸不动，日志里 `freed memory` 是负数），
此时只剩 1.87 GB，而 SeedVR2 要 3.63 GB。

→ **正确架构是两阶段**：先跑 H3 出片 → 把 mp4 放进板上 `ComfyUI/input/` →
跑 `h3-upscale-video.json`。每次只装一套模型。
`GetVideoComponents` 会把原片音轨取出来直通 `CreateVideo`，超分只动画面。

### ⚠ 两个参数陷阱

1. **不要开 `blocks_to_swap`**（BlockSwap）。它要求 `dit_offload_device` 设成与 `device`
   不同的值（即 CPU），而这块板是统一内存——**offload 到 CPU 省不出一个字节**（A-124），
   只会白搬运。开了还会直接报错：
   `BlockSwap enabled but dit_offload_device is invalid`。

2. **`batch_size` 必须是 4n+1**（1 / 5 / 9 / 13）。它决定同批送进时序注意力的帧数，
   越大帧间一致性越好、内存越吃紧。**这块板上只能用 1**——
   `batch_size=5` + `resolution=704` 实测在加载 DiT 阶段就被 OOM 杀掉
   （`Materializing DiT weights to CUDA:0` 之后 30 秒，anon-rss 6.97 GB）。

### 为什么这块板上 SeedVR2 特别吃内存

它自己的优化检测全部不可用：

```
⚠️  SeedVR2 optimizations check: SageAttention ❌ | Flash Attention ❌ | Triton ❌
```

⚠ **注意这与板子「有 Flash Attention」不矛盾**：A-156 说的是 ComfyUI/torch 那条路径
（自编 torch 2.11 编入了 FA），而 SeedVR2 走自己的检测与自己的注意力实现，
它要的是独立安装的 `flash-attn` / `sageattention` / `triton` 包，板上都没有。
没有这些，注意力走 math 路径，内存随「帧数 × 像素」增长很快——
这就是为什么 `batch_size` 只能给 1。

**想提速/提质的方向**（都未验证）：给 py3.13 环境编 `triton`（SeedVR2 三项里最可能编成的）；
或换 `seedvr2_ema_3b-Q4_K_M.gguf`（1.86 GB，比 fp8 的 3.16 GB 更省）。

## 七、待办（都是 C 档：没探测过，不是不行）

### 1. 视频帧间一致性未验证

现役采样器是 `res_multistep` + 4 步，**出片正常、画面不崩、音画同步**（跑过两次，230.8s / 233.1s）。
但**没有 `euler` 对照组**，无法判断二阶方法是否给视频引入了帧间抖动。

旁证（2026-09-02，另一会话在同一块板上做的图像侧 A/B，`z-image-gguf` 1024²，
固定种子、每组重启后干净内存）：

| 配置 | 耗时 | 画面 |
|---|---|---|
| `euler` 8 步（基准） | 30.2 / 33.3 秒 | 基准 |
| `res_multistep` 8 步 | **30.2 秒** | 与基准相当，略亮略柔 |
| `res_multistep` 4 步 | **15.5 秒** | 无崩坏，细节略少 |

两条结论：① **同步数下耗时一秒不差**，印证 `res_multistep` 属线性多步法、
每步只调用一次模型（不是 Runge-Kutta 那种两次）；
② 它的价值是**用更少步数达到同等可用度**（4 步 15.5s vs 8 步 euler 33.3s，2.15 倍）。
⚠ 样本量只有 2 个提示词 × 1 个种子，够支持「能用、不崩、快一倍」，
**不支持「任何题材都等效」**，密集文字与复杂手部交互没测。

⚠ **图像不崩不代表视频帧间不抖**——时序连贯性是图像侧完全没有的维度。

**想推进**：先摘掉 turbo LoRA 跑 `euler` 20 步基准（采样器与 LoRA 的步数是绑定的，
不摘就分不清是谁的功劳），再与 `res_multistep` 21 点比**逐帧差分**，而不只是看单帧。

### 2. 阿里 PAI 的 8 步加速 LoRA 未做 A/B

`h3_ref2va_acc_8step_pai.safetensors`（1309 MB）已下载但没用上。它是 **PDD 并行解码蒸馏**，
与现役 Comfy-Org 4 步是两套不同的蒸馏方案，官方级、8 步无 CFG。

**想推进**：固定种子、固定提示词，比 Comfy-Org 4 步 与 PAI 8 步的画面与耗时。
若 8 步质量明显更好而耗时只涨一点，**对提质比换采样器更划算**。

### 3. ~~帧数上限 22~~ —— ✅ **2026-09-02 已解决，现为 243 帧 / 10.13 秒**

完整过程见 **`dynamic-vram.md`**。一句话：根因不是"卸载写错了"，
而是 `--highvram` 把整个 DynamicVRAM 内存管理器一票否决了。
三个参数一组（去掉 `--highvram`、`--disable-smart-memory`、`--disable-pinned-memory`）
+ `sitecustomize.py` 修 static TLS + 跑前重启服务。

下面是当时的分析，保留作过程留档：

根因见第三节：`--highvram` 让 `unet_offload_device()` 返回 GPU 自己，DiT 的"卸载"原地不动。

**最短的验证路径**：把 `comfyui.service` 的 `--highvram` 去掉，重启，跑同一张 22 帧工作流，
在采样后的 `VRAM_Debug` 前后看 `free -m` 的 `used`——**降了就说明假设成立**，
然后再逐级加帧数试上限。

⚠ **两个必须同时盯的风险**：① 去掉 `--highvram` 后生图（Z-Image）可能回到 A-124 描述的
"默认策略算错账直接 OOM"，所以**验证前先确认另一个会话没在用板子**，
且做好改回来的准备（改 unit 文件 + `systemctl daemon-reload` + 重启）；
② 若两种模式确实需要不同参数，做成**两个 unit 或一个可切换的启动档**，
不要让生图和生视频抢同一套参数。

### 4. SeedVR2 的三项优化都没装

`flash-attn` / `sageattention` / `triton` 板上都没有，超分因此走 math 注意力、
`batch_size` 只能给 1。三者里 **`triton` 最可能给 py3.13 编成**，编成后 `batch_size`
或许能提到 5，帧间一致性会更好。
