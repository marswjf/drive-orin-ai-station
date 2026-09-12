<!-- lint:legacy-ok 本文档描述的是已退居回滚位的 py3.8 环境，路径引用是有意为之 -->
# 在 IECU 3.1 上部署 ComfyUI

板子从零重建时照这份走。**所有脚本都在本目录**，板上只是它们的落地副本，清理板子不影响重建。

建成时间 2026-08-13。板上跑的是 **ComfyUI 0.32.0（当日最新版）**，没有降级。

> ## ⚠ 2026-08-14：现役已换成 Python 3.10 环境，本文档描述的是**旧的 py3.8 那套**
>
> `comfyui.service` 现在指向 `/var/lib/llm/comfyui310`：
> **ComfyUI 0.33.0 + Python 3.10.14 + 自编 torch 2.4.1 / torchvision 0.19.1 / torchaudio 2.4.1**
> （仍然 CUDA 11.4、sm_87，只是自己从源码编，不再用 NVIDIA 的 cp38 轮子）。
> 出图性能与本文档记录的基线持平，**性能数据、工作流、模型路径、`--highvram` 的理由这些结论照旧有效**。
>
> py3.8 那套 `/var/lib/llm/comfyui` + `/var/lib/llm/py` **原样保留作回滚**，本目录的
> `patch-py38.py` / `compat-py38.py` 只对它有意义，新环境**一个补丁都不需要**（官方 requirements 直装）。
>
> 新环境怎么建、为什么要自己编 torch、三道非改不可的门槛（comfy_kitchen 与 torchaudio 是裸 import 的
> 必需件、ComfyUI 0.33 实际要 torch 2.5 的几个行为），见 `../torch-py313/` 的构建脚本与 NOTES。

---

## 一分钟看懂为什么这么装

这块板子的约束链条只有一条路可走，任何一环换掉都会断：

```
DRIVE OS 6.0.9 的 GPU 驱动 = CUDA 12.1（内核态，不可替换）
        ↓ 决定
只能用 CUDA ≤ 12.1 编译的 PyTorch
        ↓ 唯一满足的是
NVIDIA JetPack 5 的 torch 2.1.0（CUDA 11.4 编译，原生 sm_87）
        ↓ 它只发
cp38 轮子 → 必须用 Python 3.8
        ↓ 而
ComfyUI 0.32 假设 Python ≥ 3.9、torch ≥ 2.2
        ↓ 所以
补掉这中间的差距，而不是降级 ComfyUI
```

三条被实测排除的路（别再试）：

| 方案 | 结果 |
|---|---|
| PyTorch 官方 `cu126` aarch64 轮子 | **明确排除 sm_87**：警告里写着 `>=8.0,<9.0 except {8.7}`，运行报 `no kernel image is available` |
| jetson-ai-lab 的 JP6 轮子（原生 sm_87） | 要 **glibc 2.35**，板上是 2.31，`libtorch_cpu.so` 缺 48 个符号 |
| Ubuntu 22.04 chroot（glibc 2.35） | chroot 本身成功（注入 123 个 Tegra 库后 `cuInit` 返回 0、认出 sm_87），但 JP6 的 torch 是 CUDA 12.6 编译，撞上驱动 12.1 → `Error 200: device kernel image is invalid`。**glibc 不是真正的墙，驱动版本才是** |

---

## 实测性能（2026-08-13，模型已在内存）

| 模型 | 分辨率 | 步数 | 耗时 | 每步 |
|---|---|---|---|---|
| SDXL base 1.0 | 1024×1024 | 20 | **26.1 秒** | 1.30 s |
| SDXL base 1.0 | 1024×1024 | 30 | 38.1 秒 | 1.27 s |
| SDXL base 1.0 | 768×768 | 20 | 14.0 秒 | 0.70 s |
| SD 1.5 | 512×512 | 20 | **6.0 秒** | 0.30 s |
| SD 1.5 | 768×768 | 20 | 18.1 秒 | 0.90 s |

### Z-Image Turbo（2026-08-14 补测，走 GGUF 量化）

| 权重 | 体积 | 首张（含加载）| 稳定后 | 每步 | 连续出图 |
|---|---|---|---|---|---|
| bf16 + `--lowvram` | 11.46 GB | 110.3 秒 | — | 13.79 s | ❌ 第 2 张 OOM |
| bf16 + `--highvram` | 11.46 GB | — | — | — | ❌ 加载即被 OOM 杀 |
| **GGUF Q8_0 + `--highvram`** | **6.73 GB** | 84.2 秒 | **40.1 秒** | **5.01 s** | ✅ 稳定 |
| GGUF Q4_K_M + `--highvram` | 4.64 GB | 84.2 秒 | 48.1 秒 | 6.01 s | ✅ 稳定 |

**★ 主力用 Q8_0。** 两条反直觉但已实测确认的结论：

1. **提速 2.75 倍的原因不是量化，是免掉了 offload。** bf16 装不下（总量 19.3 GB），
   ComfyUI 只能逐层把 6.3 GB 权重搬进搬出，那才是 13.79 秒/步的大头。压到 14.5 GB
   装得下之后，日志变成 `loaded completely; 6973.32 MB loaded, full load: True`，
   一次搬运都没有。
2. **量化档越低反而越慢。** Q4_K_M 比 Q8_0 慢 20%——ComfyUI-GGUF 是**逐层反量化回 bf16
   再算**，K-quant 的超级块解码比 Q8_0 复杂得多，省下的 2 GB 换来了更高的反量化开销。
   **只有在 Q8_0 装不下时才降档。**

峰值温度 63.9~70.2°C。裸算力实测：FP16 矩阵乘 **33.03 TFLOPS**、bf16 **33.33**（两者相同，
换精度不提速）、**INT8 经 cuBLAS TN 布局 44.28 TOPS**（但 torch 的 `_int_mm` 没编入，
ComfyUI 走不到；标称的 254 TOPS 是 INT8 稀疏 + 两个 DLA 的合计，不是 GPU dense 值）。

> ⚠ **测速时 seed 必须每次不同**。ComfyUI 会按节点输入做缓存，同参数重跑直接命中
> `execution_cached` 秒回，会测出"SDXL 复跑 2 秒"这种假数据。`bench/gen.js` 已默认用时间戳做
> seed，并会在采样器命中缓存时打出警告。

---

## 重建步骤

前置：板子能通过 LXC 出网（临时正向代理），`/var` 有 6 GB 以上可用。

### 1. 装 Python 3.8

板子的根分区是**只读**的，且厂商镜像里没打包解释器（`dpkg -l` 显示 `python3.8` 是 `ii` 已安装，
标准库 205 个文件、`libpython3.8.so.1.0` 都在，唯独少了 `/usr/bin/python3.8` 这个可执行文件）。
所以不装进系统，而是解包到 `/var/lib/llm/py/root` 自成一体：

```bash
# 在 LXC 上下载（板子不能直接出网）
BASE=http://ports.ubuntu.com/ubuntu-ports/pool/main/p/python3.8
for f in python3.8-minimal libpython3.8-minimal libpython3.8-stdlib python3.8 libpython3.8; do
  curl -O "$BASE/${f}_3.8.10-0ubuntu1~20.04.18_arm64.deb"
done
# distutils 被拆成独立包，pip 需要它
curl -O http://ports.ubuntu.com/ubuntu-ports/pool/main/p/python3-stdlib-extensions/python3-distutils_3.8.10-0ubuntu1~20.04_all.deb
curl -O http://ports.ubuntu.com/ubuntu-ports/pool/main/p/python3-stdlib-extensions/python3-lib2to3_3.8.10-0ubuntu1~20.04_all.deb

# 传到板上后解包到自建 prefix
R=/var/lib/llm/py/root
for d in *.deb; do dpkg-deb -x "$d" $R; done
```

pip 用 `get-pip.py` 的 3.8 分支：`https://bootstrap.pypa.io/pip/3.8/get-pip.py`

### 2. 补三个原生库

torch 的 `ldd` 会缺这三个，装完才能 `import torch`：

| 库 | 来源 |
|---|---|
| `libopenblas.so.0` | `libopenblas0-pthread_0.3.8+ds-1ubuntu0.20.04.1_arm64.deb` |
| `libgfortran.so.5` | `libgfortran5_10.5.0-1ubuntu1~20.04_arm64.deb`（openblas 依赖它）|
| `libnvToolsExt.so.1` | PyPI 的 `nvidia-nvtx-cu11` 轮子里取（CUDA 11.x 内 ABI 稳定）|

放进 `$R/usr/lib/aarch64-linux-gnu/`。

### 3. 装 PyTorch

```
https://developer.download.nvidia.com/compute/redist/jp/v512/pytorch/
  torch-2.1.0a0+41361538.nv23.06-cp38-cp38-linux_aarch64.whl     (163 MB)
```

验证（必须看到 `sm_87` 与 `True`）：

```python
import torch
torch.cuda.is_available()                    # True
torch.cuda.get_device_properties(0)          # Orin, sm_87, 16 SM, 28.7 GB
```

### 4. 装 ComfyUI 与依赖

```bash
git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git
```

依赖分三类装，顺序不能乱：

```bash
PY=$R/usr/bin/python3.8
SP=$R/usr/lib/python3.8/site-packages

# A. 纯静态资源包：Requires-Python 是元数据声明，包里没有 py39+ 语法，强装即可
#    （comfyui-frontend-package 是 524 个 js/css + 1 个空 __init__.py）
$PY -m pip install --target=$SP --ignore-requires-python \
  comfyui-frontend-package==1.48.7 comfyui-workflow-templates==0.11.40 comfyui-embedded-docs==0.5.9

# B. 两个自研包取纯 Python 的 py3-none-any 版本（平台轮子只有 cp310+）
#    实测都是零 .so、零 py38 语法不兼容
$PY -m pip install --target=$SP --ignore-requires-python --no-deps \
  comfy-kitchen==0.2.31 comfy-aimdo==0.4.13

# C. 其余依赖让 pip 自解 py38 版本；★ 必须带 --no-deps 或事后重装 torch
#    torchsde / kornia / spandrel 的依赖解析会把 torch 覆盖成 PyPI 的 2.4.1（CPU 版）
$PY -m pip install --target=$SP --only-binary=:all: \
  torchsde einops transformers tokenizers sentencepiece safetensors aiohttp yarl \
  pyyaml scipy tqdm psutil alembic av requests simpleeval blake3 kornia spandrel \
  pydantic pydantic-settings eval_type_backport importlib_resources torchvision==0.16.2

# ★ 重新装回 NVIDIA 的 torch，覆盖被 C 组拖进来的 PyPI 版
$PY -m pip install --target=$SP --force-reinstall --no-deps <NVIDIA torch wheel>
```

`torchaudio` 单独处理，见下方「音频」。

### 5. 打两个补丁（本目录的脚本）

**顺序不能颠倒**——`patch-py38.py` 要在加 `__future__` 之前跑，否则含 `match/case` 的文件
解析不过会被跳过。

```bash
$PY patch-py38.py  /var/lib/llm/comfyui                       # 改写 match/case
$PY compat-py38.py $SP --comfyui /var/lib/llm/comfyui         # 兼容层 + 注解改写
```

`patch-py38.py` 做的事：把 LTX-Video 音频 autoencoder 里 4 处 `match/case`（py3.10 语法）
等价改写成 `if/elif`。`case X.Y:` 对枚举成员就是相等比较，`case A | B:` 就是 `in (A, B)`，
纯机械转换。**全项目 625 个 .py 只有这一个文件不兼容。**

`compat-py38.py` 做三件事：

1. 写 `sitecustomize.py`（Python 启动自动加载，对所有进程生效），补齐：

   | 缺口 | 补法 |
   |---|---|
   | `_pytree.register_pytree_node` | 转发到 torch 2.1 的 `_register_pytree_node`，丢掉多出的参数 |
   | `torch.library.custom_op` | 转发调用的壳；eager 后端本就是纯 PyTorch 实现，等价 |
   | `torch.float8_*` / `uint16/32/64` | 哨兵对象占位。**不用 `torch.uint8`**——那会让真实 uint8 张量被 `dtype == float8_e4m3fn` 误判 |
   | `torch.nn.RMSNorm` / `F.rms_norm` | **真实现**（float32 上求均方，cast 回原 dtype 再乘 weight），已对参考公式验证差 1.19e-07 |
   | `Module.load_state_dict(assign=)` | **真实现**（替换 `param.data`），不降级成拷贝——SDXL 6.5 GB 权重走拷贝路径峰值要占两份 |
   | `torch.compiler` | 转发到 `torch._dynamo`；板上不开编译，`is_compiling()` 恒 False |
   | `torch.serialization.add_safe_globals` | 空实现（torch 2.1 没有 weights_only 白名单机制）|
   | `numpy.dtypes` | 用 `type(np.dtype("float64"))` 拼出同名模块（numpy 1.24.4 是最后一个支持 py38 的版本）|
   | `dataclass(slots=/kw_only=)` | 吞掉这些 py3.10 参数，都是生成优化 |
   | `functools.cache` / `itertools.pairwise` / `math.lcm` | 等价实现 |
   | `importlib.resources.files` | 转发到 `importlib_resources` backport |

2. 给 `comfy_kitchen` / `comfy_aimdo` / ComfyUI 本体加 `from __future__ import annotations`
   （272 个文件），让 py39+ 的注解语法延迟求值。

3. 改写**运行时真会被求值**的注解——`__future__` 对它们无效：
   - SQLAlchemy 的 `Mapped[...]`（ORM 自己 eval 字符串注解），21 处
   - 模块级与**类体内**的类型别名赋值（`Type = list[str]`），18 处

   改写一律生成**限定名** `typing.List[...]`，不用裸 `List`：`comfy_api/latest/_io.py` 里
   自己定义了 `class Dict(ComfyTypeIO)`，会把 `from typing import Dict` 遮蔽掉。

### 6. 音频（torchaudio）

PyPI 的 torchaudio 与 NVIDIA 版 torch **C++ ABI 不兼容**（`libtorchaudio.so` 报
undefined symbol），NVIDIA 也没为 JP5 发对应轮子。但不需要 stub：

```bash
$PY -m pip install --target=$SP --no-deps --only-binary=:all: torchaudio==2.1.0
# 移走 ABI 不兼容的原生扩展，torchaudio 会自动走纯 Python 路径
rm -rf $SP/torchaudio/lib/*.so*
```

torchaudio 自己有 `_IS_TORCHAUDIO_EXT_AVAILABLE` 开关：扩展**不存在**时走纯 Python 实现，
**存在但加载失败**时才抛异常。移走 `.so` 后实测 ComfyUI 用到的 5 个接口全部可用
（`resample`、`MelSpectrogram`、`bass_biquad`、`treble_biquad`、`equalizer_biquad`），
输出无 NaN。所以**音频功能是完整的**，不是被砍掉的。

（本目录的 `torchaudio_stub.py` 是那条路走不通时的退路，当前用不上，留作记录。）

### 7. 模型目录

`/var` 是系统可写层（overlay），**不当模型盘**——之前往那里传 SDXL 直接把根分区写满了。
模型分放两个数据分区，用 `extra_model_paths.yaml` 让 ComfyUI 同时看见：

```
/opt/m0/sd-models/     ← SD1.5 等
/opt/m/sd-models/      ← SDXL 等
```

`/var/lib/llm/comfyui/models/*` 全部软链到 `/opt/m0/sd-models/*`。
⚠ 绝不能用 `/opt/other`（那是 `/var` 的 overlay 上层宿主）。

传模型用本目录的 `bench/fetch.js`：它会核对 content-length 与落地字节数，
不一致就删掉重试。**直接用 pipe 写文件会踩坑**——遇到 `HPE_CLOSED_CONNECTION` 时
error 与 finish 会同时触发，落下一个截断的文件还报成功，症状是 ComfyUI 报
`MetadataIncompleteBuffer`。

### 8. 注册服务

`deploy/systemd/comfyui.service`：

- 与 `application_start`（智驾栈）、`llm-server`（对话模型）**互斥**
- **故意不与 `llm-embedding` 互斥**——向量服务是基础设施，CPU 档只占约 1.3 GB，
  生图容得下；要腾这块内存时由面板显式停它，不让 systemd 每次切换都打断向量库
- 默认 `disabled`，不开机自启（避免开机就进生图模式）
- **`ExecStart` 必须带 `--highvram --disable-smart-memory`**——这不是调优选项，
  是这块板子的必需项，原因见下一节

---

### 9. 装 GGUF 量化支持（跑 6B 以上模型必需）

板上唯一能跑大模型的办法。**不装它，Z-Image 这一档只能 offload，慢 2.75 倍且必然 OOM。**

```bash
# 节点：只有 5 个 py 文件，实测 py3.8 语法零不兼容，不用改写
#      （本机 clone 后打包传板上——板子不能直接出网）
git clone --depth 1 https://github.com/city96/ComfyUI-GGUF.git
tar -czf comfyui-gguf.tar.gz ComfyUI-GGUF
# 传到板上后：
tar -xzf comfyui-gguf.tar.gz -C /var/lib/llm/comfyui/custom_nodes/

# 依赖只有一个。★ 必须 0.17.1：0.19.0 起 requires_python 提到 >=3.10
$PY -m pip install --no-index --no-deps --target=$SP gguf-0.17.1-py3-none-any.whl
```

装完应注册 6 个节点：`UnetLoaderGGUF`、`CLIPLoaderGGUF`、`DualCLIPLoaderGGUF`、
`TripleCLIPLoaderGGUF`、`QuadrupleCLIPLoaderGGUF`、`UnetLoaderGGUFAdvanced`。

**用法**：工作流里把 `UNETLoader` 换成 `UnetLoaderGGUF`（参数名同为 `unet_name`），
其余节点不动。GGUF 文件放 `/opt/*/sd-models/diffusion_models/` 即可被识别。
Z-Image 在 ComfyUI 里的架构名是 **Lumina2**（`CLIPLoader` 的 `type` 填这个）。
出图脚本样例见 `bench/genz-gguf.js`。

**三条必须记住的**：

1. **`--highvram` 是必需项**。不写（NORMAL_VRAM）第一张就 OOM——统一内存下 offload
   省不出一个字节，但 ComfyUI 只要还相信自己能 offload，内存账就会算错。
2. **模型总量 ≤14 GB**。超了换更低量化档，**不要退回 offload**。
3. **换模型要重启服务**。同一进程内换模型实测从 40.1 秒退化到 58~78 秒。

**基准脚本**（`bench/`）：`bench-dtype.py` 测各精度算力与 SDPA 后端，
`bench-int8.py` 绕过 torch 直调 cuBLAS 测 INT8 真实吞吐（含四种转置布局）。

`bench/gen-restore.js` 是**老照片修复工作流的 API 版**（节点图与
`workflows/老照片修复.json` 一致：读入 → 缩到 1024² → Z-Image 低重绘 → 4 倍超分 → 存图）。
换环境时用它复测这条链路：会打印总耗时并**从 PNG 的 IHDR 直接读出输出尺寸**确认真是 4096²。
用法 `node gen-restore.js <输入图> <denoise> <超分模型>`，端口用 `PORT=` 覆盖。

---

### 10. 装自定义节点

板子不能出网，流程是**本机 clone → 打包 → 传板上 → 跑兼容改写**：

```bash
git clone --depth 1 https://github.com/<owner>/<repo>.git
rm -rf <repo>/.git && tar -czf node.tar.gz <repo>
# 传到板上后
tar -xzf node.tar.gz -C /var/lib/llm/comfyui/custom_nodes/
$PY compat-py38.py $SP --custom-node /var/lib/llm/comfyui/custom_nodes/<repo>
```

**`--custom-node` 是必须的一步**。社区节点普遍按 py3.10 写，语法扫描往往全过，
却在导入时死在运行时求值的 py3.9 特性上，实测两个典型症状：

| 报错 | 原因 | 改写器 |
|---|---|---|
| `unsupported operand type(s) for \|: 'dict' and 'dict'` | 字典合并 `a \| b` | `rewrite_dict_merge` |
| `'type' object is not subscriptable` | `list[str]` 之类注解在运行时求值 | 加 `__future__` / 限定名改写 |

**★ 挑节点包先看 `requirements.txt`，不是看它有多少节点。**
板子无外网时，任何在导入期联网的依赖都是 400 秒起步的代价——
`ComfyUI_Comfyroll_CustomNodes` 声明依赖 matplotlib，pip 重试三轮 DNS，
**启动从 31 秒涨到 408 秒**，最后仍是 `IMPORT FAILED`，而它只提供两个文本框节点，已卸载。

装完**必须查启动日志**：`grep -aE 'IMPORT FAILED|Cannot import' comfy.log`，
并留意启动耗时有没有暴涨。

已装：`ComfyUI-GGUF`（跑大模型必需）、`rgthree-comfy`（零依赖，改写后可用）、
`ComfyUI-Manager`、`AIGODLIKE-COMFYUI-TRANSLATION`（中文界面）。

---

### 11. 现成工作流（`workflows/`，已推到板上 `user/default/workflows/`）

| 文件 | 用途 | 实测 |
|---|---|---|
| `z-image-gguf.json` | Z-Image 文生图 | 1024²/8 步 **40.1 秒** |
| `老照片修复.json` | 修划痕噪点 + 4 倍超分 | **约 100 秒，输出 4096×4096** |

**老照片修复**走的是「Z-Image 低重绘 + ESRGAN 超分」，全部内置节点 + 板上已有模型，
不依赖任何跑不动的大模型。关键参数是 KSampler 的 **denoise**：

- 0.25~0.32 划痕轻、只想去噪
- **0.40 默认**
- 0.45~0.55 划痕重、缺角、发霉
- **超过 0.6 人物长相会变**，修老照片没有意义

三档实测耗时几乎相同（104.2 / 98.6 / 98.2 秒），瓶颈在超分与 VAE 不在采样步数。
超分模型两个：`4x-UltraSharp` 偏锐利、`RealESRGAN_x4plus` 偏自然，放在
`/opt/m0/sd-models/upscale_models/`。

⚠ **社区工作流大多跑不动**，因为它们按 24 GB 独显写。判断方法是看它引用的模型：
凡是出现 `flux-2-klein-9b`（18 GB）、`qwen_3_8b`（16 GB 编码器）、
`seedvr2_ema_7b_fp16`（14 GB）或**任何 fp8 权重**（板上缺 dtype），都不用试。

---

## 升级 ComfyUI 之后

重跑两个脚本即可，都是幂等的，已处理过的文件会跳过：

```bash
$PY patch-py38.py  /var/lib/llm/comfyui
$PY compat-py38.py $SP --comfyui /var/lib/llm/comfyui
```

`patch-py38.py` 若报「未匹配到片段」，说明上游改了那段代码，要照着新代码重写映射表。
所有被改的文件都留有 `.py.orig` 备份。

---

## 排错备忘

| 现象 | 原因 |
|---|---|
| `no kernel image is available` | 装到了官方 cu126 轮子，它排除了 sm_87。换 NVIDIA JP5 轮子 |
| `undefined symbol: _ZN5torch...` | 某个带 C++ 扩展的包（torchvision/torchaudio）与 NVIDIA torch ABI 不匹配 |
| `MetadataIncompleteBuffer` | 模型文件传输被截断，核对字节数重传 |
| `'ABCMeta' object is not subscriptable` | 注解改写用了裸名，被局部同名类遮蔽。要用 `typing.Xxx` 限定名 |
| `module 'numpy.dtypes' has no attribute 'gcd'` | sitecustomize 里临时变量名冲突（`_m` 被两个 shim 复用）。已修，但改这个文件时要留意 |
| ComfyUI 改了代码却没生效 | `run.sh` 用 `exec`，进程名是 `python3.8 main.py`，`pkill -f 'comfyui/main.py'` 匹配不到 |
| 测速快得离谱 | seed 没变，命中了 `execution_cached` |
| sitecustomize 报语法错误 | `SITECUSTOMIZE` 是当字符串拼的，里面写 `\n` `\t` 会在生成阶段被解释掉。`compat-py38.py` 已加落盘前自检 |

---

## 目录清单

```
deploy/comfyui/
├── README.md                 本文件
├── patch-py38.py             改写 match/case（升级后重跑）
├── compat-py38.py            兼容层 + 注解改写（升级后重跑）
├── torchaudio_stub.py        音频退路，当前未启用
├── run.sh                    启动包装（板上 /var/lib/llm/comfyui/run.sh）
├── extra_model_paths.yaml    双分区模型路径
└── bench/
    ├── fetch.js              带校验重试的模型下载器
    └── gen.js                出图与测速（seed 随机，防缓存命中）
```
