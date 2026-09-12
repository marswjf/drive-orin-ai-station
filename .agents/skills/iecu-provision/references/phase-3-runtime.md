# 阶段 3 — 运行时基座：Node、git、Python、CUDA、torch

目标：让 `import torch` 能在板上真正跑起一个 GPU kernel。

**这一阶段是解包落地，不是编译。** 编译要四小时且已经踩过 13 个坑，归档就是为了跳过它。

---

## 3.1 版本组合（不要自己改，改一个就全塌）

```
Python 3.13.15   +   torch 2.11.0   +   torchvision 0.26.0   +   torchaudio 2.11.0
CUDA 12.2（Tegra / arm64 变体）   +   cuDNN 9.20   +   gcc-12.5（仅构建期）
OpenBLAS 0.3.29（自编）           +   sm_87，不带 PTX
Flash Attention 与 mem-efficient attention 均已编入
```

为什么是这一组，链条只有一条路：

```
驱动 CUDA API 固定在 12.1
  └─ CUDA 必须 < 12030
       （≥12030 的 torch 会绑 multicast 驱动 API，那是多 GPU 特性，
         Tegra 单卡不支持，运行时报 cudaErrorDevicesUnavailable）
  └─ Tegra(arm64) 变体里低于 12.4 的只有 JetPack 6.0 / L4T r36.2 的 CUDA 12.2
       └─ CUDA 12.2 的 cuda_fp16.hpp 在 C++20 下编不过
            └─ torch 必须用 C++17
                 └─ torch 的 CMAKE_CXX_STANDARD 从 2.12 起是 C++20
                      └─ torch 只能是 2.11
```

⚠ **CUDA 必须是 arm64（Tegra）变体，不是 sbsa。** sbsa 是给 ARM 服务器配独立显卡用的，
在本板子上表现为"库能加载、cuBLAS 初始化失败"（`cublasCreate` 返回 3），
错误信息完全指不到根因。

---

## 3.2 先铺三个前置（缺了会在很后面才暴露）

| 前置 | 装法 | 缺了会怎样 |
|---|---|---|
| **Node** | 解包到 `/var/lib/llm/bin` | 面板和全部工具脚本都跑不了 |
| **git**（解包版） | `deploy/comfyui/install-git.sh` → `/var/lib/llm/gitroot` + 包装器 `/var/lib/llm/bin/git` | ComfyUI-Manager 装任何节点包都失败 |
| **`/var/lib/llm/home`** | `mkdir -p /var/lib/llm/home/.cache` | 根分区只读，模型缓存写不进去 |

⚠ **git 一定要用包装器 `/var/lib/llm/bin/git`，不要手工拼环境变量。**
只设 `PATH` 和 `LD_LIBRARY_PATH` 会漏掉 `GIT_EXEC_PATH`，表现为
`fatal: unable to find remote helper for 'https'`——git 本体能跑，
但找不到 `git-remote-https` 子命令，所有 https 克隆全废。

---

## 3.3 从归档落地

归档在项目 `baseline/`（14 个文件 / 3.81 GB / SHA-256 全部校验通过）。

```bash
# 1. 传过去并校验（传输损坏是真实风险，不是理论风险）
cd /opt/m0/archive-py313 && md5sum -c manifest.md5

# 2. 解释器：路径必须一模一样，rpath 才有效
tar -C /var/lib/llm -xzf python/py313.tar.gz          # → /var/lib/llm/py313
/var/lib/llm/py313/bin/python3.13 -VV

# 3. 运行时库：实体放 /opt/m0，bind 回 /var/lib/llm 并去掉 noexec
mkdir -p /opt/m0/cuda122 && tar -C /opt/m0/cuda122 -xzf runtime/cuda-runtime-libs.tar.gz
mkdir -p /opt/m0/comfyui313 && tar -C /opt/m0 -xzf runtime/comfyui313-env.tar.gz
cp scripts/mount-stack313.sh /var/lib/llm/ && chmod 755 /var/lib/llm/mount-stack313.sh
sh /var/lib/llm/mount-stack313.sh      # 幂等，自检不过会直接报 FATAL

# 4. 需要重装 torch 时（或只带了 wheel）
/var/lib/llm/comfyui313/venv/bin/pip install --no-deps --force-reinstall wheels/torch-*.whl
```

运行时库目录里应该有 52 个文件、约 2.4 GB，全部是 12.2 版本。

🔴 **里面绝不能出现 `libcuda.so.1`、`libnvrm*`、`libnvos*`。**
那是驱动的一部分，与内核模块配套，必须用目标板自己的。
归档脚本和分发脚本各有一道自检挡这个。

---

## 3.4 库解析顺序（错了会静默出错，不报错）

运行时的 `LD_LIBRARY_PATH` 必须让 `/var/lib/llm/cuda122/lib64` **排在系统库前面**：

```bash
export LD_LIBRARY_PATH=/var/lib/llm/cuda122/lib64:${LD_LIBRARY_PATH:-}
```

两个必须排前面的原因：

| 库 | 系统版 | 我们分发的 | 用错了会怎样 |
|---|---|---|---|
| `libopenblas.so.0` | focal 自带 0.3.8 | 自编 0.3.29 | **CPU 矩阵乘必出 NaN**，实测 30 次全中，而且不报任何错 |
| `libstdc++.so.6` | 6.0.28 | 6.0.35 | 符号版本不够，`import torch` 直接失败 |

第一条尤其阴险：不报错，只是所有 CPU 数值结果变成 `nan`。

---

## 3.5 完成判据：真跑 kernel，不看开关

用 `scripts/65-verify-on-board.sh`，它设的 `LD_LIBRARY_PATH` 与生产完全一致。

⚠ **一定要在板上按生产配置验，不要在构建 chroot 里验。**
两边的 OpenBLAS 和 libstdc++ 不是同一个文件——在 chroot 里验过一次，
两项数值检查 FAIL，实际产物完好，差点误判成坏 wheel 去重编。

十三项判据（基线板全部通过）：

```
arch (8,7) / 编译期 CUDA 12.2 / 首次矩阵乘 4.49s（无 PTX JIT）
flash attention 强制后端 OK / mem-efficient OK
4096 序列注意力峰值 math 1213 MiB → flash 33 MiB（省 97%）
flex_attention / enable_gqa / PEP585 infer_schema 全部原生
CPU-GPU matmul 最大差 0.000e+00 / CPU matmul 30 次 NaN 0 次
cuDNN conv2d OK / CUDA Graph 捕获回放 OK
```

- [ ] 十三项全 PASS
- [ ] `ldd .../torch/lib/libtorch_cuda.so | grep libcuda` 解析到目标板自己的 `/usr/lib/libcuda.so.1`
- [ ] 首次矩阵乘在秒级（分钟级说明在现场编 PTX，架构没对上）

---

## 3.6 什么情况下必须重编（不能用归档）

| 情况 | 原因 |
|---|---|
| GPU 不是 sm_87 | wheel 里只有 sm_87 的 cubin，且不带 PTX 退路 |
| 驱动 CUDA API 不是 12.1 | 版本链是围着它推的；**更高的话应该用更高的 CUDA 与 torch，值得重推一遍** |
| glibc 不是 2.31 | wheel 与运行时库都按 2.31 编 |
| 要换 Python 版本 | wheel 是 cp313 |

重编入口 `scripts/60-build-torch211.sh`，早停检查会在开工三十秒内拦下不匹配的环境。
**重编必须先打 `63-patch-loops-apply.sh`**——不打的话会在 `[2549/5564]` 附近失败，白跑两小时。
