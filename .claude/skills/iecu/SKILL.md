---
name: iecu
description: 创时智驾 IECU 3.1 智驾域控制器（NVIDIA DRIVE AGX Orin P3663，跑 DRIVE OS 6.0.9）的运维与二次开发。板上已建成本地 LLM 推理系统（Qwen3.6-35B-A3B + 多模态 + Embedding，CUDA 后端，开机自启）。当涉及这块板子的 SSH 登录、运维面板、LLM 服务、模型更换、交叉编译、硬件/内存/分区/网络/温度、停智驾栈、刷机与恢复、接局域网时使用。关键词：IECU、IECU3.1、Orin-X、DRIVE AGX、DRIVE OS、P3663、创时智驾、智驾域控、172.31.254.38、<BOARD_LAN_IP>、tegra234、llama.cpp、Qwen 本地部署、运维面板。
---

# IECU 3.1 域控制器（DRIVE AGX Orin）

> 单一来源。身份、连接方式、红线、已建成的系统、已查明的事实与**仍是推断的黑箱**都在这里。
> **系统已建成并跑通**：本地 LLM 推理 + 多模态 + Embedding + 运维面板，开机自启，断电重启验证通过。

---


## 三个 skill 怎么分工（先确认自己在哪一个）

| 你要做的事 | 用哪个 |
|---|---|
| 改现有板子：换模型、调参数、排障、加功能、看监控 | **本 skill** |
| 把一块出厂状态的新板子装成当前这样 | `iecu-provision` |
| 导入社区工作流：报缺节点、缺模型、要换模型跑、找 LoRA | `comfyui-import` |

三者共用同一套工具脚本 `.claude/skills/iecu/scripts/`（`exec.js` / `push.js` / `pull.js` /
`probe.js`），**不要在别处复制副本**。

板子的完整状态快照、性能实测与叙述版报告属**内部运维记录，不随发布包分发**；
本发布包保留 `baseline/VERSIONS.txt`（版本矩阵）与 `baseline/models.tsv`（模型清单）作为可部署依据。

---

## 一句话身份（读代码前先记住这条）

**这不是 Jetson。** 是 NVIDIA DRIVE AGX Orin（板号 `p3663-XXXX`）跑 DRIVE OS 6.0.9，你 SSH 进去的 Linux 只是 **Type-1 Hypervisor 上的一个 Guest VM**。所有 Jetson/JetPack 教程（`flash.sh`、`jetson_clocks`、改 extlinux、改设备树 carveout、`nvargus`）在这里成体系地失效。

判据（一条命令复现）：`cat /proc/cmdline` 有 `root=/dev/vblkdev0`、`board_name=p3663-a01`、`aurixfw=AFW`、`isolcpus=5`；`lsmod` 有 `tegra_hv`；`dpkg -l | grep driveos` 是 `nv-driveos-linux-* 6.0.9.0`。

---


## 🧭 板子能力边界（每次开新对话先读这节）

这节存在的原因：**过去每一轮新对话，我都对这块板子的能力做过错误假设**——
有的把没试过的事说成"不可能"，有的把浅浅一看的现象当成结论。下面按证据强度分三档，
**别把 C 档当成 A 档用，更别因为 C 档就不去试**。

### A 档：已实测确认（可以当事实用）

| 能力 | 结论 | 怎么验的 |
|---|---|---|
| **Python** | ✅ 两个解释器并存：**3.8**（厂商 deb 里取出的二进制解到 `/var/lib/llm/py/root`，LLM 服务与旧生图环境在用）与 **3.10.14**（2026-08-14 源码自建 prefix `/var/lib/llm/py310`，228 MB，现役生图环境在用）。~~"板上只能 3.8"~~已作废 | A-112/A-134，实跑 |
| **PyTorch** | ✅ 可用，两种组合：① NVIDIA JetPack 5 的 `torch-2.1.0a0+…nv23.06`（CUDA 11.4、sm_87、cp38）；② **自建 cp310**，2.2.2 与 **2.4.1**（现役）都编成，配 torchvision 0.19.1 + torchaudio 2.4.1，板上 chroot 源码编，2.4.1 耗时 1h36m，wheel 在 `/opt/m0/torchbuild/out/`（现役为 torch 2.11 / py3.13，见 deploy/torch-py313/）。~~"只有 cp38 一种"~~已作废。FP16 矩阵乘实测 **31.4 TFLOPS**。⚠ 两套都要配自编 OpenBLAS 0.3.29——系统 0.3.8 的 CPU matmul 随机出 NaN（A-133，py3.8 侧已于 08-14 换掉） | A-111/A-132/A-133/A-134 |
| **★ 生图栈的版本天花板** | ⚠ **由驱动 12.1 反向锁死，一层压一层，别只看 CMake 门槛**（2026-08-15 用三次作废的编译换来的）：① **CUDA 变体**必须是 `arm64`(Tegra)，sbsa 版的 cuBLAS 在这块板子上必然初始化失败（A-142）；② **CUDA 版本必须 < 12030** —— torch 的 `c10/cuda/driver_api.h` 按**编译时** CUDA 版本决定查哪些驱动函数：≥12080 绑 green context（驱动没有 → 错误 500）、≥12030 绑 multicast（多 GPU 特性，Tegra 单卡不支持 → 错误 46）；③ Tegra 变体里低于 12.4 的只有 JetPack 6.0/L4T r36.2 的 **CUDA 12.2**；④ **CUDA 12.2 的 `cuda_fp16.hpp` 在 C++20 下编不过**（12.3 才修）→ torch 必须用 **C++17**；⑤ torch 的 `CMAKE_CXX_STANDARD` **2.12 起是 20、2.11 及以下是 17** → **torch 只能到 2.11.0**。⑥ 连带：CUDA 12.2 的 nvcc 只支持 **gcc ≤ 12**，torch 2.11 要 ≥9.3 → **gcc-12.5**。→ **最终组合：torch 2.11.0 + CUDA 12.2 + gcc-12.5 + Python 3.13 + cuDNN 9.20**，仍比现役 2.4.1 高七个 minor，FA/flex_attention/PEP585/enable_gqa 全部原生具备。**不受驱动约束的层（Python/cuDNN/gcc）照旧取最高。** 版本约束以 `baseline/VERSIONS.txt` 为准 | A-142/A-148/A-149 |
| **ComfyUI** | ✅ **现役是 py3.13 + 自编 torch 2.11.0 + CUDA 12.2 + Flash Attention**（2026-08-16 起，落点 `/var/lib/llm/comfyui313`）。~~"0.33.0 现役（py3.10 + torch 2.4.1）"~~ 已过期，那套现在是回滚位；更早的 py3.8 + 0.32.0 也还留着。⚠ `comfy_kitchen` 与 `torchaudio` 都是**裸 import 的必需件**，卸掉直接崩 | A-156（2026-08-16 实测），旧值 A-134 |
| **生图** | ✅ **新栈实测（2026-08-16，torch 2.11 + FA）**：基准 1024²/8 步 **30.4 秒**（首张含载入 82.1 秒）、邵氏武侠 1664×928 **57.7 秒**、老照片修复 **48.8 秒**（比例正确保留）、ControlNet 双分支 512² **21.3 秒**。同机同法 A/B：旧栈 comfyui310 基准 42.6 秒 → **快 1.40 倍**。⚠ 测连续出图**必须每次换种子**，相同种子会返回缓存（3.0 秒、文件名不变），那是假数据 | A-156 |
| **生图分辨率** | ⚠ **没有固定上限，取决于还剩多少内存**。同一张 1664×928：配 fp16 编码器时被 SIGKILL，换 GGUF Q8_0 编码器（省 3.3G）后 128.6 秒跑通。机制是注意力矩阵全量实体化、开销随像素数**平方**增长。→ **先压权重再谈分辨率**，别把某次实测的边界值当普适上限 | A-137/A-138 |
| **ControlNet（双分支）** | ✅ **2026-08-16 已解锁**：新栈（torch 2.11 + FA）上 512² **21.3 秒出图**，采样期可用内存最低 5.20 GB。~~A-138 的"跑不动"~~已作废——根因确认就是缺 FA，注意力峰值内存 4096 序列下 math 1213 MiB → flash 33 MiB（省 97%）。⚠ 更高分辨率的上限未测 | A-156（推翻 A-138）|
| **生图内存预算** | ⚠ **模型总量 ≤14 GB，且必须配 `--highvram`**——**结论 2026-09-02 复测后仍然成立，但原来的归因是错的**。<br>❌ 旧归因："ComfyUI 按独立显存假设记账因而算错"。**这条已被推翻**：comfy-aimdo 0.4.13（DynamicVRAM）的记账是对的，日志实测 `comfy-aimdo inited for GPU: Orin (VRAM: 29415 MB)` + `GPU RAM headroom: 2048 MB`，它认出 Orin 并把 29415 MB 整体当共享池，没有假设"显存 X + 另有系统 RAM"。<br>✅ **真实原因就是 A-118**：统一内存下 offload 的搬运是**纯开销**——省不出一个字节，却要真搬。所以**全常驻才快**，与记账对不对无关。<br>📊 **同机 A/B 实测（四份 bench 原件，守则全守）**：DynamicVRAM 档比 `--highvram` 档**全面变慢 14~38%**（`ab-euler` 30.2→35.2s、`ab-resms4` 15.5→21.4s、`p2-euler8` 33.3→38.1s、`p2-resms4` 15.5→19.0s），且**峰值内存反而涨到 24~25 GiB**（aimdo 的 staged 加载会先铺开）。<br>⚠ **步数越少代价越大**：8 步档 +14~17%，4 步档 +23~38%——按需搬权重是每步的固定开销，步数少时占比更高。<br>→ **生图用 image 档，生视频用 video 档，`/var/lib/llm/comfy-profile.sh` 切换** | A-116/A-123/A-124，归因 2026-09-02 修正 |
| **GGUF 量化** | ✅ ComfyUI-GGUF 零改写可用（现役 `gguf==0.19`）。**这是让大模型装得下的主要手段**。⚠ **它是 weight-only，不是 W8A8**（2026-08-16 板上源码确认，A-162）：`dequantize_tensor` 把 Q8_0 权重反量化回 fp16/bf16 再做浮点矩阵乘，包里没有任何 `_int_mm`/IMMA 痕迹。**省常驻内存，算力收益为零**，别把"用了 Q8_0"当成"用上了 INT8 加速" | A-125/A-134/A-162 |
| **DiT 类模型速度** | ⚠ 别按参数量外推，装一个测一个。~~"DiT 天生慢 9 倍"~~ **已被推翻**：Z-Image 从 106.4 秒降到 40.1 秒，原先的差距大半来自 offload 搬运而非架构 | A-119/A-123 |
| **权重精度** | ⚠ 分两件事看：**torch 路径**只有 bf16/fp16/fp32（fp8 缺 dtype、`_int_mm` 没编入、nvfp4 要 sm_89），**且 bf16 与 fp16 速度完全相同**，换精度不提速；但**硬件的 INT8 tensor core 是通的**——cuBLAS TN 布局实测 44.28 TOPS vs FP16 33.03，快 1.34 倍，只是 torch 走不到。**选模型看量化版体积，别只看 bf16** | A-121/A-122 |
| **注意力实现** | ✅ **2026-08-16 起有 Flash Attention**（新栈 torch 2.11 + CUDA 12.2，`USE_FLASH_ATTENTION=1` / `USE_MEM_EFF_ATTENTION=1` 编入并实测强制走该后端不抛异常）。收益：4096 序列注意力峰值 math 1213 MiB → flash **33 MiB（省 97%）**，基准生图 42.6s → **30.4s（1.40×）**，ControlNet 双分支从跑不动变成 21.3s 出图。~~"两套 torch 都没有 FA"~~、~~"这个取舍没有可测的性能损失"~~ 均已作废——后者是在两个都没 FA 的环境之间比出来的。⚠ 旧栈 `comfyui310`（torch 2.4.1 / CUDA 11.4）仍然没有 FA，回滚就会失去这些收益 | A-156（推翻 A-122/A-134 的相关结论）|
| **git** | ✅ 可用。同样解到 `/var/lib/llm/gitroot`，只带系统缺的 3 个库 | 见 `deploy/comfyui/install-git.sh` |
| **torchaudio 音频** | ✅ 功能完整。移走 ABI 不兼容的 `.so` 后走纯 Python 路径，5 个接口全可用 | 实测 |
| **NFS 挂 NAS** | ✅ 可用。板子网口 **10 Gb/s**，到 NAS 0.7~1.3 ms，实测拷贝 90 MB/s | 实测 |
| **全局出网** | ✅ 2026-08-14 起 root/pip/git 直接可上外网（PyPI 200、ModelScope 302、GitHub 200 实测）。靠三条加法路由规则 + `IECU_GUARD` 入站防线，主路由表与厂商规则零改动 | A-130 |
| **容器** | ⚠️ **chroot 可用**（`mount --bind` 正常，注入 123 个 Tegra 库后 `cuInit` 返回 0）；**docker 起不来**（存储驱动 devicemapper `CreatePool` 失败，未深究是否可改 overlay2）| 实测 |
| **存储总量** | 128 GB 全部分配完，无隐藏盘 | A-113 |
| **★ USB 网卡** | ✅ 驱动齐全，实测可加载注册。`kernel/drivers/net/usb/` 下八个模块：`usbnet` `r8152` `ax88179_178a` `asix` `cdc_ether` `cdc_ncm` `cdc_subset` `r8153_ecm`。**r8152 支持的 Realtek PID：`0BDA:8050/8053/8152/8153/8155/8156`**——RTL8153 全系（含 8153E）、RTL8156 全系（含 8156B/BG/BSG）都在内，另有 24 条 OEM 别名（TP-Link/Lenovo/Microsoft/Samsung 等）。`ax88179_178a` 覆盖 ASIX 千兆 10 条，`cdc_ether` 61 条，`asix` 37 条。`systemd-udevd` 在跑、模块签名不强制（`sig_enforce=N`），**插上自动加载，不用手工 modprobe**。`r8152-cfgselector` 也在，能把 8156 从默认 NCM 配置切到 vendor 模式 | A-165 |
| **★ USB 存储** | ✅ `usb-storage` 编在内核里（`modules.builtin`），启动即注册：`usbcore: registered new interface driver usb-storage`，`/sys/bus/usb/drivers/usb-storage` 存在。`scsi_mod` `sd_mod` 同为 builtin（`sd_probe` 在 `/proc/kallsyms`）。文件系统 ext2/3/4、vfat、msdos、exfat、ntfs 全在 `/proc/filesystems`。**驱动侧完备，能不能用只取决于物理口供电与枚举** | A-165 |
| **★ USB 控制器** | ✅ `xhci@3610000` 设备树 `status=okay`，`tegra-xusb` 已绑定，两个 root hub（`usb1` USB2 / `usb2` USB3.1），**各 4 端口**。⚠ 两条启动日志需注意：`usb2-3: supply vbus not found, using dummy regulator`（VBUS 无 regulator 控制）、`usb3: Requested PHY is disabled`（一个 USB3 PHY 被禁用）。`usb_cd`（充电检测）`status=disabled` | A-165 |
| **★ USB 网卡固件** | ⚠ **`/lib/firmware/rtl_nic/` 目录不存在**，r8152 声明的 7 个固件（`rtl8156b-2` `rtl8156a-2` `rtl8153c-1` `rtl8153b-2` `rtl8153a-2/3/4`）全部缺失。驱动走告警路径继续工作，不是 probe 失败（二进制字符串 `skip request firmware`、`unable to load firmware patch %s (%ld)`，`dev_warn` 级）。缺的是 PHY/PLA/USB 三段的补丁与省电优化。**补法**：`/` 只读、`/lib/firmware` 写不进，但 `/sys/module/firmware_class/parameters/path` 可写且当前为空，`/var/lib/llm` 可写（8.8 GB）——固件放 `/var/lib/llm/firmware/rtl_nic/`，把该路径写进 `firmware_class.path`，跨重启要做成独立 unit（纯加法，合红线 10）| A-165 |
| **★★ MiniMax-H3 视频生成（音视频联合）** | ✅ **2026-09-02 跑通并出片**。608×352 / 24fps / 4 步，**最长 243 帧 = 10.13 秒 / 510.6 秒出片**（同日下午换 DynamicVRAM 档后从 22 帧提上来的，11 倍；22 帧那档 230.8 秒、73 帧 306.4 秒），输出 H.264+AAC **双轨**（`hdlr` 实测 `vide`+`soun`，画面与声音是模型一次联合去噪生成的，不是后期合成）。现役组合：DiT `MiniMax-H3-Ref2VA-Pruned-Q4_K_M.gguf` 11.56 GB（**Abiray 版**）+ 编码器 `qwen3vl-32B-MiniMax-H3-Q2_K.gguf` 8.49 GB（**realrebelai 版**）+ 视频 VAE 5.21 GB + 音频 VAE 0.61 GB，均在 `/var/lib/llm/disks/d23/sd-models/`（新登记的 `iecu_d23` 根）。<br>**四个必需件，少一个就跑不起来**：① 编码完成后必须插 `VRAM_Debug(unload_all_models=true)` 卸掉编码器——`--disable-smart-memory` **不会**自动卸，实测编码器 9.59 GB 一直挂着、DiT 加载时叠到 26.7 GB 被杀；② DiT 的 GGUF **`general.architecture` 必须是 `wan`**，ComfyUI-GGUF 的白名单里没有 minimax，且插件至今未适配（板上已是最新版）；③ `MiniMaxLowVRAMAttention(head_chunks=4)` + `MiniMaxChunkFeedForward(chunks=2)` 压采样峰值；④ `MiniMaxH3SigmaShift(12, 3)`（训练值，官方模板里居然没带）。<br>⚠ ~~**帧数上限 22**~~ **已解除（2026-09-02 下午）→ 现为 243 帧 / 10.13 秒 / 510.6 秒出片**，实测 mp4 时长 10.13 秒、874 KB、`vide`+`soun` 双轨。根因不是"采样器引用未断"（那条已作废），而是 **`--highvram` 在 `cli_args.py:315` 是 DynamicVRAM 的一票否决项**，板上装着的 `comfy-aimdo 0.4.13` 从升级到 0.33.0 起从未生效。解法是三个参数一组（去掉 `--highvram`、`--disable-smart-memory`、`--disable-pinned-memory`）+ `sitecustomize.py` 修 static TLS + **跑前 `systemctl restart comfyui`**（158 帧失败而 243 帧成功，差别只在起步内存 12.0 GB 脏 vs 7.7 GB 干净）。切档用 `deploy/comfyui/comfy-profile.sh`。⚠ 分块解码那条路是死的：`comfy/sd.py:992` 里 H3 video VAE 的 `handles_tiling = True`，模型自己就在按 17 帧流式解码，`decode_tiled()` 内部直接 `return self.decode(z)`。完整记录见 `deploy/minimax-h3/dynamic-vram.md`。<br>⚠ 编码器**只能用 Q2_K**：Q4_K_M 加载后实占 15.03 GiB（比文件大 1.45 GiB），与两个 VAE 必须同驻（`MiniMaxH3ReferenceToVideo` 的 `clip`/`vae`/`audio_vae` 是同时输入），装进去就没余量做前向，停向量服务+清缓存也救不回来 | A-166 |
| **★ Qwen3.8-27B（第三个对话档）** | ✅ **2026-08-17 上线，面板「模型配置」第三个按钮**。`unsloth/Qwen3.8-27B-GGUF` 的 **IQ4_XS 14.63 GiB**（`/opt/update/llm/`），**MTP 头内嵌在同一个文件里**（张量 `blk.64.nextn.*`，metadata `qwen35.nextn_predict_layers=1`）。**架构是 `qwen35`——SSM 与全注意力混合**（`full_attention_interval=4`，65 层里只有约 16 层有 KV），板上 build `dd1ea52` 原生支持、**不用重编**。实测：生成 **11.3~12.5 tok/s**、prefill 244 tok/s、加载 76 秒、nvmap 19.5 GiB、ctx 65536 下仍余 5.5 GiB。**KV 只要约 32 KiB/token，128K 也只吃 4 GiB**，上调空间大。思考三档全部可控（`enable_thinking:false` / `reasoning_effort: low\|medium\|xhigh`），**且思考默认就是中文**，不需要 Qwen3.6 那个模板预填技巧 | A-163 |
| **★ MTP 在 dense 上是正收益** | ✅ 同机 A/B（唯一变量 `--spec-type`）：**11.9 vs 9.0 tok/s = 1.32×**，接受率 0.44~0.49，代价 +1.35 GiB。⚠ **不要把"投机解码负收益"那条结论套到这里**——那条只对 A3B 这种极稀疏 MoE 成立（批量验证放大专家读取）。dense 一次前向读一遍权重、顺带验证 N 个 token 的边际成本接近零，**纯访存受限的 dense 正是投机解码收益最大的场景** | A-163 |
| **★ 内存带宽（dense 反推）** | ⚠ **132 GiB/s ≈ 141 GB/s，占标称 204.8 的 69%**。算法：MTP 关闭时 9.0 tok/s × 14.63 GiB/次前向。**必须用 MTP 关闭的数据反推**，开着会把验证阶段的额外计算混进去（会算出偏低的 89）。~~旧值 41~57 GB/s~~ 作废：那是拿 MoE 反推的，专家权重不连续、预取器失效，测到的是"稀疏访问下的有效带宽"不是硬件能力。**架构不同能差 2.5 倍，引用带宽数字必须带上架构** | A-163 |

| **★ 投机解码的调参空间（2026-08-19 全扫过一遍）** | ✅ **现役 `draft-mtp` + `n-max 2` + 不设门控，就是最优解，别再调了**。同法同长度实测（temp 1.0，每次换前缀避免缓存）：基线 11.2 / 10.7 / 10.4 tok/s（三次，噪声 ±5%）；`p-min 0.60` → 10.7；`p-min 0.75` → 11.1；`n3+p0.60` → 10.2；`n4+p0.60` → 10.1；**`n4` 不设门控 → 9.3（明显更差）**。⚠ **置信度门控把接受率从 0.36 拉到 0.86（2.4 倍）而吞吐一动不动**——见陷阱 64，别拿接受率当调优目标 | A-164 |

### B 档：已实测确认"不行"，且知道为什么（别再重试）

| 尝试 | 为什么不行 |
|---|---|
| **★ DFlash / DFlash2 / DSpark 外挂草稿模型（Qwen3.8-27B 上）** | **2026-08-19 三种实现全测过，一律净负收益**，同法同长度（temp 1.0，每次换前缀）：<br>· 旧版 build + **DSpark** n4：8.7 / 7.2 tok/s，接受率 0.194 / 0.126<br>· **新编 b10498（真正的 DFlash2 代码路径）+ DFlash2 专用草稿模型** n4：**8.6 / 8.2**，接受率 0.198 / 0.187；n7 更差，**6.1**，接受率 0.123<br>· 同一个新二进制跑 **MTP n2：11.5 / 11.8**，接受率 0.455 / 0.506<br>→ **DFlash2 比同机 MTP 慢 25~30%，还多吃约 3.4 GB 内存**（可用内存掉到 1.2 GB，DSpark 那次更是掉到 0.23 GB 进 OOM 区），**连 prefill 都慢**（204 vs 237 tok/s）。<br>**别再怀疑"是不是版本太旧/实现不对"**：新二进制的日志明确打出 `adding speculative implementation 'draft-dflash'`、`block_size=8, mask_token_id=248070, n_extract=5, sample_from_anchor=true`（最后这个字段是 DFlash2 独有），草稿模型 GGUF 里 `conv_kernel_size=2 / conv_group_size=16 / selector_rank=256 / selector_top_k=16` 一应俱全，**是装对了但效果为负**。DFlash2 官方标称接受长度 4.80，我们实测 `mean len = 1.79`，不到一半；而 MTP n2 的 mean len 约 1.91，**MTP 反而更高且不用额外加载 1.06 GB 草稿模型**。接受率 0.13~0.20，**贪心（temp 0）下同样是 0.152，排除采样温度因素**。三条独立证据指向同一原因：① 我们的数字与上游 Open issue #25792（"acceptance stuck at ~0.15 … net slowdown"，CPU/Vulkan 逐位一致）完全吻合，我们把 CUDA 这一列补上了；② **DFlash 自己的 PR #22105 支持矩阵就写明分档：纯注意力目标 2.25~8.08 倍，混合/循环目标只有 1.34~1.90 倍**（原文 "due to state management constraints"），而 **Qwen3.8-27B 架构是 `qwen35` = SSM+全注意力混合**，正落在弱档；③ 同架构族的 Qwen3.5-27B 独立实测：循环层要维护约 150 MiB 状态、每次投机都要 checkpoint/restore，**验证 2 个 token 花 1.75 倍而非 1 倍**，结论是"接受率要 >70% 才打平"。⚠ **对照组**：网上 DFlash 跑出 4~4.44 倍的报告，目标模型全是 **Qwen3.6-27B 这种纯注意力稠密模型**，不是我们这个，**别拿那些数字外推**。草稿模型留在 `/opt/m/llm/`（DSpark 1.85 GiB、DFlash2 Q4_K_M 1.06 GiB），要腾空间可删 |
| PyTorch 官方 cu126 aarch64 轮子 | **主动排除 sm_87**（`>=8.0,<9.0 except {8.7}`），连 PTX JIT 退路都封了 |
| jetson-ai-lab 的 JP6 轮子 | 要 glibc 2.35，板上 2.31 |
| Ubuntu 22.04 chroot 里跑新 torch | chroot 本身成功，但 JP6 的 torch 是 CUDA 12.6 编译，撞驱动 12.1 → `Error 200` |
| ~~MiniMax-H3 音视频模型~~ | ~~文本编码器是 Qwen3-VL-32B，光它 Q4 就 18 GB，28.7 GB 装不下~~ **已作废（2026-09-02，A-166）**：那条只算了 32B 教师编码器的一个档位，社区早有 8.49 GB 的 Q2_K（带完整视觉塔）和 4B 蒸馏版。**H3 已在板上跑通并出片**，见 A 档。⚠ 这条把一个能用的能力判死了近一个月，是「C 档写成否定句」的典型代价 |
| MTP + GPU 视觉编码共存 | 硬互斥，**与内存量无关**（7.19 GB 可用照崩），五招叠加只省 0.14 GB |
| 换推理引擎（TRT-LLM/vLLM/MLC…）| 已判死，证据链属内部调优记录，不随本发布包分发 |

### C 档：**没探测过**（不是"不行"，是"不知道"，想做就去试）

> ⚠️ **这一档最容易被误当成 B 档。** 下面每一条都只是没人试过，不构成任何否定结论。

| 事项 | 已知的相关事实 | 想推进要做什么 |
|---|---|---|
| **DLA 两个深度学习加速器** | `/dev/nvhost-nvdla0/1` 存在，`libnvdla_compiler.so` / `libnvdla_runtime.so` 在 `/usr/lib` | 板上 TensorRT 8.6 可用，写个最小 TRT 样例指定 DLA 核跑通即可 |
| **PVA（可编程视觉加速器）** | `/dev/nvhost-ctrl-pva0` 存在 | 同上，未做任何尝试 |
| **docker 改 overlay2 后能否起来** | 失败原因是 devicemapper 存储驱动，不是 namespace | 改 `/etc/docker/daemon.json` 试一次（注意 `/etc` 是 overlay，改动跨重启持久）|
| **视频输入 / 摄像头** | `/props` 说模型支持 video，`/dev/nvhost-ctrl-vi0/1` 与 nvcsi 设备都在 | 从未送过一帧视频 |
| **FLUX / Wan 等新架构的实际速度** | ComfyUI 支持 99 个架构；板上只实测过 SDXL 与 SD1.5 两个数据点 | **别按参数量线性外推**，DiT 与 UNet 访存模式不同，装一个测一个 |
| **内存带宽的直接测量值** | ⚠ ~~"41~57 GB/s"已作废~~（A-163）：那是拿 **MoE** 反推的，稀疏专家访问不连续、严重低估硬件。改用 **dense** 模型反推得 **132 GiB/s**（标称 204.8 的 69%，见 A 档那行）。仍是反推不是直接测量，`tegrastats` 的 `EMC_FREQ` 恒为 0 采不到 | 自己写 CUDA memcpy / STREAM 基准，验证 132 这个数；**反推值必须注明用的什么架构**，换架构能差 2.5 倍 |
| **USB 物理口是否引出、是否供电** | 驱动侧全部具备（见 A 档 USB 三行）。控制器 okay、两个 root hub 各 4 端口。未知的只有物理层：VBUS 用 dummy regulator，供电能力不明；一个 USB3 PHY 被禁用。板上没有 `lsusb` | 插一个真实设备（U 盘或 RTL8153/8156 网卡），看三样：`cat /sys/bus/usb/devices/*/idVendor /sys/bus/usb/devices/*/idProduct`、`ip -br link`、`journalctl -k --since "-1min" \| grep -iE 'usb\|r8152\|cdc_ncm\|firmware'`。分别对应枚举、接口生成、接管驱动是 r8152 还是回落 cdc_ncm |
| **出图是计算受限还是访存受限** | 未测。**这是决定要不要做 W8A8 的前置问题**——若访存受限，量化激活毫无用处 | 用 Nsight Systems / Compute 看 SM 利用率与 DRAM 吞吐；或固定步数改分辨率，看耗时随像素数的标度 |
| **真 W8A8 生图能提速多少** | 现役 GGUF Q8_0 是 **weight-only**（板上源码确认，A-162），算力收益为零。真 W8A8 的天花板是实测的 INT8/FP16 = **1.31×**，不是理论 2× | 先答上一行那个问题。社区有 `ComfyUI-fni8`（列了 Z-Image，走 dp4a 不走张量核心）等三个包，**在 sm_87 + torch 2.11 上能否装、精度损失多大全未验证** |
| **INT8 距硬件上限还有多远** | 实测 45 TOPS，INT8/FP16 仅 1.31×（应为 2×），已排除公式/cuBLAS 版本/矩阵尺寸/API 路径/降频五项（A-160） | Nsight Compute 量 tensor core 利用率，或拿 CUTLASS 手写 IMMA 内核做参照 |
| **万兆口是否承载 VLAN 254** | 未知 | **别试**，赌输就失联，没有现场的人不要动 |
| **`/opt/update` 腾出的 38 GB 长期是否安全** | 已迁走 22 GB 且本地有完整备份；FOTA 服务 masked、智驾栈 disabled | 若将来要恢复固件功能，先把备份传回去 |

**写这节的规矩**：只有实测过的才进 A/B 档；没试过的一律进 C 档，并写清"想推进要做什么"。
**不要把 C 档写成否定句**——那会让下一轮直接放弃，而本轮的 ComfyUI 正是这么差点被放弃的。

---

## ⚠️ 认知陷阱（本 skill 存在的首要理由）

这块板子上，**"看起来合理的结论"被实测推翻已超过十次**。记下来，别重蹈：

1. **平台身份**：按 Jetson 检索了两轮资料全部作废。→ 型号先读 `/proc/device-tree/model` 和 `/proc/cmdline`。
2. **4.1G 内存去向**：初判"被平台服务吃了"，PSS 实测推翻（进程只占 ~200MB）。**后来这 3.9G 又自己回来了**（used 降到 1.25G），所以"内核隐形预留拿不回"也是错的。
3. **空载 67°C**：初判散热不良，实为 performance 锁频 + 省电全关的地板温度。
4. **"板上没有 libcuda.so"**：只查了 Jetson 习惯路径。实际在 `/usr/lib/libcuda.so.1`。→ **查库一律先 `ldconfig -p`**。
5. **`strings` 检测全报 no**：板上没装 binutils，17 行 `command not found` 被我忽略了。→ **批量探测必须看 stderr；"全否"优先怀疑工具缺失**。
6. **模型型号"应该是 30B-A3B"**：用训练数据里的型号表否定用户。查 HF API 确认 **35B-A3B 真实存在**。→ **"我没听说过"不是"不存在"的证据**。
7. **"完全没有恢复素材"**：`/opt/update/package` 里有整套原厂 A/B OTA 签名镜像。
8. **"GPU 显存 23.77 GiB"**：受控实验（`/dev/shm` 占 4/8 GiB）证明它一比一跟随 `MemAvailable`，不是独立显存池。
9. **"解锁 isolcpus 的 CPU5 能拿回算力"**：实测用了反而从 10.5 崩到 **1.67 t/s**。正确做法是显式绑核**避开**它。
10. **"llama-server 内存泄漏"**：做了四组对照实验（mmproj/ctx/后端/CUDA graph）都无果，最后查 `--help` 发现是 `--cache-ram` 默认 8192 MiB 在正常填池子。→ **内存持续增长，先花 10 秒查配置上限，再怀疑泄漏。**
11. **内存守护阈值设 4 GiB**：embedding 一启动的正常波动就误触发重启，还污染了一次测量（出现"净增 -6.73 G"的荒谬数据）。→ **自动化干预的阈值要基于实测水位定，并加宽限期和连续确认。**
12. **单次快照判断增长来源**：看到 nvmap 占 18.5 GiB 就认定"内存在 GPU 侧"，实际那只是模型权重的正常占用。→ **判断增长必须看差分，不能看快照。**
13. **`push.js` 默认断点续传把文件传坏**（2026-08-12，代价是面板挂掉）：推改过的 `server.js` 时，续传逻辑看远端已有同名旧文件，就从旧文件末尾偏移开始写，结果**前半段旧内容 + 后半段新内容尾巴**，拼成语法错误的嵌合体；更隐蔽的是大小相等直接 SKIP，一个字节没传却报 OK。本地 `node --check` 通过、板上语法错误，差异出在传输环节。→ **已改成默认整传 + 传后校验字节数，续传要显式 `--resume`。凡是"本地测好的代码上板就崩"，先怀疑传输，别急着怀疑代码。**
14. **Qwen3.6 是思考模型，"没反应"多半是它**：实测一句 `hi` 也要先输出 ~640 字 `reasoning_content`、**5.6 秒**才吐第一个正文字符；`max_tokens` 给小了则 token 全烧在思考上、`content` 返回空串。RAG/ReAct 每步都思考更会直接超时。→ **正确解法是暴露 `qwen3.6-35b-a3b-nothink` 这个模型名（面板代理在转发时注入 `enable_thinking:false`），让调用方在模型下拉里自己选。** ⚠ **不要在服务端设全局 `--chat-template-kwargs` 关思考**——那会让 Cherry Studio 等客户端自带的思考开关和思考强度彻底失效（2026-08-12 踩过，用户反馈"最常用的软件都没法处理"）。另外 `--reasoning-budget 0`、`/no_think` 后缀、`reasoning_effort` 对本模型统统无效【均实测】。
15. **反向代理不传播"客户端断开"，会把唯一的 slot 堵死**（2026-08-12，WeKnora 因此卡住）：客户端超时断开后，面板到 llama-server 的那条连接还开着，llama.cpp 看不见下游已走，继续生成到 `max_tokens`。**`parallel=1` 只有一个 slot，这个白跑的任务会让后续所有请求排队超时**，现象是"板子 99% 满载但没人拿到结果"。对照实测：直连 8080 断开 → slot 立刻闲；经面板 → 一直忙。→ **已在 `bindUpstream()` 里统一处理：下游 `res` 的 `close`/`aborted` 事件触发 `p.destroy()`。写任何转发层都要记得把取消信号往上游传，否则算力白烧。**
16. **网关报"Invalid JSON response"，根因在面板的错误响应格式**（2026-08-12）：`llm-server` 挂掉那几分钟，面板代理返回的是 `text/plain` 的 502，NewAPI 只能显示"Invalid JSON"，真正原因（后端没起来）完全看不出来。→ **已改成返回 OpenAI 格式的 JSON 错误体。给上游网关用的接口，错误也必须是 JSON。** 排查网关报错时，先分清是"链路不通"还是"响应格式不对"。
17. **照抄网上的 llama.cpp「生产推荐参数」会更慢**：检索到的 128K MoE 最佳实践是给独立显存机器写的。`--n-cpu-moe` 在统一内存架构下**一个字节都省不下**，只会把算力从 GPU 换到弱得多的 CPU；`--rope-scaling yarn` 在 128K < `n_ctx_train` 256K 时纯属多余还损质量；`--numa distribute` 单路 SoC 无意义。→ **照抄配置前先问"它解决的问题在我这儿存在吗"。** 详见 `llm-deploy.md` 的对照表。
18. **`push.js` 整传会丢执行位**（2026-08-12，紧接着上一条坑）：把默认改成整传后，SFTP 按默认权限新建文件，`run-server.sh` 的 `+x` 没了，systemd 报 `203/EXEC Permission denied`，LLM 服务无限重启。→ **已改成传前记住远端权限、传后 chmod 回去（远端不存在且是 `.sh` 则给 755）。改传输逻辑时永远记得权限位也是文件的一部分。**

19. **板子无法被公网端口转发，这不是故障**（2026-08-12）：路由器上 `:PUBLIC_PORT1 → <BOARD_LAN_IP>:9000` 转发规则写得完全正确，却连不上；同一时刻跳板机、路由器管理口、局域网其它服务全部正常。根因是**板子没有回程路由**——`default via 172.31.8.18 dev eth.8` 指向 Hypervisor 内部虚拟网络，公网客户端的包 DNAT 进来后，回包从 eth.8 发进了黑洞。局域网访问不受影响，因为同网段靠 ARP 直达、根本不查路由表。→ **公网入口放在一台反代宿主机上反代过去**（`/opt/iecu-edge/`）。要让板子自己能收公网流量，得加基于源地址的策略路由表（方案见 HANDOVER），但**别为了 SSH 去做**：板子是 root + 弱口令。**排查"转发不通"时，先拿同网段另一台机器做对照，能立刻分清是链路问题还是这台机器的问题。**
20. **`systemd` 报的服务内存在这块板子上是假数据**（2026-08-12）：面板一度显示推理服务占 2.5 GB——而它实际持有 16.5 GB 的模型权重。原因是**权重通过 nvmap 映射到 GPU 侧，不计入进程的 cgroup**。实测真值在 `/sys/kernel/debug/nvmap/iovmm/clients`：推理服务 19.68 GiB、向量服务 2.86 GiB，加上各自的 `RssAnon`（1.91 / 1.33 GiB）才是真实占用（21.6 / 4.2 GiB，和当初 16.4+4.0 的预算测算对得上）。→ **这台机器上谈"某进程占多少内存"，必须 nvmap + RssAnon 一起算，只看 RSS 或 cgroup 会差一个数量级。**
21. **llama.cpp 的内置 Web 界面强制要求 gzip**（2026-08-12）：为了注入汉化脚本，我在代理时删掉了请求的 `accept-encoding`，结果整个聊天界面打不开，返回 `HTTP 415 Error: gzip is not supported by this browser`。它把界面以**预压缩的 gzip 形式**编进二进制，客户端不声明支持 gzip 就直接拒绝。→ 正确做法是**强制带上 `accept-encoding: gzip`，收下之后自己 gunzip、改完再明文发回**。另外注入脚本的路径**不能以 `/llm` 开头**，否则被面板自己的 `/llm` 代理规则接走（这个也踩了）。
22. **`/metrics` 的指标名和网上文章写的完全不一样**（2026-08-12）：检索得到的 `llama_kv_cache_usage_ratio`、`llama_slots_total`、`llama_ttft_seconds` 在板上**一个都不存在**。实测真实前缀是 `llamacpp:`，一共 14 个指标，没有现成的 KV 使用率、也没有 TTFT——KV 占用要用 `/slots` 的 `n_prompt_tokens + n_decoded` 除以 `n_ctx` 自己算。→ **接监控指标前先 `curl /metrics` 看真实字段名，别照着文章写。**

23. **要让板子出网，别改默认路由，用 `ip rule uidrange`**（2026-08-12）：需求是让 frpc 能连出去。改主路由表那条 `default via 172.31.8.18` 是拿唯一入口打赌（无串口），而 `uidrange` 规则可以**只给一个 uid 放行**：`ip rule add uidrange 998-998 lookup 100 priority 30000` + 表 100 里放 `default via <局域网网关>`。实测板上 iproute2 5.5 支持，对照结果——以 root 跑 DNS 查询依然超时（当时板子整体仍不能上外网；**2026-08-14 起已按用户决定放开为全局出网并配入站防线，见 A-130**），以 `iecufrp` 跑则 9ms 解析成功、2ms 连上公网端口。**主路由表、厂商的 `fwmark 0x12c → table 123`、172.31.254.38 全程未动，爆炸半径就是一个进程。** 需要给某个服务开网络特权时，优先想这个办法，别动全局路由。

24. **凭印象写日志/接口的解析规则，一定会错**（2026-08-12，同一天犯了两次）：先是按记忆写 `/metrics` 的字段名（全错，见第 22 条），接着又按印象写 llama.cpp 的日志句式做汉化——真实格式在消息体里还嵌了一层自己的时间戳和级别（`555.03.812.604 I slot print_timing: ...`），而且 `print_timing` 是**周期性进度行**不是耗时汇总，跟我以为的完全两样。→ **写任何解析规则之前，先采样真实数据**。这条命令十秒钟就能把几百行日志压成二十来种句式：

    ```bash
    journalctl -u llm-server -n 800 --no-pager \
      | sed -E 's/^[A-Z][a-z]{2} +[0-9]+ [0-9:]+ [^ ]+ //; s/^[a-zA-Z0-9_.-]+\[[0-9]+\]: //' \
      | sed -E 's/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+ [A-Z] //' \
      | sed -E 's/[0-9]+\.[0-9]+/N/g; s/[0-9]+/N/g' | sort | uniq -c | sort -rn | head -25
    ```
    规则写完再拿真实日志跑一遍统计命中率（`deploy/panel-ui/src/logtext.js` 配套的测试思路：命中 / 隐藏噪音 / 未命中三分类），**别把没验证过的解析逻辑推上板**。

25. **开了 `--metrics` 不等于所有指标都有值**（2026-08-12）：Embedding 服务在面板上"累计处理""平均速度"全空，第一层原因是 `run-embedding.sh` 压根没带 `--metrics`（`/metrics` 直接回 501）。补上之后仍然是 0——**embedding 模式下 `llamacpp:prompt_tokens_total` 和 `prompt_seconds_total` 恒为 0**，那两个计数器只在生成路径累加，编码请求根本不经过；真正会动的只有 `n_decode_total` 和 `n_tokens_max`。→ **要统计编码用量，只能在面板代理层做**：OpenAI 兼容响应体开头就带 `"usage":{"prompt_tokens":N}`（实测在第 48 字节），转发时嗅探前 512 字节取出来自己累加即可，不必缓存整个 20 KB 的向量响应。已实现为 `proxyEmbed()` + `EMBSTAT`。

26. **GR3D 99% 不等于算力被榨干**（2026-08-12）：生成时 GPU 占用长期 94~99%，看起来算力打满。但按激活参数量换算，等效内存带宽只有约 50 GB/s，标称 204.8——**利用率不到四分之一**。原因是 `GR3D_FREQ` 统计的是"GPU 有 warp 驻留的时间比例"，**等内存返回数据的时间同样算 busy**。→ 用这个数字判断"算力够不够"会得出反的结论。判断带宽用 `生成速度 × 每 token 需读的权重字节数` 自己算，别看占用率。顺带一条实测：**这块板子的 tegrastats 永远只输出 `EMC_FREQ @0`**，满载 44 次采样无一例外，内存带宽占用在这块板子上采不到，面板已把这个指标撤掉。

27. **没有 RTC 的板子必须联网校时**（2026-08-12）：`/dev/rtc*` 不存在、`hwclock` 读不到任何硬件时钟，系统时间每次开机从一个基准值往前走，实测跑出 **87 天 9 小时**的偏差（板子以为是 5 月 16 日），日志时间线完全不可用。`systemd-timesyncd` 一直是 enabled，缺的只是出网路径。→ 解法沿用第 23 条的思路：给 `systemd-timesync`（uid 101）也加一条 `uidrange` 规则走表 100，配国内 NTP 源，`timedatectl set-ntp true` 后**三秒完成首次同步**。时区同时设成 `Asia/Shanghai`。时间跳变 87 天对 frp 隧道没有影响（心跳走单调时钟），六个服务全部存活。

28. **界面说明只能讲口径，不能讲道理**（2026-08-12，用户点名批评的第二轮文案问题）：第一轮只清掉了明显的"我为什么这么做"，但 tooltip 里仍留着大量口水话和推测——"多半是调用方超时设置太短""模型常驻会让已用比例一直很高，看这个数才有意义""排队数大于 3 说明请求太密""算力被榨干""不需要人管"。→ **能写的只有四样：这个数是什么、按什么口径统计、阈值多少、单位是什么。** 推测词（多半/通常）、口语比喻（吐出/榨干/一套）、主观评价（体感最强的指标）、使用建议（除非排查故障否则不要改）一律删。阈值写具体数字：不写"剩余内存过低时自动重启"，写"剩余内存低于 0.35 GB 并连续三次确认后自动重启"。**术语还要全局一致**——这块板子是统一内存，别处写着"无独立显存"，服务卡片却写"显存映射区 19.7 GB"，属于同一类错误（已统一为"GPU 映射内存"）。写完逐条扫一遍再推。

29. **HTML 的原生 `title` 属性不是可用的说明**（2026-08-12）：面板上带问号的指标，鼠标移上去什么都不出现——因为用的是原生 `title`，**要悬停整整一秒才弹，触摸设备上永远不弹**，等于没写。→ 自己画浮层：hover / 键盘聚焦立即显示，点击可锁定，渲染到 `document.body` 上避免被卡片边界裁掉（`ui.jsx` 的 `Tip`）。另外**有说明的地方要有视觉标记**（标签下的虚线），否则用户不知道哪里能看解释、哪里移上去是白费。

30. **API 返回成功不等于机制生效**（2026-08-12，调优期两次撞上）：`/slots/0?action=restore`
    返回 200、`n_restored` 数字全对，但后续请求照样全量重算，还把缓存池里原本能命中的条目
    弄失效（上游 issue #26676，板上复现两次）；`--cache-reuse 256` 传进命令行也"成功"，
    实际启动日志里一行 `not supported by this context` 把它静默禁用了。→ **验证缓存/恢复类
    机制，只认"下一次请求的 prompt_n 和耗时"，不认返回码**；改参数后要翻一遍启动日志找
    "disabled/not supported" 字样。

31. **`/opt/other` 看着空 17.9G，实为 `/var` 可写层的宿主，不能当数据盘用**（2026-08-12，
    双模型布局时差点踩上）：`/opt/other/overlay/upper/` 是 overlayfs upperdir——
    `/var/lib/llm`（node、frpc、面板密码）、`/var/log`（syslog 728MB）全部实际落在这个分区。
    塞满它 = `/var` 不可写 = 服务成片异常，没有串口的板子不能赌。顺带实测它读 732/写 500 MB/s
    （比 /opt/m 还快），更显得"可用"，别上当。→ **给分区安家前先 `ls` 根目录看有没有
    overlay/upper，再查 `mount | grep overlay` 确认谁在用它。** 同日另一个小坑：**删除
    正被 llama-server mmap 的模型文件，df 的空间不释放**（inode 被进程持有），要先
    `systemctl stop llm-server` 再删才真正腾出空间——"rm 了但 df 没变"不是文件系统坏了。

32. **"内存快满 + 服务重启"先查内核 OOM，别默认是面板守卫**（2026-08-13 凌晨，MTP 上线次日）：
    现象是 embedding 被杀两次、主推理被杀一次、可用内存跌到 100 MB 以下。实际是**内核
    OOM killer 连杀三次**，面板守卫一次都没触发（它要求"距最后一次推理请求满 5 分钟"，
    而当时用户正在密集使用）。三个坑一起踩：
    - **`dmesg` 里查不到 OOM 记录**——`max_gmsl_dp_ser` 每秒刷两行报错，环形缓冲早被冲掉。
      要用 `journalctl --since "-3h" -p warning | grep -aiE 'oom|killed process'`。
    - **被杀顺序是设计好的**，不是随机：unit 里写死 `OOMScoreAdjust` embedding 300 >
      推理 200 > 面板 -800，所以先牺牲重启只要 9 秒的小服务，面板保命留住远程控制。
      看到"embedding 先挂"应该确认策略生效，不是去修它。
    - **`tegrastats` 的 `RAM 27798/29415MB`（94%）是常态不是故障**：模型权重经 nvmap 常驻，
      这个数永远接近满。判断内存是否真的危险看 `MemAvailable`，不看这个百分比。
    根因是内存预算没有余量（A-85：不可回收内存占 95.7%），以及**MTP 让 prompt 缓存条目
    翻倍到 35.2 KiB/token（A-83），1024 MiB 池只装得下 2.98 万 token**——6 万 token 的
    RAG 会话永远 `skipping`，那 1 GB 池对主力场景零收益却全程占着。→ **给缓存池定容量前，
    先用 `journalctl -u llm-server | grep 'prompt state size'` 配对 `prompt_n` 算出
    每 token 实际字节数，再乘以你的典型会话长度。** 换模型（尤其换投机解码方案）后这个
    系数会变，必须重算。

33. **GR3D 99% 可能只是一次预填充，不是"卡住了"**（2026-08-13）：用户报"重启后还在 99% 占用
    GPU"，实测 `tegrastats` 连采 8 秒全是 `GR3D_FREQ 0%`、llama-server 三秒只用 1 个 CPU tick。
    回查 `/metrics` 发现重启后进来过一个 61885 token 的请求，预填充耗时 100.74 秒（608 tok/s）
    —— 用户看到高占用的那一刻正是这 100 秒。→ **判断"是否还在跑"看 `/slots` 的
    `is_processing` 和 `/metrics` 的 `requests_processing`，别看占用率**（叠加陷阱 26：
    GR3D 把等内存也计为 busy，两头都不可靠）。

34. **换 embedding 计算后端等于换了一套向量，不能"建库用 GPU、查询用 CPU"**（2026-08-13）：
    实测 GPU 与 CPU 算出的向量余弦相似度 0.9997、单维最大差 5.6e-3（A-88），
    **比 F16→Q8 换装的差异还大**——那次是要求整库重建的。错峰思路（平时 CPU 省内存、
    建库切 GPU 求快）恰恰制造了混用。→ **要换就整库重建，两端保持同一个后端。**
    另一个容易漏的点：`-ngl 0` 单独用**不进 CPU 档**，`bin/` 和 `bin-cuda/` 是同一个带
    CUDA 的二进制，仍会建 CUDA 上下文占 GPU 映射内存；必须 `CUDA_VISIBLE_DEVICES=` 置空，
    启动日志出现 `no CUDA-capable device is detected` 才算真切过去。

35. **自己文档里的"约束"也要分清是实测还是调研，尤其是被交接提示词反复转述的那些**（2026-08-13，
    一条假约束让双模型预设多存在了一整天）：交接词里写着"MTP 与 `--mmproj` 互斥"，追到源头
    发现它躺在 tuning 报告的"**R2 调研**"节——来自网上资料，而当初的测试序列第 5 条直接就是
    "换 MTP 模型 + **摘 mmproj**"，**两者同开在板上从来没试过**。实测一次就推翻了：参数层根本
    不拦，`creating MTP draft context` 与 `loaded multimodal model` 同时出现（A-91）。
    同一轮还有第二个例子：**"板上只有 CUDA 11.4"这句话对 TRT-LLM 成立、对 llama.cpp 不成立**——
    11.4 是 DRIVE OS 自带 **toolkit** 的版本，而板上**驱动** `cuDriverGetVersion` 返回 **12010
    (CUDA 12.1)**，我们的生产二进制一直是 nvcc 12.1 交叉编译、runtime 静态链入，根本不用板上
    toolkit。→ **"CUDA 版本"至少有两个含义（toolkit / driver），谈门槛前先问是哪一个。**
    转述任何约束前先查 `references/evidence-levels.md` 属于哪一档；**调研档的约束在动工前值得
    花几分钟实测一次**，成本通常远低于绕开它的工程量。

36. **AI 搜索给的漂亮表格，`primary_sources` 为空就是幻觉，一个数都不能用**（2026-08-13）：
    调研 TurboQuant 性能时，`smart-search` 返回了一份格式完美的"实测报告"——RTX 4090 上
    1.89x/1.96x/2.29x/2.79x 提速、接受率 0.71~0.78、编译 flag `-DTURBO3=ON`。**全是编的**：
    `primary_sources` 是空数组（没有任何抓取到的页面支撑）、`-DTURBO3=ON` 在实际 CMakeLists 里
    不存在、拿没有 MTP head 的 Qwen2.5-7B 测 MTP、接受率与我们板上实测（0.39~0.58）对不上。
    改查真实来源后结论**完全相反**：上游讨论区 #20969 的实测是 **0.987x~0.995x（打平略慢）**，
    TurboQuant 的价值是压缩 4.6× 而非提速。→ **看 AI 搜索结果先看 `primary_sources` 有没有东西；
    空的就只当线索，必须 `fetch` 真实页面再引用。** 越是数字规整、结论顺着你期待走的报告越可疑。

37. **思考链用什么语言不是显示问题，是行为问题——它决定思考量和工具调用质量**（2026-08-13，
    本轮最划算的一个改动，起因是用户随口一句"思考都是英文，强调下中文"）：
    原本每次思考都以固定英文开头 `Here's a thinking process:  1. **Deconstruct User Query:**`，
    长问题动辄 2700 字，带 tools 时更要烧 620~1800 字，`max_tokens` 给不够就
    `finish_reason=length`、tool_calls 全空。**prompt 层面四种写法全部无效**——
    无 system、system 写"请始终使用简体中文思考"、中英双语强调、user 尾部附加，
    中文占比一律 **0%**，四次开头一字不差（A-104），说明是训练固化的模式，不是可指令行为。
    → **有效的是在模板 generation prompt 处预填一句中文**（利用续写惯性而非指令）：
    `{{- '<think>\n' }}` 改成 `{{- '<think>\n好的，我用简体中文来分析这个问题。\n' }}`。
    **一行换三个收益**：思考 0%→79~81% 中文、思考量省 74~82%、
    **思考档带 tools 从 5.1s/620 字 → 2.4s/69 字**（A-105）。
    机制推断（未拆到底）：英文固定开头把模型带进"分析—规划—执行"的冗长套路，
    中文开头打断了它。→ **两条可迁移的教训**：① 模型的固化输出模式，用 prompt 劝不动，
    但可以用"预填开头"改写；② 遇到"思考太长/工具调用不稳"，先看它的思考是用什么语言、
    以什么句式开头的，那里往往就是开关。⚠ 改模板时**别把这行删了**，改完必须回归测 tool_calls。

38. **配置文件里显式写的值，会悄悄覆盖脚本里更合理的默认值**（2026-08-13，一个 `4` 让图像识别慢了一倍多）：
    用户问"怎么只有四五个核心在动"，查下来 `config.json` 写着 `"threads": 4`，
    而 `run-server.sh` 里本来是 `THREADS=${THREADS:-10}`——**默认值早就是对的，是配置把它按下去了**。
    板上 11 个可用核心闲着 7 个，CPU 视觉编码 1024² 因此要 64 秒；改成 10 之后 **28 秒**（A-107）。
    → **看到"某项资源没用满"，先查这一层有没有被显式配置覆盖，再去怀疑架构或内核**。
    这类值往往是早期某次调优留下的，当时的前提（比如还没上 `--no-mmproj-offload`）早就变了。
    ⚠ 本项目有**三份**推理配置（`config.json` + 两个 `config-preset-*.json`），改参数要三处一起改，
    漏一处就会在切档时被打回原样。

39. **前端部署别只看"传成功了"，要核对页面实际引用的是哪个包**（2026-08-13，板上跑了 13 小时的旧界面）：
    用户报"档位文案少两个字"，而源码里早就改对了。真相是 `index.html`（01:01）指着旧 JS，
    11:53 构建的新包躺在 `dist/` 里没人引用——`server.js` 的 `ROOT = __dirname`，
    静态文件从 `panel/` 根提供，`dist/` 子目录根本不在服务路径上。起因是上一轮 push 失败后
    改走 LXC 中转，整个目录 tar 过去就以为完事（A-110）。
    → **推完跑一句 `grep -oE 'index-[A-Za-z0-9_-]+\.js' index.html` 比对 `assets/` 里的实际文件**，
    并把未被引用的旧包删掉，板上永远只留在用的那一个。**"传输成功"和"生效"是两回事**，
    这和陷阱 13、18 是同一类错误的第三种变体。

40. **面板上的"累计""峰值"类指标，不持久化等于没有**（2026-08-13）：
    用户报"会话峰值出不来、中断次数是 0"。两个 bug 各有各的根因，但教训是同一条——
    ① 峰值原本只存在浏览器的 `useRef` 里，**刷新页面就归零**，会话跑完再打开面板永远是空的；
    ② 中断计数的判据写成"还没回第一个字节才算中断"，**流式请求一吐出首字节就再也不记**，
    以至于面板日志里明明有 `[proxy] 客户端断开，已取消上游推理请求`，统计却是 0。
    → 现在峰值由服务端每 10 秒采样时增量更新（没人开面板也在记），和累计用量一起落
    `panel-stats.json`；中断判据改成"响应没正常结束就记"。**写这类指标时先问两个问题：
    页面刷新后还在吗？没人看着的时候还在记吗？**

41. **"一个命令返回空"不等于"这东西不存在"——本轮因此差点放弃整条路线**（2026-08-13，
    代价是先走了一整轮错误方向）：`command -v python3` 返回空，我就断言"板上没有 Python，
    ComfyUI 这条路走不通"。实际 `dpkg -l` 显示 `python3`、`python3.8` 全是 **`ii` 已安装**，
    标准库 205 个文件、`libpython3.8.so.1.0`、venv、distutils 全在，**缺的只是
    `/usr/bin/python3.8` 这一个可执行文件**（厂商刷机时裁掉了，包登记还留着）。
    从 deb 里取出来放进 `/var/lib/llm/py/root` 就跑起来了。
    → **这是第二次栽在同一个模式上**（第 5 条是"strings 全报 no 其实是没装 binutils"）。
    **判断某个东西在不在，至少要两种独立方式交叉验证**：`command -v` + `dpkg -l` + `ls` 包路径。
42. **别把"上游要求更高版本"直接当成"必须降级"——先扫真实语法**（2026-08-13，本轮最大的翻盘）：
    最新版 ComfyUI 声明要 Python 3.9+、torch 2.2+，我据此去找能配 py38 的老版本，
    方向完全反了。用 `ast.parse(feature_version=(3,8))` 全量扫描后发现：**625 个 .py 只有
    1 个真的不兼容**（LTX 音频模块的 `match/case`），而挡路的 `comfyui-frontend-package`
    是 **524 个 js/css + 1 个空 `__init__.py`** 的纯静态包，`Requires-Python: >=3.9`
    纯属元数据声明。两个"要 py3.10"的自研包也有零 `.so`、零语法不兼容的 `py3-none-any` 版。
    → **元数据声明 ≠ 实际语法要求。** 遇到版本墙先扫语法再决定降级，用户那句
    "我们是孤版，自己维护就是了" 是解题关键。
43. **补 shim 只补真正缺的，预防性地往标准库塞名字会引爆别处**（2026-08-13）：
    给 `typing` 补了个用不上的 `ParamSpec`，结果 pip 自带的 `typing_extensions`
    见到它存在，就认定 `typing._ConcatenateGenericAlias` 之类的私有属性也在，
    随即 `AttributeError` —— **pip 整个坏掉**。删掉这个多余的 shim 才恢复。
    → 同一份 shim 文件里还踩了第二个坑：**临时变量名冲突**。`import math as _m` 与
    `_m = ModuleType("numpy.dtypes")` 共用一个模块作用域，后者把前者覆盖，
    于是 `math.lcm` 调用时报 `module 'numpy.dtypes' has no attribute 'gcd'`——
    错得离奇、离现场极远。**写这类全局注入代码：变量名加独立前缀，落盘前先 `ast.parse` 自检**
    （`compat-py38.py` 已加这道自检，因为 sitecustomize 一旦语法错误，所有 shim 会静默失效）。
44. **字符串里拼代码时，`\n` `\t` 会在生成阶段就被吃掉**（2026-08-13）：
    `sitecustomize.py` 是当字符串写出去的，里面一句 `"...for %s:\n\t%s"` 让转义序列
    在生成时就变成真实换行，把字符串字面量拆成多行 → 落盘的文件语法错误。
    更隐蔽的是**它静默失效**：Python 只在 stderr 打一行 `Error in sitecustomize`，
    然后当作没有这个文件继续跑，所有 shim 全部不生效，而报错现场在十万八千里外。
    → 生成代码用不含转义序列的写法（字符串拼接代替 `%s\n`），并在落盘前 `ast.parse` 自检。
45. **改完东西没生效，先确认老进程真的被杀掉了**（2026-08-13）：
    ComfyUI 的 `run.sh` 用 `exec` 启动，进程命令行是 `python3.8 main.py`，
    **不含 `comfyui/main.py`**，所以 `pkill -f 'comfyui/main.py'` 一个都没杀到，
    旧进程带着旧代码继续服务，我却在反复调试"为什么补丁不生效"。
    → **按端口找进程**（`ss -lntp | grep :8188`）比按命令行模式匹配可靠。
46. **测性能前先确认被测的东西真的执行了**（2026-08-13）：
    ComfyUI 按节点输入做缓存，同参数重跑直接命中 `execution_cached` 秒回，
    于是"SDXL 1024² 复跑 2.0 秒"——和 SD1.5 一模一样的数字，还产出同名文件。
    真实值是 26.1 秒。→ **测速脚本要让每次输入都不同**（seed 用时间戳），
    并检查返回里 `execution_cached` 有没有包含采样器节点。
47. **跨发行版拿 deb 时，`sort -V | tail -1` 会取到未来版本**（2026-08-13）：
    ports.ubuntu.com 的 pool 目录混着各发行版的包，按版本号取最新拿到的是 24.04 的，
    它们要 glibc 2.33/2.38，板上只有 2.31。而且**系统里其实已经有大部分依赖**
    （gnutls/krb5/ssl/idn2/tasn1…），从 deb 再带一份反而和系统链条打架。
    → **按目标发行版的版本号精确匹配**；带库进来前先 `ldconfig -p` 查系统有没有，
    只补真正缺的那几个。

48. **"缺 kernel" 必须问清是谁的 kernel——把框架的缺失写成硬件的缺失，会关掉一整条路**
    （2026-08-14，用户质疑"254T 算力你不测测 INT8"之后翻案）：A-120 原本写的是
    "int8 量化模型在板上完全跑不了"，依据是 `_int_mm_out_cuda not compiled for CUDA 11040`。
    这句报错本身没错，**但它只说明 torch 自己没编那个 kernel**。绕过 torch 用 ctypes 直调
    `cublasGemmEx`，**INT8 在 TN 布局下跑到 44.28 TOPS，比 FP16 的 33.03 还快 1.34 倍**（A-121）。
    → **同一个能力至少有三层主体**：硬件有没有（Orin 有 IMMA）、驱动/库有没有（cuBLAS 有）、
    你用的框架接没接（torch 没接）。**报错来自最上层，结论却被我写到了最底层。**
    顺带两条：① NN/NT/TT 三种布局都只有 10.2 TOPS，**只有 TN 能进 tensor core 路径**，
    差 4.3 倍——测算力必须扫布局，单测一种会得出反的结论；
    ② **标称值要拆开看**，254 TOPS 是 INT8 **稀疏** + 两个 DLA 的合计。
    2:4 结构化稀疏的理论吞吐是 dense 的 2 倍，拿随机 dense 权重去跑，
    本来就不该期待标称峰值——**对标对象应该是 GPU dense INT8，不是整机标称值**。
    ⚠ **但也不能反过来把实测值当上限**（2026-08-16 复核，A-160）：
    45 TOPS 是「当前软件栈下的实测值」，不是「硬件上限」。
    判据是 **INT8/FP16 实测比值 1.31×，而 Ampere 架构上 INT8 张量核心吞吐应为 FP16 的 2 倍**
    ——这个比值不依赖绝对峰值，说明 INT8 路径没跑满 IMMA。
    已排除公式、cuBLAS 版本、矩阵尺寸、API 路径（`torch._int_mm` 与 `cublasGemmEx` 同值）、
    GPU 降频（1275/1300 MHz）五项。**上限是多少仍未判定**，
    要定论只能上 Nsight Compute 量 tensor core 利用率，或拿 CUTLASS 手写 IMMA 内核做参照。

49. **基准跑出超过硬件理论值的数字，先怀疑它根本没执行**（2026-08-14）：
    第一版 INT8 基准里 FP16 那行报 **687 TFLOPS**、耗时 0.20 ms——而这块板子的峰值是 33。
    根因是 `CUBLAS_COMPUTE_16F` 要求 alpha/beta 是 **half**，我传了 `c_float` 指针，
    cuBLAS 按 half 读那两个字节读到垃圾值，**kernel 静默不执行且返回 status=0**。
    唯一的破绽是**输出矩阵全是 0**（我顺手加的非零元素计数救了这次）。
    → **性能基准必须带正确性校验**，哪怕只是数一下非零元素；
    只看耗时的基准在"没执行"和"执行得飞快"之间无法区分。

50. **Git Bash 会把命令行里的 `/var/lib/...` 当本地路径改写，远程路径要用 PowerShell 传**
    （2026-08-14）：`push.js` 连报三次 `PUT_FAIL: No such file`，远端目录明明存在且
    `touch` 得动。真相是 MSYS 的路径转换把远程绝对路径改写成了 `C:/Program Files/Git/var/...`。
    换 PowerShell 跑同一条命令立刻成功。→ **凡是给远端用的绝对路径，别在 Git Bash 里传**
    （或设 `MSYS_NO_PATHCONV=1`）。这与 CLAUDE.md §四 的 shell 边界是同一类问题：
    **报错信息指向远端，根因却在本地这一层。**

51. **`systemctl is-active` 说 active，不等于这个服务能接请求——面板拿它当"可用"，
    做出了一个会自我否定的界面**（2026-08-14，用户报"切到生图模式却提示 127.0.0.1 没启动"）：
    `systemctl restart comfyui` 立刻返回 active，而 ComfyUI 要 **30~40 秒**才开始监听 8188
    （`--highvram` 下还要先把权重全部载入）。面板按 active 就放出「打开生图界面」链接，
    用户点进去必然撞 502；更糟的是错误页写着"请在「运行模式」里切换到生图模式"——
    **他明明已经切了**，照做只会陷入死循环。同时 Node 的原始错误
    `connect ECONNREFUSED 127.0.0.1:8188` 被直接拼进页面，内部地址就是这么泄露的。
    → **凡是"能不能打开/能不能点"，判据一律探端口，不看 systemd**（`server.js` 的
    `probePort()` + `units[x].ready`）；界面上把「运行中」拆成「启动中／运行中」两态。
    这与陷阱 30（API 返回成功不等于机制生效）、陷阱 39（传输成功不等于生效）是同一族：
    **上游报告的"成功"和用户关心的"能用"是两个命题。**

52. **阈值要落在实测点上，别用文档里那个约数——我自己就把能跑的配置判成了跑不了**
    （2026-08-14，同一轮内自查发现）：文档里写"模型总量 ≤14 GB"，我照抄进面板做了
    `totalB <= 14 GB` 的判定，结果**实测连出三张稳定的 Z-Image Q8_0（合计 14.53 GB）
    被标成"内存不足"**——一个建议如果和实测打架，用户会照着建议放弃可用的配置。
    真实锚点只有两个：**14.53 GB 实测可用**、**19.27 GB 实测载入即被杀**，中间那段没测过。
    → 改成三档（可用 ≤15 / 接近上限 15~18 / 内存不足 ≥18），**中间档明说"没有实测过"**。
    **写数值判据前先回查实测记录，别用自己文档里为了好记而取的整数。**

53. **子路径反代少一个尾斜杠，整个 ComfyUI 卡在启动动画**（2026-08-14，用户报"反代不彻底"）：
    HTTP 与 WebSocket 反代其实全通（`/comfy/api/*` 全 200、`/comfy/ws` 握手 101），
    问题出在前端怎么算 API 基址：
    `api_base = location.pathname.split('/').slice(0,-1).join('/')`
    —— `/comfy/` 推出 `/comfy` ✓，而 **`/comfy` 推出空字符串** ✗，
    于是所有请求打到面板自己的控制面上，全 404，界面永远等不到数据。
    而面板对两种写法都返回 200、不做重定向，等于把这个雷留着。
    → **子路径挂载第三方 SPA，必须把无尾斜杠 301 到有尾斜杠**。
    排查这类"界面打不开"别只测接口通不通——**接口全通也可能是前端算错了地址**。

54. **给板子装自定义节点前先看它的 requirements，一个 matplotlib 让启动多花 408 秒**
    （2026-08-14）：`ComfyUI_Comfyroll_CustomNodes` 声明依赖 matplotlib，板子不能出网，
    于是每次启动 pip 都要重试三轮 DNS 才放弃，**启动从 31 秒涨到 408 秒**，
    最后还是 `IMPORT FAILED`。它提供的只有两个文本框节点。卸掉后启动回到 31 秒。
    → **节点包的取舍看"它带什么依赖"，不是看"它有多少节点"**；
    板子无外网时，任何会在导入期联网的包都要当成 400 秒起步的代价。
    ⚠ 装节点包后**必须查启动日志的 `IMPORT FAILED` 与耗时**，别只看节点数变没变。

55. **语法扫描看不见运行时不兼容，补丁脚本"无需改写"可能是假的**（2026-08-14）：
    `patch-py38.py` 在 `scan()` 返回 0 时直接 return，于是新加的 `frame.rotation`
    补丁**静默不应用**——脚本打印"无需改写"，服务照样报
    `'av.video.frame.VideoFrame' object has no attribute 'rotation'`。
    根因是这类问题（属性在新版库才有、C 扩展类型不能补属性）**语法完全合法**，
    AST 扫描永远发现不了。→ **补丁表要无条件走一遍（每条自己判断是否已应用），
    扫描结果只用于打印**。这与陷阱 30「API 返回成功不等于机制生效」同族：
    **工具说"没问题"，要先确认它检查的是不是你关心的那件事。**

56. **★ 用命令行测通了，不等于浏览器能用——请求头不一样，结论就不一样**
    （2026-08-14，本轮最难定位、也最该记住的一条）：用户两次报"生图界面卡在载入"，
    我两次测出"全通"然后判定已修复。第一次漏了尾斜杠（陷阱 53），第二次更隐蔽——
    **我的测试脚本没带 `Origin` 头，而浏览器发 WebSocket 必带**。
    带上 Origin 后 ComfyUI 判定跨站，**既不返回错误也不断开，就把连接挂着**，
    15 秒超时；不带则 10 毫秒返回 101。逐头对照才定位到（A-129）。
    → **两条硬教训**：
    ① **测客户端问题，就要用客户端真实的请求头**——UA、Origin、Referer、
       Accept-Encoding、Cookie 少一个都可能得出反的结论。写模拟脚本时先照抄一份真实请求。
    ② **"挂起"比"报错"难查十倍**。任何转发层都要给"上游没按预期响应"补一个分支
       （`up.on('response')`），宁可回 502 也不要让连接静默挂着——
       用户侧表现是"一直在转"，日志里什么都没有，无从下手。
    这与陷阱 30/39/55 同族：**验证的对象要和真实使用路径完全一致，差一点就白测。**

57. **定时器 active 不等于任务在跑：`RemainAfterExit=yes` 的 oneshot 会让定时器永远空转**
    （2026-08-14，`iecu-egress.timer` 空转了近三个月才被发现）：该 service 用
    `RemainAfterExit=yes` 保持 active（为了 `systemctl stop` 能触发 ExecStop 撤规则），
    而 **systemd 对已 active 的单元再 start 是空操作**——定时器每 5 分钟触发的全是空转，
    `list-timers` 显示 `NEXT n/a`，journal 里只有开机那一次执行记录。"换网络 5 分钟自动
    接管"从来没生效过，站点识别一直全靠开机那一次探测。→ 修法：定时器改指向一个不驻留的
    `-recheck` 单元（普通 oneshot，跑完即退）。**验证周期任务只认 journal 里的实际执行
    记录**（`journalctl -u xxx --since -1h | grep -c ...`），timer 与 service 的
    active 状态都不算数。与陷阱 30/39/51/55 同族。

58. **在 overlay + bind 挂载的机器上，`du` 量出来的目录大小两个方向都会骗人，只有 `df` 可信**
    （2026-08-14，torch 构建收尾时差点误判红线已破）：`du -sh /var` 报 22G（钻进 chroot 的
    bind 挂载，把 `/opt/m0` 的数据重复计入，偏大 5 倍）；`du -shx /var` 报 43M（overlay 未
    copy-up 的下层文件 `st_dev` 不同被 `-x` 跳过，偏小 99%）；真实值 `df` 报 5.5G。
    → **判断"某分区还剩多少/用了多少"，一律 `df`**；`du` 只用于比较同一挂载点内部的相对大小。
    误信 `du` 的后果是对着假红线去删东西——在这块板子上删错东西没有后悔药。

59. **★ NVIDIA 的 ARM CUDA 有三个变体，选错的表现不是报错而是"能加载、初始化失败"——
    上一版整轮的将就都源于这一个选择**（2026-08-15，A-142）：`sbsa`（ARM 服务器 + 独立显卡）、
    **`arm64`（Tegra/Jetson 集成 GPU）**、`cross-linux-aarch64`（交叉编译）。此前一直从
    `repos/ubuntu2004/sbsa` 装，于是 CUDA 12.x 的 cuBLAS **必然**失败：`cublasCreate` 返回
    3(ALLOC_FAILED)，日志写 `cublasLtCtxInit: Failed to initialize internal constants`，
    **12.0 / 12.2 / 12.6 / 12.9 全部失败**，内存充足也一样。表现极具迷惑性——`ldd` 全解析、
    没有 not found、库能加载，只是初始化不了，很容易读成"版本太高不兼容"于是去降版本，
    **而降到 12.0 一样失败**。换成 `repos/ubuntu2204/arm64` 的同版本包，cuBLAS、
    fp16 tensor-core GEMM、NVRTC 运行时编译全部通过。
    → 由此连带推翻了三条旧结论：「CUDA >12.1 判死于 Error 200」（错，真 cubin 可以，
    只有纯 PTX 不行）、「板上只有 CUDA 11.4 运行库」（错，Tegra 版 12.9 装得上）、
    「SeedVR2 的 NVRTC 故障无解」（那条路本身是通的）。
    **教训：同一个包名在不同变体仓库里都存在且版本号相同，出错时先问"变体对不对"，
    再问"版本高不高"。** 另附：deb 声明的 glibc 依赖（2.35）不等于 .so 的真实符号需求，
    `dpkg-deb -x` 直接解包就能绕过声明验证——板上 glibc 2.31 实测跑得动。

60. **★ 判断"某版本能不能用"，光看 CMake 门槛远远不够——要 grep 它绑定了哪些驱动 API**
    （2026-08-15，代价是三次作废的编译，A-148/A-149）：torch 2.13 的门槛写的是
    CUDA≥12.1、gcc≥11.3、Python≥3.10，**我们全都满足**，编译也成功（wheel 190MB、
    `torch.cuda.is_available()` 返回 **True**、`get_arch_list()` 正确报 `['sm_87']`、
    `get_device_capability` 正确报 (8,7)）——**但一建 CUDA 张量就报错**。
    换 CUDA 版本只是换错误码：12.9 → `cudaErrorSymbolNotFound`(500)，
    12.4 → `cudaErrorDevicesUnavailable`(46)。排查时把所有"看起来相关"的都排除了
    （fatbin 里 380 个 sm_87 cubin 零 PTX、ctypes 直调 cudart 全通、nvcc 编的对照程序
    含大 fatbin/device printf/`-rdc`/`MemcpyToSymbol`/C++20 全通、EAGER/禁缓存分配器/
    `CUDA_LAUNCH_BLOCKING`/禁 cuDNN 全无效）。**答案在 torch 自己的源码里**：
    `c10/cuda/driver_api.h` 有一张驱动函数表，每项标注所需 CUDA 版本，
    `#if >= 12080` 进 green context 组、`#elif >= 12030` 进 multicast 组，
    而板上驱动 12.1 没有前者、Tegra 单卡不支持后者。
    → **以后每次考虑升级，先 grep 这类函数表，再决定编不编**；
    **"编译成功 + is_available()=True + arch 报对"三条同时成立，仍然可能完全不能用，
    判据必须是真的跑起来一个 kernel。** 与陷阱 30/39/51/55/56 同族，但这次代价最大。

61. **并发估算要按"最吃内存的那个阶段"定，不是按平均——前半程的平稳是假安全感**
    （2026-08-15 一次真实 OOM，A-147）：按 3GB/job 设 `MAX_JOBS=7`（依据是 cc1plus
    实测峰值 1.2GB，对普通 C++ 文件成立），前 2700 个目标一路顺利、**采样到的最低可用内存
    还有 17.7GB**，于是判定"内存安全"。**进度过半进入 cutlass 内核后立刻崩**：
    nvcc 的 cicc 前端做模板实例化时单进程 RSS 实测 **5.7GB**，同时 4 个就吃掉 21GB，
    板子 30GB 且 `SwapTotal=0`，内核 OOM killer 连杀，`MemAvailable` 归 0，
    **SSH 与面板同时失去响应约 5 分钟**。→ 三条：① 并发按峰值阶段算（改成 5GB/job、上限 4）；
    ② **判断"板子是不是挂了"要分层探测**——ping 2ms、22/9000 端口 TCP 握手正常，
    只是应用层被拖死，据此判成"失联"就会做出错误处置；③ 这块板子没有 swap，
    编译这类有明确峰值的任务值得临时挂个 swapfile 当保险垫（放 `/opt/update` 别放构建盘，
    `swappiness=10`，用完 `swapoff` + `rm` 完全撤销）。

62. **★ 不要在 PowerShell 里做批量文本替换——它会静默毁文件，而且"命令没报错"**
    （2026-08-15）：写了 `@{ 文件 = @(@('旧串','新串')) }` 想批量改几处措辞，
    **PowerShell 把嵌套数组展平了**：`@(@('a','b'))` 变成 `@('a','b')` 两个字符串，
    于是 `$pair[0]` / `$pair[1]` 取到的是**首字符和第二个字符**，
    `$t.Replace($pair[0],$pair[1])` 退化成单字符全局替换。结果 `57-comfyui313-setup.sh`
    全文的 `p` 被换成 `y`（`python`→`yython`、`/opt`→`/oyt`、`pip`→`yiy`），
    `mount-stack313.sh` 的全角 `（` 全变成 `p`，**两个文件还被推上了板**。
    脚本"成功"输出了"改: 文件名"，全程零报错。
    → ① 多处改动用 Edit 工具逐处改，匹配不到会报错；② 非用不可时写扁平数组或显式
    `.Replace('旧','新')` 逐行调用；③ **改完、传完都必须回读校验**——grep 损坏特征 +
    `bash -n` 语法自检，本地板上各一遍。这条与陷阱 13（push.js 传输损坏）是同一个判据：
    **"没报错"不是"做对了"的证据，只有回读是。**

63. **llama.cpp 的重复命令行参数取第一个，不是最后一个——"追加一个覆盖掉"的写法不成立**
    （2026-08-17 上 Qwen3.8-27B 时踩到）：`run-server.sh` 里写死了 `--alias qwen3.6-35b-a3b`，
    我想不改脚本、只在预设的 `extraArgs` 末尾追加 `--alias qwen3.8-27b` 把它盖掉。
    **服务正常起来了、模型路径也确实换成了 Qwen3.8，但 `/props` 报的 `model_alias`
    仍是 `qwen3.6-35b-a3b`**——于是客户端下拉里挂着一个名不副实的条目，
    `/v1/models` 和面板派生的 `-nothink` 变体全都跟着错。
    → 解法是让 `run-server.sh` 从 config 读 `alias`（缺省值保持原值，老预设行为不变）。
    **两条教训**：① 别假设"后面的参数覆盖前面的"，这是每个程序自己的解析约定，
    llama.cpp 是首次出现优先；② 为了规避"改脚本要推板"的风险而绕道，
    绕出来的方案同样要验证——这次绕道本身没有更省事，只是把失败推迟了一轮。
    与陷阱 30/39/51/55/56 同族：**上游报告的"成功"和你要的"生效"是两个命题。**

64. **★ 接受率不是目标函数，tok/s 才是——这块板上能把接受率翻 2.4 倍而吞吐一动不动**
    （2026-08-19 扫 MTP 参数时量出来的）：给 `--spec-draft-p-min` 加置信度门控后，
    接受率从 **0.36 涨到 0.86**，草稿数从每轮 172 降到 79，看指标像是大幅改善，
    **实测吞吐 10.4 → 11.1 tok/s，落在 ±5% 的run-to-run 噪声里，等于没动**。
    机制：这块板是**访存受限**的，每个解码步都要把 14.63 GiB 权重读一遍（111 ms），
    **草稿 0 个、2 个还是 4 个,这 111 ms 一分不少**。门控省掉的是"废草稿"的成本——
    而废草稿在这里几乎不要钱；被门掉的那次投机反而丢掉了一个本可能白拿的 token。
    所以门控是拿确定的上限去换一笔本来就不存在的开销。
    → **两条教训**：① 调投机解码只认 tok/s，接受率只是过程量，别拿它当 KPI；
    ② 网上的调参规则（这次是 `sudoingX/qwen38-mtp` 说"门控让深度草稿在带宽差的机器上几乎免费"）
    **要先问它的机器和你的瓶颈是不是同一个**——同样叫"带宽受限"，它的基线是几十 tok/s，
    我们是 9，代价结构完全不同。与陷阱 17 同族（照抄配置前先问"它解决的问题在我这儿存在吗"）。

65. **★ 交叉编译 llama.cpp：CUDA 版与 CPU 版的配方是"不对称"的，照抄一边必炸另一边**
    （2026-08-19 当天踩了两次，第二次是在自以为已经搞清楚之后）：
    - **CUDA 版**：`-DGGML_STATIC=ON` **加上** 注释掉 `ggml/src/CMakeLists.txt` 的
      `add_link_options(-static)`，两件缺一不可（下面那条记的就是这个）。
    - **CPU 版**：**绝不能开 `GGML_STATIC`**，只保留那个 patch。开了会把非 PIC 的
      `libpthread.a` / `libgomp.a` 静态链进 `libggml-base.so`，报
      ``relocation R_AARCH64_ADR_PREL_PG_HI21 against `__stack_chk_guard@@GLIBC_2.17`
      … can not be used when making a shared object``。
    - **为什么不对称**：`GGML_STATIC=ON` 对 CUDA 版的唯一价值是让 ggml-cuda 走
      `CUDA::cudart_static`（否则交叉链接找不到 aarch64 的 `libcudart.so.12` 符号）；
      **CPU 版根本没有 CUDA 运行时要静态链，开着只剩坏处**。
    → 改 configure 参数后**必须 `rm -rf` 构建目录**：`CMakeCache.txt` 里残留的
      `GGML_STATIC:BOOL=ON` 不会被新的 configure 覆盖掉，会让你以为改了其实没改。
    → 脚本已固化：`deploy/build/4-build-dflash2.sh`（CUDA，ON）、
      `5-build-cpu-and-pack.sh`（CPU，OFF + 打包成单一版本的完整包）。

    以下是这条规则里 **CUDA 版那一半**的完整来龙去脉（2026-08-19 编 DFlash2 时重踩，
    而且是被自己写错的注释坑的）：
    `deploy/build/2-build-llama.sh` 里白纸黑字写着「⚠ 不能用 -DGGML_STATIC=ON」，
    我照着办，结果链接期报一串 ``undefined reference to `cudaEventRecord@libcudart.so.12` ``。
    翻老构建目录的 `CMakeCache.txt` 才发现 **`GGML_STATIC:BOOL=ON`——板上正在跑的
    生产二进制就是用 ON 编出来的**，那句注释与事实矛盾。
    机制：`ggml/src/ggml-cuda/CMakeLists.txt` 按 `GGML_STATIC` 分叉，
    ON 走 `CUDA::cudart_static`、OFF 走 `CUDA::cudart`；交叉编译时后者找不到 aarch64 的
    `libcudart.so.12` 符号。而单开 ON 又会因为全局 `-static` 把非 PIC 的 `libc.a` 往 `.so` 里塞，
    报 `R_AARCH64_ADR_PREL_PG_HI21 against __stack_chk_guard`——所以要配一个 patch 把那行注释掉。
    老树里那个 patch 一直躺在**未提交的工作区改动**里（`git status` 显示 `M ggml/src/CMakeLists.txt`），
    没进任何脚本，也没进文档，全靠那棵树还在。
    → **三条教训**：① **判据以 `CMakeCache.txt` / 产物的 `readelf -d` 为准，不以注释为准**
    （产物 NEEDED 里没有 libcudart、只有 libcuda.so.1，一眼就能看出是静态链的）；
    ② **构建期的关键改动必须落进脚本**，躺在工作区的 patch 等于没有，换台机器就丢；
    ③ 复现旧构建时，先把老 `CMakeCache.txt` 里 `GGML_*` / `CMAKE_CUDA*` 抄一遍再动手。
    现已修正 `2-build-llama.sh` 的注释，patch 写进 `4-build-dflash2.sh` 并带回读校验。

66. **★ 没有 RTC 的板子上，`systemd-timesyncd` 是 enabled 也可能永远同步不上**
    （2026-08-19 发现，板子已经错了整整 19 小时没人知道）：连板子准备下载模型，
    第一个 HTTPS 请求就报 `certificate is not yet valid`——**系统时间停在三个月前的 5 月 17 日**，
    而板子当天 01:01 才开机。根因不是网络：出网规则（uid 101 → 表 100）都在，
    `is-enabled` 也是 `enabled`。是**启动顺序**：`systemd-timesyncd.service` 带
    `DefaultDependencies=no` + `Before=sysinit.target`，**它在网络起来、在 `iecu-egress`
    装好出网路由之前就跑了**，那一刻根本出不去网，之后再没同步成功。
    → 解法是加一个守卫（**加法，不动厂商 unit**）：`iecu-timesync.service` +
    `.timer`（`deploy/systemd/`、`deploy/net/timesync-guard.sh`），
    `After=network-online.target iecu-egress.service`，开机 90 秒跑一次、之后每 15 分钟复查；
    先重启 timesyncd 等 60 秒，仍不同步就走 **SNTP 直连兜底**（`deploy/net/sntp-set.js`，
    UDP/123 手写 NTP 包 + `date -s`）。
    **为什么兜底必须是 UDP 而不是 HTTPS 取 Date 头**：时间错的时候 HTTPS 本身就连不上
    （证书尚未生效），那是个死锁；UDP/123 不涉及证书，是时间错乱时唯一还能用的校时通道。
    两条路径都实测过：故意把时间调回 90 天，路径一 2 秒恢复、路径二直接纠正 7776006 秒偏差，
    推理服务与面板不受时间跳变影响。
    ⚠ **守卫 unit 绝不能写 `RemainAfterExit=yes`**（陷阱 57）：写了定时器每次触发都是空操作。
    判据是 `systemctl list-timers` 的 NEXT 必须是真时间而不是 `n/a`。
    ⚠ **这块板（<BOARD_LAN_IP>）还没装这套**，下次它上电时补上。

67. **★ 换了模型，面板上一半的数还是上一个模型的——"显示了别的模型的数"比"没有数"更危险**
    （2026-08-19，用户报「跑 27B 时推理速度、累计用量、图表很多都没数值」，查下来是五个各自独立的 bug）：
    - **累计输入/累计生成/最长输入恒为 0**：三处读的是 `rt.totals`（本次服务运行以来，
      llama-server 一重启就归零），而同一张卡其余字段读的是 `rt.lifetime`。
      于是出现「累计计算 10011 秒、累计生成 0 tokens」这种自相矛盾的一屏。
    - **「生成速度」空闲时显示 36.5 tok/s**，而 27B 实测只有 10~12——它回退到了
      `lifetime.genTps`，那是**跨模型**的终身平均，绝大部分来自 Qwen3.6 时代。
    - **「生成峰值 44.0」同理**：峰值全局存一份，不分模型。
    - **每 token 的 KV 字节数写死 18 KiB**：那是对 Qwen3.6-35B-A3B 量的，
      而 27B 是另一族混合架构（`qwen35`，65 层里只有 16 层有 KV），套用算出的 GB 数是错的。
    - **模型下拉里根本没有正在跑的模型**：`MODEL_DIRS` 只扫 `/opt/m/llm` 与 `/opt/m0/llm`，
      27B 在 `/opt/update/llm`。select 于是落到列表第一项，**显示 Qwen3.6 而右侧运行值写着
      qwen3.8-27b**；这时点「保存」会把模型悄悄改掉。顺带：新下的草稿模型（DFlash2/DSpark）
      也会以"对话模型"身份混进这个下拉，选中就起不来。
    → 已做的修法（`deploy/panel/server.js` + `panel-ui/src/App.jsx`）：
    ① 速度与峰值**按模型文件名分桶**（`LIFE.byModel`，随 `panel-stats.json` 持久化），
       机器级的温度/CPU/内存水位仍全局；② 每 token KV 字节数改为按模型查表 + config 可覆盖，
       **查不到就返回 null、界面显示"—"**——宁可空着也不要拿另一个模型的系数算；
       ③ `MODEL_DIRS` 补上 `/opt/update/llm`，模型列表加 `kind` 字段（chat/draft/mmproj/embed）；
       ④ 当前配置的模型不在扫描目录时，把它作为一个选项补进下拉并选中。
    → **可迁移的判断**：**面板上每一个数，都要能回答"它是哪个模型、哪一段时间的"**。
    跨模型累计的量（总用量）和模型自身的量（速度、峰值、KV 系数）必须分开存、分开显示。
    这与陷阱 52 同族：**一个和眼前事实打架的数字，比空白更有破坏力**——空白只是没信息，
    错的数字会让人照着它做决定。

68. **★★ 一次拥塞崩溃，两个错误结论，一条真根因——排查顺序错了就会一路查偏**
    （2026-08-21，用户报「板子被重试请求拉爆，面板显示 162K 上下文但我只开了 128K」）：

    **先说结论层级，这一条的价值全在这里：**

    | 层 | 现象 | 是不是根因 |
    |---|---|---|
    | 表层 | 面板报上下文 162K > 实开 128K | ❌ **面板算错了**，物理上不可能超 |
    | 中层 | 请求排队、队尾等 31 分钟、客户端全超时 | ❌ 次生，是被诱发的 |
    | **根因** | **调用方误把 `-nothink` 覆盖成思考版**，单条 15 秒 → 150~190 秒 | ✅ |

    **① 面板的 162K 是重复计算，不是真的超了。** `ctx` 原来算的是
    `n_prompt_tokens + n_decoded`，但 b10498 里 `n_prompt_tokens` 的语义是
    **slot 上下文当前总量、已含生成部分**，相加等于把生成量数两遍。
    实测 60 秒采样：`n_prompt_tokens` 4422→6871、`n_decoded` 476→2922，两个增量
    2449 与 2446 同步；`4422-476=3946` 正是调用方的原始 prompt 长度。
    峰值一度记到 **258035**，而 `n_ctx` 只有 131072——**KV 池是启动时按 n_ctx 预分配死的，
    物理上装不下第 131073 个 token**。llama.cpp 自己的计数器 `llamacpp:n_tokens_max`
    历史峰值 131071 = n_ctx-1，顶格但没越界，这才是真实值。
    这个错数字让用户判断"上下文被撑爆"、让调用方改了重试逻辑，**两边各白查一轮**。
    → 已修：只取 `n_prompt_tokens` 并按 `n_ctx` 封顶，`kv[].used` 那一处也有同一份错。

    **② 三层都没有拦截，所以队列能无限长。** 面板代理层无并发上限、无请求超时、
    无请求体大小上限；`--parallel 1` 是**槽位数不是限流**，llama.cpp 对超出的请求
    既不返回 429 也不拒绝，**无限期排队**；调用方超时后**不关 TCP 连接**，
    面板的"客户端断开就取消上游"因此完全失效（判据：`LIFE.llm.aborted` 跨重启累计恒为 0，
    历史上一次 499 都没有）。三者叠加 → 队列只增不减 → 正反馈。
    铁证：NewAPI 日志里 9 条请求发起时间横跨 18:52~19:27 共 35 分钟，一条都没被处理，
    直到板子重启才一起返回 502；同期成功的请求 `use_time` 到了 **1860 秒**。
    → 已加三道闸（`deploy/panel/server.js`，常量 `CHAT_GATE` / `CHAT_TIMEOUT_MS` /
    `MAX_BODY_BYTES`）：并发 3（超出 10ms 内 429 + Retry-After）、超时 900 秒、体积 60 MB。
    另加服务端 `--predict 16384`（四份配置都改了），堵掉"不传 max_tokens 就能一路生成到
    吃满 128K"这个洞——`--predict` 默认是 **-1 无限**，`--context-shift` 默认 disabled。

    **③ 但以上都不是根因。** 调用方跑批时用 `--model` 覆盖，把配置里的
    `qwen3.6-35b-a3b-nothink` 覆盖成了 `qwen3.6-35b-a3b`，等于**把思考打开了**。
    同一批对照：思考版 150~190 秒/条、失败 1/2；nothink 13.7~17.1 秒/条、失败 0/2。
    **单条服务时间差 10 倍，队列的一切代价都按这个倍数放大。**
    单条 15 秒时并发 2 的队尾只等 15 秒，整条链根本不会触发。

    → **可迁移的判断（这条最值钱）**：
    **看到"排队/拥塞"，不要停在"限流没做"，要再往上追一层问"单条为什么这么慢"。**
    当时的数摆在眼前——3900 token 输入、4000 token 输出，按 40 tok/s 该是 100 秒出头，
    实际 150~190——**这个缺口我看见了却没去算**，多出来的正是几千个 reasoning token。
    限流是必须补的防线，但补完防线不等于找到了病。
    与陷阱 64 同族：**别把"指标变好"当成"问题解决"**。

    → 附带三条小的：
    - **判断"是不是降速"要看当下采样，不要看端到端耗时**。当时生成速度实测
      34~51 tok/s 完全正常（MTP 档标称 33），耗时全花在排队和思考上。
    - **★ 单 slot 上并发是赚是亏，取决于调用方怎么排任务，不取决于并发数本身**
      （这条当天被实测推翻过一次，值得单独记）。单 slot 只保留最后一次的 prompt 缓存，
      所以：**同类请求连续排 → 第二条命中的正是同一份 system 前缀，并发无损**，
      还能填住网络往返和客户端解析的空档；**不同类请求交替排 → 互相顶掉缓存，并发净亏**。
      实测两组：交替取样时 `cached_tokens` 3418→1；生产跑批按业务线连续排时，
      前 20 条中位数 3418、19/20 命中 >3000，201 条里只有跨线交界处冲刷了一次。
      → 我先前拿交替取样那组数据得出"并发 2 是净亏"，**结论下早了**——
      那是测试取样的产物，不是生产形态。
      **纪律是双向的：给数据的一方要说清采集条件，收数据的一方要问清采集条件。**
      当时那组数字送过来时没有任何标记能分辨它是 `--limit=2` 试跑还是生产跑批，
      而我也没问——**跨系统协作时，一个没标注工况的数字和一个错数字等价**。
    - **两种"空响应"要分清**：`max_tokens` 给小了会让 token 全烧在思考上、
      JSON 能解析但 `content` 是空串；而整个响应体为空、`json()` 直接抛异常，
      那是链路问题（实测 NewAPI 日志里的
      `failed to copy response body: broken pipe` 就是下游先断了）。

69. **★ Git Bash 会把远程绝对路径改写成 Windows 路径，`push.js` 因此报 "No such file"**
    （2026-08-21）：`node push.js local.js /var/lib/llm/panel/server.js` 在 Git Bash 里
    执行时，MSYS 的路径转换把第二个参数变成了
    `C:/<USER>/scoop/apps/git/2.53.0.2/var/lib/llm/panel/server.js`，
    SFTP 报 `No such file`——**看起来像 SFTP 坏了**。当时为此查了 sftp-server 二进制、
    ldd 依赖、sshd Subsystem 配置、写权限、磁盘余量，还写了最小复现脚本
    （`sftp.open`/`write`/`createWriteStream` 三种都正常），全部无果，
    直到给新工具加了远程路径格式校验才把被改写的路径打印出来。
    → **修法：命令前加 `MSYS_NO_PATHCONV=1`。**
    ⚠ 但它是全局开关，**加了之后本地脚本路径也不再转换**——
    `node exec.js --file /tmp/x.sh` 会去找 `D:\tmp\x.sh` 然后报 `script file not found`。
    所以要么只在 `push.js` 那一条命令前临时加，要么本地脚本一律用 Windows 绝对路径。
    → **可迁移的判断**：**跨 shell 边界时，先确认程序实际收到的参数是什么，再怀疑程序本身。**
    这与 §四 的 shell 套娃是同一类问题——不是命令写错了，是中间层擅自改了它。

70. **★★ 重启面板之后查面板，天然看不到重启本身造成的影响——观测点和被观测事件在同一个进程里**
    （2026-08-21，我据此得出过一个错结论）：重启 `iecu-panel` 后立刻查 `/api/runtime`，
    看到 status=200、429 计数 0、队列健康，于是判定"重启没打断调用方"。
    **这个判断是错的**。调用方那边的实录是两条请求同时断：
    `RemoteDisconnected('Remote end closed connection without response')`，
    正是并发 2 的两条在途请求一起被切。
    → 看不到的原因不是观察不仔细，是 **`REQLOG` 只在面板进程内存里（120 条上限），
    进程重启把证据连同请求一起清了**。重启后查到的每一条，都是重启**之后**新进来的。
    → **重启 `iecu-panel` 的真实代价是「当时在途的全部请求」，调用方并发几就是几条**，
    不是"正在转发的那几条"。因为调用方走的入口就是 9000 面板本身。
    → **要评估重启影响，必须从调用方侧取数**，或者在重启前先把 REQLOG 落盘。
    → **可迁移的判断（比这个 bug 本身重要）**：
    **当观测工具和被观测对象是同一个进程时，那个进程的生死是观测盲区。**
    同族的还有：用面板查面板自己的内存、用 journald 查 journald 重启前的日志
    （陷阱 68 里 journal 是 volatile、重启即清，同一个道理）。
    判据很简单——**问一句"如果这件事发生了，记录它的东西还在吗"**。

71. **★ 跨系统协作时，一个没标注工况的数字和一个错数字等价**
    （2026-08-21，两个方向各栽一次）：
    - 我拿调用方 `--limit=2` 试跑的 `cached_tokens` 3418→1，得出"并发 2 是净亏"，
      推翻了用户已经定下的配置。实际生产跑批是 19/20 命中 3418，并发无损——
      那组数字是测试取样的产物，送来时没有任何标记能分辨。
    - 反过来，我把"重启后 status=200"当成"重启无影响"发给对方，
      没说明那是重启后新请求的数据。
    → **纪律是双向的：给数据的一方要说清采集条件，收数据的一方要问清采集条件。**
    自己能约束的永远是后一半——**收到一组决定性数字时，先问"这是什么工况下采的"**。
    → 与陷阱 64 同族：数字本身不会说谎，但脱离工况的数字会让人对着它做错决定。

72. **★★ 家里网上的 `<GATEWAY>1` 是一台 NVIDIA Shield TV，不是板子——这个坑我踩了两次**
    （2026-08-24 用户当场纠正，上一次也是同一个地址骗了我）：
    扫局域网找新板子时，`<GATEWAY>1` 同时满足两个特征——**MAC 的 OUI 属于 NVIDIA**；
    **9000 端口开着**，而 9000 正是 IECU 面板的端口。
    两个特征叠起来和板子的指纹几乎一模一样，于是我据此认定"找到板子了"。
    **它是 Shield TV。**
    → **可迁移的判断**：
    - **NVIDIA 的 OUI 不是板子的证据**。家里常见 Shield TV、显卡、Jetson 等一堆 NVIDIA 设备，
      OUI 只能说明芯片厂商，说明不了这是哪一类设备。
    - **端口开着不等于跑的是你以为的那个服务**。9000 是常用端口，Shield 上也有东西在听。
    - **判据必须是应用层的内容，不是 MAC + 端口的组合**。板子的面板一定能回
      `GET /api/runtime` 的 JSON（含 `units`、`llm` 等字段）；回不出这个的就不是板子。
      两块上一块板的固定地址是 `.15`（批次A）与 `.16`（这块板），**不在这两个地址上、
      又自称是板子的，先当成误报**。
    - **最快的证伪方式是查路由器的 DHCP 租约表**（只读，不碰配置）：
      `ssh <路由器管理用户>@<GATEWAY> 'cat /tmp/dhcp.leases'`
      —— 那张表里直接带主机名，设备 MAC、IP、主机名一眼就能分清。
      **家网里找任何一台设备，先查这张表，再去扫端口。**
    → 与陷阱 5/41 同族（"全否优先怀疑工具缺失"的反面）：
    **这次是"全对优先怀疑巧合"——特征越像，越要用一条独立判据去证伪。**

73. **★★ 判断内核支不支持某个设备，`find` 找 `.ko` 是错的判据——builtin 的驱动根本不在 `/lib/modules` 里**
    （2026-08-27 查 USB 网卡时，同一轮里这个模式踩了两次，方向相反）：
    - **第一次是假阴性**：`find /lib/modules -name '*.ko*' | grep -iE 'usb|net' | head -60`——
      管道末尾那个 `head -60` 正好把 `kernel/drivers/net/usb/` 那八行截掉，
      于是"板上没有 usbnet 驱动"。实际八个模块文件全在，`modprobe` 六个全部加载成功。
    - **第二次是同一个模式的另一种表现**：`usb-storage` 用 `find` 同样找不到 `.ko`，
      因为它**编在内核里**——`modules.builtin` 有登记、启动日志有
      `usbcore: registered new interface driver usb-storage`、
      `/sys/bus/usb/drivers/usb-storage` 存在，`scsi_mod`、`sd_mod` 同理。
      只查 `.ko` 会把这类驱动全部误判成"不支持"。
    → **正确判据是四条一起看，缺一条都可能得出反的结论**：
      ① `find /lib/modules -name '*.ko'`（模块文件，**别加 head**）；
      ② `grep <名> /lib/modules/$(uname -r)/modules.builtin`（编进内核的）；
      ③ `grep -w <probe符号> /proc/kallsyms`（最硬，builtin 的符号一定在）；
      ④ `journalctl -k | grep 'registered new interface driver'`（启动时实际注册了谁）。
    → **另一条**：`modinfo` 报出 `filename:` 路径**不等于文件存在**——它可能从
      `modules.dep`／`modules.alias` 推出路径。要么 `test -f` 确认，要么看它是否输出 `(builtin)`。
    → **还有一条给采集脚本的**：**给 `find`/`grep` 管道加 `head` 是在制造假阴性。**
      要限长就先落文件再看，或者先 `wc -l` 确认总量。
      这与陷阱 5（strings 全报 no 其实是没装 binutils）、陷阱 41（command -v 返回空
      其实只缺一个可执行文件）是同一族：**"没找到"要先怀疑找法，再怀疑东西不存在。**

74. **★★ GGUF 是容器不是标准——同一个模型给 sd.cpp / llama.cpp / ComfyUI 打的包互不通用**
    （2026-09-02 上 MiniMax-H3 时连栽两次，一次在编码器一次在 DiT）：
    从 `unsloth/MiniMax-H3-GGUF` 下的编码器，**大小与源站精确一致（13102161024 字节）、
    张量表能完整解析出 902 个张量**，ComfyUI 却报
    `This gguf file is incompatible with llama.cpp!`。
    → 判定只有三行（`ComfyUI-GGUF/loader.py:98`）：
    ```python
    arch_str = get_field(reader, "general.architecture", str)
    if arch_str in [None, "pig", "cow"]:
        if is_text_model: raise ValueError("This gguf file is incompatible with llama.cpp!")
    ```
    那个文件 **`metadata_kv_count = 0`**，一个 metadata 键都没有。
    ⚠ **报错文本有误导性**：抛错的是 ComfyUI-GGUF 不是 llama.cpp。
    → 更深一层是**张量命名风格**，三种打包目标各不相同：

    | 打包目标 | metadata | 张量命名 | 视觉塔 |
    |---|---|---|---|
    | stable-diffusion.cpp | 常被剥空 | HF 原始（`model.layers.*`）| 与语言层同文件 |
    | llama.cpp | 齐全 | `blk.*` / `token_embd.weight` | **拆成独立 mmproj** |
    | ComfyUI | 齐全 | HF 原始 | 同文件 |

    llama.cpp 那种对 ComfyUI 也没用——`CLIPLoader` 只有一个文件输入口，配不上独立 mmproj。
    → **判据不用下整个文件**：GGUF 的 metadata 与张量表都在文件头，
    `Range: bytes=0-50331647`（前 48 MB）就能读全。工具已固化：
    **`deploy/comfyui/tools/gguf-probe-remote.js`**，会自动区分「文本编码器」与「扩散模型」
    并查对应白名单。**下大模型之前先探头**——十几秒省掉十几分钟下载和一轮失败实测。

75. **★★ ComfyUI 核心原生支持某个模型 ≠ 配套的量化插件也支持，两者是不同仓库、不同节奏**
    （同一天，DiT 上的第二次栽跟头）：ComfyUI 核心 2026-08-03 就有 `comfy/ldm/minimax/`
    与全套 H3 节点（day-0 支持），而 **ComfyUI-GGUF 至今没适配**——
    `loader.py` 第 12~14 行两张白名单是写死的：
    ```python
    IMG_ARCH_LIST = {"flux","sd1","sdxl","sd3","aura","hidream","cosmos","ltxv","hyvid","wan","lumina2","qwen_image"}
    TXT_ARCH_LIST = {"t5","t5encoder","llama","qwen2vl","qwen3","qwen3vl","gemma3"}
    ```
    **没有 minimax**，`tools/convert.py` 的 `detect_arch` 兜底规则里也没有。
    ⚠ **升级插件解决不了**：板上装的 `6ea2651e`(2026-01-12) 就是 city96 仓库的最新提交。
    → 社区的绕法是**把 DiT 的 arch 标成白名单里已有的名字**（H3 借 `wan`）。
    选包时这一个字段决定成败：Abiray 版标 `wan` 能用，ChrisColeTech 版标 `ltx2`（白名单里是
    `ltxv`）就用不了，**差一个字母**。
    → **可迁移**：遇到「核心支持了但跑不起来」，先分清是核心的事还是周边插件的事，
    再去查那个插件有没有跟上——不要默认它们同步。

76. **★★ `--disable-smart-memory` 不会在换模型时自动卸载上一个，要在工作流里显式卸**
    （2026-09-02，我先前读代码推断错了一次）：
    我据 `comfy/model_management.py:882` 那段
    （`DISABLE_SMART_MEMORY` 为真时 `memory_to_free = 1e32`）推断它会积极卸载，
    **实测证伪**：H3 编码器 9.59 GB 编码完一直挂着，DiT 加载时直接叠到 26.7 GB 被内核杀。
    → 解法是在工作流里插 **KJNodes 的 `VRAM_Debug`**（`unload_all_models=true`），
    放在 conditioning 路径上、编码器用完之后。实测 used 从 26.7 GB 掉到 14.4 GB，
    日志出现 `VRAMdebug: free memory before/after`。
    ⚠ **但同一个节点卸得掉编码器、卸不掉 DiT**（2026-09-02 实测 + 源码定位）：
    插在采样器输出后想卸 DiT 时，节点执行了却 `freed memory` 是负数，
    系统内存 `used` 全程只增不减（24.86 GB → 加载两个 VAE 后 29.05 GB，
    若 DiT 真被卸掉应先降到 13.5 GB）。
    → **根因是三个 offload 目标函数的判据不一样**（`model_management.py`）：
    ```python
    def unet_offload_device():          # 1076
        if vram_state == VRAMState.HIGH_VRAM:   # ← 看 --highvram
            return get_torch_device()            #   目标 = GPU 自己 = 原地不动
        else: return torch.device("cpu")
    def text_encoder_offload_device():   # 1183
        if args.gpu_only:                        # ← 只看 --gpu-only（我们没开）
            return get_torch_device()
        else: return torch.device("cpu")         #   目标 = CPU，卸得掉
    def vae_offload_device(): ...        # 1252，判据同编码器
    ```
    我们开着 `--highvram`，于是 **UNet 的卸载目标被设成 GPU 本身**，
    而编码器与 VAE 的目标是 CPU。同一个 `VRAM_Debug`，一个有效一个无效，
    差别在这里，**不是「引用没断」**（那是我最初的错误解释）。
    → **【C 档 · 想推进要做的】**：去掉 `--highvram` 跑一次，看 DiT 能否卸掉。
    ⚠ 但这与 **A-124「必须配 --highvram」** 直接冲突——那条是拿 Z-Image
    这种**单模型**测的（默认策略算错账第一张就 OOM），而 H3 是**多阶段流水线**，
    两者的最优解未必相同。**改之前先想清楚要不要给两种场景分别设启动参数**
    （生图一档、生视频一档），别直接推翻 A-124。
    → **三条可迁移**：① 串联多个大模型时，每个交接点都要想清楚上一个模型何时走；
    ② **同一个"卸载"动作对不同类型的模型行为可能完全不同**，别假设一致；
    ③ 读代码得出的结论仍然是推断——我这次连着栽两次，
    先是「读对 `memory_to_free=1e32` 却理解错它管的范围」，
    后是「把卸不掉解释成引用未断」，**两次都是实测数据先摆在那里，我却去猜机制**。

即使验证了也有没拆到底的黑箱，这些必须当推断对待，不能写死。** 详见 `references/evidence-levels.md` 的三档分级。

**第二条硬规矩（2026-08-13 加）：不要把"我没试过"写成"这不行"。** 本轮 ComfyUI 差点
因为这个模式被放弃两次——先是"板上没 Python"（其实只缺一个可执行文件），
再是"最新版要 py3.9+"（其实只有 1 个文件真不兼容）。**能力边界那一节的 C 档就是为此设的，
写文档时宁可写"没探测过 + 想推进要做什么"，也别写成否定结论堵死后路。**

---


## 🔴 红线（违反可能失联或变砖）

1. **绝不执行 `/app/shutdown_service.sh kill`**：会 `echo 1 > .../trigger_sys_shutdown` 触发 **Hypervisor 整机关机**，而电源时序归 Aurix，**没有远程上电手段**。
2. **绝不对 `/dev/vblkdev*` 写**：唯一能从 SSH 造成不可逆损坏的路径。读安全。
3. **别停 `nv_*` 平台服务**（`nv_fsicom_daemon`、`nv_tzvault_daemon@*`、`nv_virtual_shutdown`）：可能触发功能安全复位（**此条是推断，未实测，但不值得试**）。
4. **别改 `/etc/fstab`、`/etc/systemd/scripts/tn_eth_init.sh`** 等厂商启动脚本：**没有串口线，失去 SSH 就失去唯一入口**。改网络请新建独立 unit（已有 `iecu-lan-ip.service` 作范例）。
5. **没有 Aurix 串口 pinout + DRIVE OS SDK 之前，别碰刷机 / recovery / 重刷 PCT**。
   *2026-08-10 修正*：签名镜像这一样**板上自带**（`/opt/update/package` 有原厂 A/B OTA 全套，已备份到 `<你的备份根>\opt-update`），但仍缺串口和 `bootburn.py`。**这批文件绝对不能删。**
6. **别照搬 Jetson 改 `carveout`/`cma=`/extlinux**：`/boot` 是空的，设备树由 Hypervisor 注入。
7. **往板上放东西认准两个位置**：二进制只能放 `/var/lib/llm/`（唯一可写+可执行的持久位置），大文件放 `/opt/m/`（28 GB）。`/opt/*` 全是 **noexec**，`/` 和 `/app` 是 **ro**，`/tmp` 是 **ramfs**（占物理内存）。
8. **停智驾栈用 `systemctl stop application_start`，不要用 `pkill`**：前者走 cgroup 正常停止，后者会让 service 留在 failed 状态。两者都不碰 shutdown_service.sh（该 unit 无 ExecStop）。
9. **别换网口**：Tegra 侧只有一个 MII 接口连板载交换芯片 88Q6113，换插万兆口**不会提速**，只会赌那个口是否承载 VLAN 254——赌输就失联。
10. **改网络只做加法**（2026-08-12 新增）：可以加地址、加独立路由表、加 `ip rule`；**不要改主路由表那条 `default via 172.31.8.18`，不要动 `fwmark 0x12c → table 123`，不要删 `172.31.254.38`**。那个 172 地址是插网线直连时的救命入口，是唯一不依赖任何配置的通路。现有的加法都收在 `iecu-egress.service` 里，`ExecStop` 只撤自己加的东西。
11. **别把板子的 SSH 转发到公网**：root + 密码 `nvidia`，几小时就会被爆破。要从外面进，走 LXC 跳板或 frps 隧道（都只在内网/隧道内暴露 22 端口）。
12. **别占用 `/dev/vblkdev51` 那 4 GB**（2026-08-13 新增）：它未挂载、看着是空闲分区，实为 **`/app` 的 A/B 备份槽**——只读挂载后确认内容与 `/app` 同构（`application_start.sh`、`shutdown_service.sh`、`m/` 智驾 SDK，12673 个文件），且被 `/app/bin/CpApFOTA` 引用，是固件升级与回滚机制的一半。**格式化或写入它可能让 FOTA 回滚失效。**

破坏性操作前遵循用户级 CLAUDE.md §六。



## 连接方式（本机工具受限）

本机没有 sshpass / plink / python 时，用 Node.js + ssh2（`exec.js` 等脚本已备好）。密码认证自动化一律走脚本文件。

```powershell
cd .claude\skills\iecu\scripts ; npm install     # 首次装 ssh2
$n = "node.exe"

& $n exec.js "<命令>" [超时秒]                    # 实时流式输出
& $n exec.js --file <本地脚本.sh> [超时秒]        # 喂给远端 bash -s，零引号套娃 ★推荐
& $n push.js <本地文件> <远程路径> [--resume]     # SFTP 整传+传后校验；--resume 仅用于大文件断点续传
& $n pull.js <远程目录> <本地目录> [--exclude X] [--max-size N]   # 只读下载
& $n probe.js <cmdset.json> <out.json>           # 批量采集
& $n thermal-monitor.js <out.csv> 5              # 温度采样
```

- 目标默认 `172.31.254.38`（直连救命地址，root/nvidia 出厂弱口令），用 `IECU_HOST/IECU_PORT/IECU_USER/IECU_PASS` 覆盖。
- **板上没有 `curl`**（也没有 binutils）。要在板上发 HTTP 请求，用 `/var/lib/llm/bin/node` 写几行脚本，别指望 curl/wget。
- **板子已能全局出网**（2026-08-14 起，A-130）：root 直接可下载/pip/git。但**装依赖仍优先在 PC 上准备好推板**（可复现、可存档），在线安装只用于验证与临时探测。
- **凡是带引号/变量/管道的命令，一律用 `exec.js --file`**。PowerShell 会展开 `$var` 和 `$(...)`，直接传字符串必踩坑。
- 大文件下载用 `aria2c -x 8 -c`；HuggingFace 慢时用 ModelScope 镜像。

---

## 文件索引

| 我要… | 看这里 |
|---|---|
| **跑/改 LLM 服务、换模型、交叉编译** | **`references/llm-deploy.md`** ★ 系统建成后的主文档 |
| 判断某条结论能不能信 | `references/evidence-levels.md`（三档证据分级）|
| 查硬件/系统的分领域事实 | `references/findings.md` |
| 写新的采集命令集 | `references/probe-recipes.md` |
| 传文件 / 远程执行 / 采集 | `scripts/`（exec/push/pull/probe/dump/thermal-monitor，支持 `IECU_PORT`）|
| 部署产物与构建脚本 | `../../deploy/`：先看 `deploy/README.md`（总装文档 + 复制到另一块板子的步骤）。`panel/`（后端+产物）`panel-ui/`（前端源码）`comfyui/`（生图）`config/`（运行配置模板）`edge/`（外网入口+frps）`llama/` `net/` `systemd/` `build/` |
| **导入任意 ComfyUI 工作流 / 缺节点缺模型 / 找 LoRA** | **`../comfyui-import/SKILL.md`** ★ 独立 skill，只管把一张工作流适配进来（体检→改写→转格式→真跑→归档），工具在 `deploy/comfyui/tools/` |
| **生图环境的维护**（装节点包 / 换 torch / 加模型类别） | 本 skill + `deploy/torch-py313/`（现役）；装节点包用对应脚本，别点面板里 Manager 的 install——它走 pip 无约束，会把自编 torch 顶掉 |
| 改面板前端 | `../../deploy/panel-ui/`，`pwsh -File build.ps1`。node_modules 不进同步目录 |

---