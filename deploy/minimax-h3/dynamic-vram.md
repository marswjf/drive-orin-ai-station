# DynamicVRAM 攻坚记录（2026-09-02）

目标：突破 MiniMax-H3 的 22 帧（0.92 秒）上限，做出 7~10 秒的视频。

结论先写在前面：**板子从 2026-08-16 升级到 ComfyUI 0.33.0 那天起，就一直用着一套
被自己关掉的内存管理系统**。`comfy-aimdo 0.4.13` 一直装着，从未生效过。

---

## 一、`--highvram` 一票否决了 DynamicVRAM

`comfy/cli_args.py:312`：

```python
def enables_dynamic_vram():
    if args.enable_dynamic_vram:
        return True
    return (not args.disable_dynamic_vram and not args.highvram
            and not args.gpu_only and not args.novram and not args.cpu)
```

`main.py` 据此决定是否调用 `comfy_aimdo.control.init()`。我们的启动参数带 `--highvram`，
于是这个分支从来没进去过——启动日志里既没有 `DynamicVRAM support detected and enabled`，
也没有对应的 warning，**整段代码是被跳过的，不是失败的**。

这条决定了后面所有事情：`unet_offload_device()`（`model_management.py:1076`）在
`vram_state == HIGH_VRAM` 时返回 GPU 自己，所以 DiT 的"卸载"原地不动，
73 帧才会在解码阶段没有内存可用。**根因不是"卸载写错了"，是"新的内存管理器没开"。**

## 二、去掉 `--highvram` 之后起不来：static TLS

去掉参数直接重启，ComfyUI 反复启动失败，13 次都是同一条：

```
ImportError: /var/lib/llm/comfyui313/venv/lib/python3.13/site-packages/torch/lib/libc10.so:
cannot allocate memory in static TLS block
```

⚠ **这条报错和内存余量无关**——发生时 `used` 只有 4.3 GB。排查时先后排除了：
mount 叠加（`mount | grep -c comfyui313` = 1，`mount-stack313.sh` 确实幂等）、
偶发（连续 13 次）、systemd 环境差异（手工启动同样复现）。

判据是这组对照：

| 启动方式 | 参数 | 结果 |
|---|---|---|
| 手工 | 带 `--highvram` | ✅ 起得来 |
| 手工 | 不带 `--highvram` | ✗ static TLS |
| systemd | 不带 `--highvram` | ✗ static TLS |

机制：`main.py:58` 无条件 `import comfy_aimdo.control`，但 `init()` 只在
DynamicVRAM 启用时调用。aimdo 的 C 扩展用 initial-exec TLS 模型，`init()` 会吃掉
glibc 的 static TLS 余量；板子是 Ubuntu focal / **glibc 2.31**，surplus 是编译期固定值，
而且 2.31 **还没有** `glibc.rtld.optional_static_tls` 这个 tunable
（2.32 之后才有，本板实测设了无效）。于是随后 `import torch` 时 libc10.so 申请不到。

**解法**：让 torch 先于 aimdo 拿到额度。放一个 `sitecustomize.py` 到 venv 的
site-packages，解释器启动时自动 import，时机早于 `main.py` 的任何一行，
**不必改 ComfyUI 源码，升级 ComfyUI 也不会冲掉**。
正本 `deploy/torch-py313/sitecustomize.py`，装法 `install-sitecustomize.sh`。

> 这一层是这次能推进的关键。不知道它的人会得出"去掉 `--highvram` 就起不来"的结论，
> 从而永远用不上 DynamicVRAM。社区 issue #15285（Jetson 用户要求保留
> `--disable-dynamic-vram`）里描述的"prevent boot or cause crashes during model loading"，
> 很可能就是同一个坑——他们的对策是关掉 DynamicVRAM，我们的对策是修好 TLS。

## 三、aimdo 对统一内存的记账是对的

这是本轮最需要先回答的问题（由另一会话 `iecu3-1-f5` 提出，它的区分很关键）：

| | 内容 | 性质 |
|---|---|---|
| **A-118** | 统一内存下 offload 省不出一个字节 | **物理事实**，换什么内存管理器都不变 |
| **A-124** | 所以必须 `--highvram` | **策略结论**，前提是"ComfyUI 按独立显存假设记账因而算错" |

所以真正要验的是：**aimdo 有没有针对统一内存改记账**。日志给了答案：

```
aimdo: control.c:254:INFO:comfy-aimdo integrated Linux GPU RAM headroom: 2048 MB
aimdo: control.c:276:INFO:comfy-aimdo inited for GPU: Orin (VRAM: 29415 MB)
```

它认出了 Orin，把 **29415 MB 整体**当作共享池（而不是"显存 X + 另有一块系统 RAM"），
留 2048 MB headroom。**记账方式对统一内存是成立的**，
所以 A-124 的前提在 DynamicVRAM 路径下不再成立。A-118 不受影响，它仍然是对的。

## 四、DiT 释放：从无效变成有效

同一个 `VRAM_Debug(unload_all_models=true)` 节点（工作流节点 204，位置没动过）：

| 路径 | 采样后卸 DiT | 结论 |
|---|---|---|
| `--highvram`（legacy） | `freed memory` 为负数，`used` 只增不减 | 无效 |
| DynamicVRAM | free memory 3,141,912,576 → 16,757,555,200，**freed 13,615,642,624（12.68 GiB）** | ✅ 有效 |

解码阶段的可用内存因此从 1.87 GiB 变成 15.61 GiB。

⚠ 但**自动 eviction 仍然不会发生**，必须靠工作流里这个显式节点。
机制见 ComfyUI issue #15453 的评论（`model_management.py:882-889`）：

```python
if current_loaded_models[i].model.is_dynamic() and for_dynamic:
    # don't actually unload dynamic models for the sake of other dynamic models
    # as that works on-demand.
    memory_to_free = 0
```

VAE 解码时模型集合只有 `[vae.patcher]`，DynamicVRAM 下它是 `ModelPatcherDynamic`，
于是 `free_for_dynamic` 为真，为它腾地方的 eviction 被整段短路，
日志里就是那句 `0 models unloaded`。**显式 `unload_all_models()` 不受这条短路影响。**

→ 所以工作流里 `VRAM_Debug` 那两个节点不是调优，是必需件。这一点没有变，
但它们**只有在 DynamicVRAM 路径下才真正起作用**。

## 五、分块解码这条路是死的（源码确认）

`comfy/sd.py:992`，MiniMax H3 video VAE 分支里：

```python
# the model tiles internally (256px spatial, 17-frame temporal chunks)
self.handles_tiling = True
# one decoded temporal chunk (with overlap) is all that ever sits in VRAM
```

**VAE 解码的峰值与总帧数无关**，模型自己就在按 17 帧一块流式解码。
`MiniMaxH3VideoVAE.decode_tiled()` 内部直接 `return self.decode(z)`，
所以 ComfyUI 那句 "retrying with tiled VAE decoding" 是重跑同一段代码、同样失败。

→ **`VAEDecodeTiled` / `VAEDecodeLoopKJ` 对 H3 无意义**，
README 待办 3 里"改用分块解码"那条到此作废，不必再试。

## 六、实测数据

| 帧数 | 时长 | 参数 | 跑前 used | 结果 | 耗时 | 峰值 used | 最低 avail |
|---|---|---|---|---|---|---|---|
| 22 | 0.92 s | `--highvram --disable-smart-memory`（原） | — | ✅ | 230.8 s | 27.5 GiB | — |
| 22 | 0.92 s | DynamicVRAM | — | ✅ | **239.0 / 240.3 s** | — | — |
| 73 | 3.04 s | DynamicVRAM | — | ✗ OOM | — | 28.56 GiB | 0.17 GiB |
| 73 | 3.04 s | DynamicVRAM + `--disable-pinned-memory` | 14.0 GB | ✅ | **306.4 s** | 27.56 GiB | 1.16 GiB |
| 158 | 6.58 s | 同上 | **12.0 GB（脏）** | ✗ OOM | — | 28.69 GiB | 0.04 GiB |
| **243** | **10.13 s** | 同上 | **7.7 GB（干净）** | ✅ | **510.6 s** | 28.37 GiB | 0.36 GiB |

产物实测（`mvhd` 解析）：`MiniMax_H3_00006_.mp4` **10.13 秒 / 874 KB /
`vide`+`soun` 双轨 / avc1 + mp4a**。**从 0.92 秒到 10.13 秒，11 倍。**

### ⚠ 决定成败的不是帧数，是起步内存

158 帧失败而 243 帧成功，这个反直觉的结果只有一个解释——**两次的起步内存差了 4.3 GB**：

| | 跑前 used | 卸编码器 freed | DiT usable | 结果 |
|---|---|---|---|---|
| 158 帧 | 11972 MB（接着 73 帧那次跑的，进程有残留） | 1.18 GiB | 7039 MB | ✗ |
| 243 帧 | 7652 MB（158 帧 OOM 后 ComfyUI 刚重启，干净） | 0.44 GiB | 8020 MB | ✅ |

→ **跑长视频前必须先 `systemctl restart comfyui`**。
这与生图基准 `deploy/comfyui/workflows/bench/README.md` 的守则 4 是同一条，
在视频侧同样成立、而且更致命——生图重跑一次只损失 30 秒，
长视频跑到 8 分钟才被杀，代价大得多。

22 帧慢了 3.5%，换来解码阶段多出 13.7 GiB 可用内存——这笔交易很划算。

**耗时结构很关键**：73 帧只比 22 帧慢 28%（306 vs 239 秒），而时长是 3.3 倍。
因为大头是约 150 秒的固定开销（编码器 60 s + DiT 80 s 加载），采样本身增长有限。
→ **加帧数的边际成本很低**，这也是为什么值得一路往 243 帧推。

### `--disable-pinned-memory`：第二把钥匙

同为 73 帧的两次对照，只差这一个参数：

| | DiT usable | DiT offloaded | 采样后 freed | 结果 |
|---|---|---|---|---|
| 带 pinned | 8206 MB | 3338 MB | — | OOM 被杀 |
| **不带 pinned** | **10343 MB** | **1081 MB** | **14.98 GiB** | ✅ 306.4 s |

多出 2.1 GB 可用内存，offload 量降到不足三分之一。
`Mlocked` 峰值实测 0 —— 这不是"pinned 白占了内存"那么简单：
**pinned host buffer 本身就是那块统一内存**，`pinned_hostbuf_size()` 还要 `× 2`
（`model_management.py:1595`），于是同一份权重在同一块物理内存里存了两遍。

⚠ 注意 pinned 只在**真的发生 offload 时**才分配。所以在原来的 `--highvram` 档上
加 `--disable-pinned-memory` 是没有意义的（那时压根不 offload，`Mlocked` 恒为 0）——
**它是 DynamicVRAM 的配套件，不是独立的优化项**。

---

（下面是加 `--disable-pinned-memory` 之前的失败分析，保留作推导过程）

73 帧的失败点**不在解码，在加载 DiT**：

```
编码器 loaded completely; 9578.44 MB loaded
VRAMdebug: freed memory: 3,299,476,992     ← 卸编码器只放出 3.07 GiB
Requested to load MiniMaxH3
loaded partially; 8206.50 MB usable, 7983.94 MB loaded, 3338.46 MB offloaded
→ Out of memory: Killed process (anon-rss 16.07 GiB)
```

对比 22 帧那次：DiT `10481.95 MB loaded, 840.44 MB offloaded`。
73 帧的 AV latent 大 3.3 倍，把 DiT 的可用空间从 10.5 GB 挤到 8.2 GB，
offload 量从 840 MB 涨到 3338 MB。**而 offload 需要 pinned host buffer**
（`model_management.py:1595`：`min(size, MAX_PINNED_MEMORY) * 2`），
统一内存下这块 host buffer 和设备内存是同一块物理内存，等于双倍占用。

→ 下一个变量因此选 `--disable-pinned-memory`。

## 六之二、真正的瓶颈是编码器，不是解码

把各档的 aimdo 记账排在一起，规律很清楚：

| 帧数 | 卸编码器 freed | DiT usable | DiT loaded | DiT offloaded | 结果 |
|---|---|---|---|---|---|
| 22 | 0.47 GiB | 10585 MB | 10481 | 840 | ✅ |
| 73 | 3.07 GiB | 10343 MB | 10240 | 1081 | ✅ |
| 158 | 1.18 GiB | **7039 MB** | 6729 | **4593** | ✗ 被杀 |

**编码器 9578 MB 加载进来，"卸载"只放出 0.47~3.07 GiB。**
原因就是 A-118：`text_encoder_offload_device()` 返回 CPU，
统一内存下 offload 到 CPU 不释放任何物理页，
`freed memory` 报的是 CUDA 侧的数字，CPU 侧那份副本还占着。

于是帧数一大、latent 一涨，DiT 的可用空间被从 10.5 GB 挤到 7 GB，
offload 量从 840 MB 涨到 4593 MB，加载阶段就被 OOM killer 杀掉。
→ **失败点在加载 DiT，不在解码**（解码那一段因为 `handles_tiling` 本来就是流式的）。

### 要让编码器真正释放，得让 Python 对象被 gc

`unload_all_models()` 只是 offload，不是 free。要真 free，
持有它的引用必须全部消失。阻碍是 **`CONDITIONING` 输出持有 `ModelPatcher` 的强引用**
（这是 ComfyUI 的已知问题，社区在视频模型上普遍遇到）。

三条候选路，按成本从低到高：

1. **`--cache-none`** —— 零成本，一个参数。让节点输出不缓存，
   编码器用完即无引用。⚠ 但社区反馈即使加了它，conditioning 那条引用仍可能残留。
2. **降分辨率换时长** —— 零成本、确定有效。latent 变小，同样内存能放更多帧，
   画质用 SeedVR2 超分补回来（78 秒、峰值 12.9 GB，很宽松）。
3. **换纯文本编码器（ClipProj 方案）** —— 收益最大、工期最长。
   **文生视频根本不需要视觉塔**，而现役编码器带着 351 个 `visual.*` 张量。
   社区方案是 Qwen3-VL-4B 纯文本 GGUF（Q4_K_M ≈ 2.5 GB）+ 一个学出来的投影矩阵
   （50~300 MB）映射到 H3 要的 5120 维——**编码器从 9.5 GB 降到 2.5 GB**，
   而且不牺牲分辨率。已核实存在的资源：
   - `NicoLab28/ClipProj-MiniMax-H3`（投影矩阵，带 32B vs 4B 的 A/B 音频对比与 bench）
   - `SearchingMan/MiniMax-H3-Text-Encoders`（recovered_8b + conditioning_adapter，
     INT8 ConvRot 峰值约 6.2 GiB）
   - `Qwen/Qwen3-VL-4B-Instruct-GGUF`（只取语言部分，不要 mmproj）

   ⚠ 代价：需要 ClipProj 类节点（板上 ComfyUI-GGUF 是 city96 原版，可能要换 fork），
   且**只适用于 t2v**——一旦要用参考图（Ref2VA），必须换回完整的 32B 编码器。

## 六之三、生图的代价：为什么必须做两个启动档

DynamicVRAM 对视频是解药，对生图是负担。用固化的四份基准
（`deploy/comfyui/workflows/bench/`，种子/步数/分辨率全部固定）整组复跑：

| 配置 | 原基线（09-02 上午） | DynamicVRAM | **切回 image 档复跑** | 变化 |
|---|---|---|---|---|
| ab-euler（euler 8 步） | 30.2 s | 35.2 s | **28.6 s** | +16.6% |
| ab-resms4（res_multistep 4 步） | 15.5 s | **21.4 s** | **15.4 s** | **+38.1%** |
| p2-euler8（euler 8 步） | 33.3 s | 38.1 s | **33.6 s** | +14.4% |
| p2-resms4（res_multistep 4 步） | 15.5 s | 19.0 s | **15.5 s** | +22.6% |

第三列是**切回 image 档后的复跑**，四项全部回到基线（差异在正常波动内），
说明这不是"板子变慢了"而是**参数带来的、可逆的**代价，
也顺带验证了 `comfy-profile.sh` 切档确实生效
（日志确认 `Set vram state to: HIGH_VRAM` + `Enabled pinned memory 13031`）。

守则都守了：重启后起步 `used=7647MB`（干净）、预热一张丢弃（83.9 s，与记录的
首张 81.8 s 吻合）、四张各换随机种子、文件名全部不同（没有缓存命中）。

两个观察：

1. **步数越少，代价越大**：8 步档 +14~17%，4 步档 +23~38%。
   DynamicVRAM 每步都要按需搬权重，这是固定开销，步数少时占比更高。
   → `res_multistep` 4 步相对 euler 8 步的优势，从 2.15 倍降到约 1.7 倍。
2. **峰值内存反而涨了**：生图峰值 `used` 24~25 GiB（legacy 下 Z-Image 一套约 11 GB）。
   aimdo 的 staged 加载会先铺开。

### A-124 的结论对，归因错

原措辞是"ComfyUI 按独立显存假设记账、因而算错账 → 必须 `--highvram`"。
**记账那半错了**（aimdo 认得 Orin 的统一内存，见第三节），
但**结论那半仍然成立**：统一内存下 offload 的搬运是纯开销（A-118），
全常驻确实更快。所以 A-124 不作废，只是理由要改写。

→ **两个启动档，用 `deploy/comfyui/comfy-profile.sh` 切**（systemd drop-in 覆盖
`ExecStart`，不造第二个 unit——两个 unit 就有两套 `Conflicts` 和两个 `is-active` 判据，
而它们其实是同一个服务的两组参数）。

## 七、`--disable-smart-memory` 要保留（它不是遗留项）

DynamicVRAM 接管之后，这个 legacy 时代的开关是不是就该删掉？**不是，它恰好有益。**
`model_management.py` 里四处引用，关键是第 882 行：

```python
882:  if not DISABLE_SMART_MEMORY or device is None:
          ...
          if current_loaded_models[i].model.is_dynamic() and for_dynamic:
              memory_to_free = 0        # ← 那条"不为 dynamic 卸 dynamic"的短路
```

**这条短路的外层门就是它。** 我们开着 `--disable-smart-memory`，
于是 `not DISABLE_SMART_MEMORY` 为假、`device` 也不是 None，整个 if 块被跳过，
短路根本不执行。另一处第 1091 行 `if DISABLE_SMART_MEMORY or vram_state == NO_VRAM`
在 `unet_inital_load_device()` 里返回 `cpu_dev`，让 DiT 初始加载走 CPU 再按需搬，
也是我们想要的。

→ **现役三个参数是一组，不要单独删任何一个**：
`--disable-smart-memory --disable-pinned-memory`（不带 `--highvram`）。

## 八、⚠ 板上没有 curl

2026-09-02 确认：`/usr/bin`、`/bin`、`/usr/local/bin`、`/var/lib/llm/bin`
**都没有 curl**。写板上脚本时不要用它探活。

这个坑特别阴，因为**它不报错**：用 `curl` 探 8188 端口时检测永远失败，
循环等满 180 秒后继续往下执行，看起来像"在耐心等服务启动"，
实际上整个阶梯脚本空转了十几分钟、一次都没跑。

正确写法（node 路径是确定的）：

```bash
NODE=/var/lib/llm/bin/node
up() {
  $NODE -e "
    const r=require('http').get({host:'127.0.0.1',port:8188,path:'/queue'},res=>{res.resume();process.exit(0)});
    r.on('error',()=>process.exit(1));
    r.setTimeout(3000,()=>{r.destroy();process.exit(1)});
  " 2>/dev/null
}
```

另有两个同类的脚本陷阱，都在这轮踩过：

- **`pkill -f <关键字>` 会杀掉自己**——`exec.js` 单行模式下，执行这条命令的 shell
  其命令行里就含那个关键字。改用 `exec.js --file`（命令行只是 `bash -s`），
  或先 `pgrep` 拿 pid 再 `kill`。
- **SSH 断开会带走前台子进程**。长任务必须 `nohup ... > /tmp/x.log 2>&1 < /dev/null &`，
  否则 exec.js 被打断时，板上进程会因为写 stdout 而死，且不留痕迹
  （表现是"进程还在"随后悄无声息地没了）。

## 九、相关社区 issue（都已核实存在且 open）

| 编号 | 标题 | 与我们的关系 |
|---|---|---|
| [#15285](https://github.com/Comfy-Org/ComfyUI/issues/15285) | `--disable-dynamic-vram` flag needed for Jetson (ARM64/Unified Memory) — please don't remove | 建议 Jetson 关掉 DynamicVRAM。**我们实测相反**，但他们说的"加载时崩溃"很可能就是 static TLS |
| [#15453](https://github.com/Comfy-Org/ComfyUI/issues/15453) | MiniMax H3 video VAE: long-clip decode OOMs are unrecoverable — tiled retry is a no-op | 与我们同一场景。**关键情报：16 GB 卡上 243 帧（10 秒）能跑通**，条件是采样后显式 unload |
| [#15456](https://github.com/Comfy-Org/ComfyUI/issues/15456) | Free other models' memory before retrying handles_tiling VAE decode | 上游修复方向 |

#15453 里最有用的一句：

> Inserting a graph-level unload between the sampler and both decode nodes makes the
> identical config complete with regular decode: **243f finishes in 302s**, repeatedly.

他的条件比我们紧（16 GB 显存、864×480、10 步），我们是 28.7 GiB、608×352、4 步。
**说明 243 帧不是不可能，是参数没到位。**
