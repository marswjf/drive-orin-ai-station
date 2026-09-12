# MiniMax-H3 Ref2VA 适配规则（IECU 这块板 __BOARD_LAN_IP__）

日期：2026-09-01
上游原版：`workflows/上游原版/video_minimax_h3_r2v.json`（ComfyUI 内置官方模板）
产出：`workflows/板上适配版/h3-r2v-gguf-q4.json`（多参考图）
     `workflows/板上适配版/h3-t2v-gguf-q4.json`（纯文生视频，由前者派生）

## 为什么必须改

官方模板默认加载的两个文件在这块板上都用不了：

| 官方默认 | 体积 | 为什么不行 |
|---|---|---|
| `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | 19.53 GB | 超过板子实测上限（19.27 GB 载入即被内核 SIGKILL） |
| `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | 14.61 GB | **NVFP4 需要 sm_89**，板子是 sm_87，硬件不支持 |

## 五处改动

### 1. `UNETLoader` → `UnetLoaderGGUF`
换成 `minimax_h3_ref2va_pruned-Q4_K.gguf`（10.60 GiB / 11.38 GB）。

**why**：Q4_K 是在 14 GB 上限内质量最好的一档。用户 2026-09-01 明确定过「Q4，Q3 质量太差」。
Q8_0 是 19.94 GB，单文件就越过板子的 SIGKILL 线，Q6_K 15.45 GB 加上 VAE 也贴死上限。
⚠ 这是 **weight-only 量化**（A-162），省的是常驻内存，算力收益为零，别指望它提速。

### 2. `CLIPLoader` → `CLIPLoaderGGUF`
换成 `qwen3vl_32b_minimax_h3-Q2_K_M.gguf`（12.20 GiB），type 仍是 `minimax`。

**why**：板上 `CLIPLoaderGGUF` 的 type 列表里有 `minimax`，可直接加载，无需任何自定义节点。
选 Q2_K_M 而不是官方建议搭配 Q4_K denoiser 的 Q4_K_M（16.97 GB），是因为编码阶段峰值
16.97 GB 在这块板上余量太小。**这一档是质量短板，跑通后可考虑升到 Q4_K_M（补下只要 7 分钟）。**

⚠ **不要换成 4B 蒸馏编码器**（woodfireind MiniStack 的 2.33 GB 那个）：它是纯文本蒸馏，
**没有视觉通路**，Ref2VA 的参考图进不去。2026-09-01 实测本文件的张量清单确认带完整视觉塔——
`visual.blocks.*` 324 个、`visual.deepstack_merger_list.*` 18 个、`visual.merger` 输出 [4608,5120]
正好是 H3 要求的 5120 维 conditioning，所以**也不需要单独的 mmproj 文件**。

### 3. 插入 `LoraLoaderModelOnly`（turbo 加速）
`UnetLoaderGGUF` → `LoraLoaderModelOnly` →（`BasicScheduler` 与 `BasicGuider` 各一路）。
LoRA 是 `minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors`，强度 1.0。

**why**：把 20 步降到 4 步，是这块板上最大的一笔提速。
选 Comfy-Org 官方的 `*_comfyui_bf16` 版而不是 larryvrh 的原版，是因为**后者针对 full-width
`adaln_proj` 权重，而我们用的是 pruned 检查点，那些目标不存在，叠加时会静默跳过**（不报错，
只是效果打折）。官方这个 comfyui 版是配 Comfy-Org 自己的 pruned 检查点发布的。

### 4. `BasicScheduler` 步数 20 → 4
**why**：与 4 步 turbo LoRA 配套。改 LoRA 就要同步改这里，两者必须一致。
`BasicGuider` 本身不带 CFG（等价 cfg=1.0），正好符合 H3 蒸馏模型的要求——
H3 在 cfg > 1.0 时会直接报错。

### 5. 分辨率 0.4 MP → 0.2 MP、时长 5 秒 → 3 秒
`ResolutionSelector` 改 `["16:9 (Widescreen)", 0.2, 32]` = **608×352**；
`PrimitiveFloat` 改 3 秒（经 `ComfyMathExpression` 换算成 **73 帧**，落在 17k+5 网格上）。

**why**：首次验证要拿到的是「能不能跑通、要多久」，不是成品。
视频的注意力序列长度随像素数与帧数相乘增长，激活内存的增速远快于权重。
先在最小规格上跑通，再逐级放大，比一上来就 864×480 撞 OOM 省时间。
**跑通后的放大顺序**：先加时长（帧数按 17k+5 走：73 → 90 → 124），再升分辨率
（0.2 → 0.3 = 736×416 → 0.4 = 864×480），每次只动一个，撞到 SIGKILL 就退回上一档。

## T2V 版的额外改动

删掉两个 `LoadImage` 节点及其到 `ref_images` 的连线，提示词换成不引用图片的写法。

**why**：`MiniMaxH3ReferenceToVideo` 的 `ref_images` 是**可选输入**，不接就是纯文生视频，
不必再引入 t2v 官方模板——那个模板把节点封进了子图（subgraph），改造面更大、不确定性更高。
一套骨架两个变体，出问题时也好对比。

## 落点与磁盘

| 文件 | 落点 | 为什么在这 |
|---|---|---|
| DiT 11.38 GB | `/var/lib/llm/disks/d23/sd-models/diffusion_models/` | vblkdev23 独立 26G 空盘 |
| 编码器 13.10 GB | `/var/lib/llm/disks/d23/sd-models/text_encoders/` | 同上；两个大件放一起 |
| 视频/音频 VAE | `/opt/update/sd-models/vae/` | vblkdev54，与现有 Z-Image 资产同处 |
| turbo LoRA、embedding | `/opt/update/sd-models/{loras,embeddings}/` | 同上 |
| SeedVR2 超分 | `ComfyUI/models/SEEDVR2/` | 节点写死读 `folder_paths.models_dir/SEEDVR2` |

⚠ d23 这个根是本轮**新登记**进 `extra_model_paths.yaml` 的（键 `iecu_d23`），
用的是**真实挂载点而不是 mergerfs 视图 `/var/data`**——GGUF 权重加载走 mmap，
FUSE 上的 mmap 性能没验证过，10 GB 以上的文件不在这上面冒险。
原 yaml 已备份为 `extra_model_paths.yaml.bak-before-h3-20260901`。

## 内存机制（本轮读代码确认，纠正了一条误判）

H3 全常驻要 29.4 GB，板子只有 28.7 GiB，**必须分时加载**：
编码文本（12.2 GB）→ 释放 → 加载 DiT 采样（11.4 GB）→ 释放 → VAE 解码（5.4 GB）。

板上启动参数 `--highvram --disable-smart-memory` **恰好就是这个行为，不用改**。
判据在 `comfy/model_management.py:882`：

```python
memory_to_free = 1e32
if not DISABLE_SMART_MEMORY or device is None:
    memory_to_free = 0 if device is None else memory_required - get_free_memory(device)
```

`DISABLE_SMART_MEMORY=True` 时 `memory_to_free` 取无穷大，`free_memory()` 会**尽可能彻底卸载**
已加载模型，而不是只腾出刚好够用的量。配 `--highvram`（`unet_offload_device()` 返回 GPU，
不做统一内存下毫无意义的 CPU 搬运），两者合起来正是 H3 需要的组合。

⚠ 此前一度判断这两个参数与 H3 冲突，**那是错的**——把 offload（搬运）和 eviction（释放）
混为一谈了。统一内存下搬运确实白费（A-124），但释放是实打实省内存的。

---

## ★ 2026-09-01 首测失败与修正：GGUF 不是通用格式

第一次跑就在文本编码器上失败，报错来自 ComfyUI-GGUF：

```
custom_nodes/ComfyUI-GGUF/loader.py:98
ValueError: This gguf file is incompatible with llama.cpp!
Consider using safetensors or a compatible gguf file
```

**这条报错有误导性**——它说 "incompatible with llama.cpp"，但抛错的是 ComfyUI-GGUF，
不是 llama.cpp。真正的判定只有三行：

```python
arch_str = get_field(reader, "general.architecture", str)
if arch_str in [None, "pig", "cow"]:
    if is_text_model:
        raise ValueError(...)
```

原先下的 `unsloth/MiniMax-H3-GGUF` 的 `qwen3vl_32b_minimax_h3-Q2_K_M.gguf`
**`metadata_kv_count = 0`**，整个文件一个 metadata 键都没有，`general.architecture`
读不出来，直接撞上这条。

⚠ **文件本身是完好的**：大小精确等于源站的 13102161024 字节，解析文件头能正常读出全部
902 个张量、351 个视觉塔张量。**「大小对得上 + 文件完好 + 加载不了」三件事可以同时成立**，
排查时不要停在校验文件完整性上。

### 根因比 metadata 更深一层：张量命名风格

用 HTTP Range 取前 48 MB 读文件头，四个候选的对比（脚本见
`scratchpad/probe-remote-gguf.js` 的思路，不必下整个文件）：

| 仓库 | metadata 键 | 张量数 | 命名风格 | 视觉塔张量 | ComfyUI 能用 |
|---|---|---|---|---|---|
| unsloth Q2_K_M 13.10 GB | **0** | 902 | HF（`model.layers.*`）| 351 | ❌ arch 读不到 |
| **Abiray Q4_K_M 14.58 GB** | **113** | 902 | HF | 351 | ✅ **现役** |
| realrebelai Q2_K 8.49 GB | 113 | 902 | HF | 351 | ✅ 备选（更省内存）|
| nif0 UD-Q2_K_XL 9.57 GB | 42 | 551 | llama.cpp（`blk.*`）| **0** | ❌ 视觉塔被拆成独立 mmproj |

三种打包目标互不通用：

- **unsloth 那份是给 `stable-diffusion.cpp` 的**（README 的用例就是
  `sd-cli --mode vid_gen --llm qwen3vl_32b_minimax_h3-Q2_K_M.gguf`），
  metadata 剥光、张量名保留 HF 原始风格。
- **nif0 那份是给 `llama.cpp` 的**：张量名转成了 `blk.*` / `token_embd.weight`，
  视觉塔拆成独立的 `*-mmproj-*.gguf`。对 ComfyUI 也没用——
  `CLIPLoader` / `CLIPLoaderGGUF` 只有一个文件输入口，没有 mmproj 输入。
- **Abiray / realrebelai 那份是给 ComfyUI 的**：metadata 齐全、视觉塔与语言层在同一文件。

### 可迁移的两条

1. **GGUF 是容器不是标准，挑它要看「给哪个运行时打的包」**，不能只看量化档和体积。
   同一个模型的 sd.cpp 版、llama.cpp 版、ComfyUI 版三者互不通用。
   仓库名里带 `comfyui`、文件放在 `text_encoders/` 这类 Comfy-Org 目录结构下的，
   通常才是给 ComfyUI 的。
2. **判断不用下整个文件**：GGUF 的 metadata 与张量表都在文件头，
   HTTP `Range: bytes=0-50331647`（前 48 MB）就能完整读出
   `general.architecture` 与全部张量名。13 GB 的文件下错一次的代价是十几分钟，
   探测一次是十几秒。**下大模型之前先探头。**

### 编码器档位的选择

改用 `Abiray/MiniMax-H3-GGUF` 的 `text_encoders/qwen3vl_32b_minimax_h3-Q4_K_M.gguf`
（13.58 GiB / 14.58 GB），而不是更省内存的 realrebelai Q2_K（8.49 GB）。

**why**：unsloth 的 README 明确写「`Q2_K_M` 编码器只配两个最小的 denoiser，
`Q4_K_M` 配其余所有」，我们用的是 Q4_K denoiser，官方搭配就是 Q4_K_M。
编码器的量化档直接决定提示词理解与参考图识别能力，Q2 会成为整条链路的短板。
用户 2026-09-01 定：编码器也用 Q4。

内存账（板子重启后干净基线 MemAvailable 22.1 GB，靠分时加载）：

| 阶段 | 常驻权重 | 余量 |
|---|---|---|
| 文本/参考图编码 | 13.58 GiB | 8.5 GB |
| 采样 | 11.38 GB（DiT）| 10.7 GB |
| VAE 解码 | 5.81 GB | 16.3 GB |

峰值在编码阶段。**前提仍是编码器用完必须真正释放**——这是首测要验的核心问题。
若 OOM，退 realrebelai Q2_K（8.49 GB，ModelScope 上六分钟补下）。

⚠ 磁盘变得很紧：d23 共 26 GB，DiT 11.38 + 编码器 14.58 = 25.96 GB，**下完只剩约 0.5 GB**。
d23 这个盘之后不要再放任何东西。

---

## ★★ 2026-09-02 第二、三次失败：内存实测线与 DiT 的 arch 白名单

### 一、Q4_K_M 编码器实测装不下（推翻我自己的估算）

先前那张「分时加载」的内存表**是错的**。`MiniMaxH3ReferenceToVideo` 的输入是
`clip` + `vae` + `audio_vae` **三者同时**，它们必须共同驻留，编码阶段无法把 VAE 排除在外。

两次实测（每 25 秒采样 `free`）：

| 采样 | used | available | 阶段 |
|---|---|---|---|
| 起点 | 10.6 GB | 18.4 GB | 刚提交 |
| +27s | 13.2 GB | 15.8 GB | 两个 VAE 加载完 |
| +52s | 16.9 GB | 12.1 GB | 编码器加载中 |
| +77s | 20.2 GB | 8.8 GB | 继续 |
| +102s | 23.8 GB | 5.2 GB | 继续 |
| +112s | — | — | **`loaded completely; 15393.81 MB loaded`** |
| +117s | — | — | **`code=killed, status=9/KILL`** |

**两个关键数字**：

1. **Q4_K_M 编码器加载后实占 15.03 GiB，比文件本身的 13.58 GiB 多 1.45 GiB。**
   来自那 433 个 F32 张量（`gguf qtypes: Q4_K (390), F32 (433), Q6_K (50), Q5_K (27), F16 (2)`）
   加上 GGML 包装开销。**估算内存占用不能直接用文件大小，要加约 10% 的量化包装开销。**
2. **它是加载成功之后才被杀的**，死在紧接着的前向计算上——
   加载完 available 只剩 4.3 GB，编码一跑就爆。
   **「装得下」和「装下了还能算」是两个门槛。**

第二次尝试挤内存（停 `llm-embedding` 省 1.3 GB + `drop_caches` 省 3.9 GB，
起点 available 从 21 GB 提到 24.6 GB）**同样失败**，死在同一个位置。
→ **Q4_K_M 编码器在这块板上无解，不是差一点。**

改用 `realrebelai/MiniMax-H3_GGUFs` 的 `qwen3vl-32B-MiniMax-H3-Q2_K.gguf`
（7.91 GiB / 8.49 GB，SHA-256 已校验，`arch=qwen3vl`，视觉塔 351 个张量齐全）。
实测编码阶段峰值 used 18.4 GB、available 余 10.5 GB，**内存这一关过了**。

### 二、DiT 卡在 ComfyUI-GGUF 的架构白名单上

换完编码器后报的是另一个错，在 **DiT** 上：

```
loader.py:105  ValueError: This model is not currently supported - (Unknown model architecture!)
```

`loader.py` 第 12~14 行的两张白名单是写死的：

```python
IMG_ARCH_LIST = {"flux","sd1","sdxl","sd3","aura","hidream","cosmos","ltxv","hyvid","wan","lumina2","qwen_image"}
TXT_ARCH_LIST = {"t5","t5encoder","llama","qwen2vl","qwen3","qwen3vl","gemma3"}
```

**没有 minimax**，`tools/convert.py` 的 `detect_arch` 兜底规则里也没有。

⚠ **升级插件解决不了**：板上装的 `6ea2651e`（2026-01-12）**就是 city96 仓库的最新提交**，
最新代码里搜不到 `minimax`。插件至今没适配 H3，而 ComfyUI 核心早在 8 月 3 日就原生支持了。
**核心支持某个模型 ≠ 配套的量化插件也支持。**

社区的绕法是**把 DiT 的 `general.architecture` 标成 `wan`**（`wan` 在白名单里）。
woodfireind 的 README 写明了这一点：
> The DiT is archived as `"wan"` for quantizer compatibility.

四个候选 DiT 的实测（`gguf-probe-remote.js` 远程读头，不下全文件）：

| 仓库 | 体积 | metadata 键 | arch | 结果 |
|---|---|---|---|---|
| unsloth `minimax_h3_ref2va_pruned-Q4_K` | 10.60 GiB | **0** | 无 | ✗ 认不出架构 |
| **Abiray `MiniMax-H3-Ref2VA-Pruned-Q4_K_M`** | 10.77 GiB | 60 | **`wan`** | ✅ **现役** |
| woodfireind `FL2VA-pruned-Q4_K_M` | 10.60 GiB | 3 | `wan` | ✅ 但是 FL2VA 分支 |
| ChrisColeTech `ref2va_turbo_Q4_K_M` | 10.61 GiB | 4 | **`ltx2`** | ✗ 白名单里是 `ltxv` 不是 `ltx2` |

⚠ ChrisColeTech 那个尤其可惜——它是 turbo LoRA 烘焙版、本可省一次 LoRA 加载，
**但打包时把 arch 写成了 `ltx2`，差一个字母就进不了白名单**。

### 三、可迁移的三条

1. **估内存看「加载后」不看「文件大小」**，GGUF 的量化包装要加约 10%；
   而且要留出前向计算的余量，加载成功不等于跑得动。
2. **同一个模型的 GGUF，DiT 和文本编码器要分别探 arch**——我第一次只探了编码器，
   DiT 直接用了 unsloth 的，结果换完编码器又栽在 DiT 上，白跑一轮。
   **`gguf-probe-remote.js` 现在会自动区分「文本编码器」与「扩散模型」并查对应的白名单。**
3. **换任何模型文件前，先用 `gguf-probe-remote.js` 探一遍**，
   十几秒能省掉十几分钟的下载和一轮失败的实测。
