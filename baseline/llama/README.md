# baseline/llama —— llama.cpp 二进制归档

## 一个包，两个后端

| 文件 | 角色 | 内容 |
|---|---|---|
| `llama-b10498-5ecbe1ac1-cuda-cpu.tar.gz` | **基线（现役）** | **CUDA 版 + CPU 版 + 两个启动脚本，同一个 commit** |

> 上一代 `dd1ea52` 不随本仓库分发。下面的版本对比与速度实测是换版当时的记录，
> 保留下来是为了说明现役版本的来历，不表示那个归档可以下载。

**解开就能直接铺到 `/var/lib/llm/llama/`**，包内结构与落点一一对应：

```
llama/
  bin/               CPU 版（向量服务 CPU 档用）
  bin-cuda/          CUDA 版（推理服务用）
  run-server.sh
  run-embedding.sh
```

> **为什么坚持做成一个包。** 中间一度是"新包只有 CUDA 版、CPU 版还得从老包里取"，
> 那等于把一件现在就能做完的事推给未来的部署流程，还平白多出一个变量——
> 同一台机器上跑着两个版本的 llama.cpp。现在两半是同一个 commit 编出来的，
> 部署时解一个包就够。

## 版本

| 项 | `dd1ea52`（上一代，不分发） | `b10498-5ecbe1ac1`（基线） |
|---|---|---|
| 版本串 | `version: 1 (dd1ea52)` | `version: 0.1.2-dev (build 10498, commit 5ecbe1ac1)` |
| 来源 | ggml-org/llama.cpp master（2026-08-10）| master（2026-08-18）+ **PR #27342（DFlash2，当时仍 Open）** |
| 相差 | — | 143 个提交 |
| 投机类型 | mtp / dflash(v1) / dspark / ngram-* | 同上，外加**真正的 DFlash2**（selector + 两抽头卷积）|
| 工具链 | nvcc 12.1 交叉编译、GNU 9.4.0、aarch64、sm_87 | 同左 |
| GLIBC 上限 | ≤2.31 | **2.18**（板上 2.31，安全）|

## 速度：两版持平，差异在噪声内

同法同长度实测（Qwen3.8-27B / MTP n=2 / temp 1.0，每次换前缀避免命中提示词缓存）：

| build | 2k | 8k |
|---|---|---|
| dd1ea52 | 11.2 / 10.7 / 10.4 | 10.0 / 10.9 |
| b10498 | 11.5 / 10.4 | 11.8 / 10.2 |

> ⚠ 换装当天曾据「新版 11.5 / 11.8」判定新版更快，**那是一次偏好的采样**；
> 补测后两者区间完全重叠。**5% 量级的差异单次 A/B 判不了**，这个模型 run-to-run 噪声就有 ±5%。

**换版的实际理由不是速度**：① 143 个提交的上游修复；② 多一个
`llamacpp:prompt_tokens_cached_total` 指标；③ 支持 DFlash2（虽然实测在本板上是负收益，
见 SKILL 能力边界 B 档）。

## 升级验收结论（2026-08-19，按 `deploy/llama/UPGRADE-CHECKLIST.md` 走）

- **接口**：`/slots` 56→56 完全一致、`/v1/models` 一致、`/metrics` 只**新增**一项、
  `/props` 只新增 `chat_template_caps.supports_reasoning_effort`。**无字段消失。**
- **行为**：普通对话、`-nothink`、思考档 `reasoning_content`、
  **工具调用 `finish_reason=tool_calls`**、向量端点 1024 维带 usage —— 全部一致。
- **向量数值**：换 `bin/` 前用 `embed-fingerprint.js` 与旧版逐条比对——
  **七条语料余弦全部 1.000000、单维最大差 0.00e+0，逐位相同，知识库不必重建。**
  （参照：F16→Q8 那次余弦 0.9997、单维差 5.6e-3 就已经要求整库重建了，陷阱 34。
  所以这道闸不能省，但这次结果是最好的那种。）
- **日志**：进度行字段名 `n_decoded` → `n_gen`，面板汉化规则已改成两种都认
  （`panel-ui/src/logtext.js`）。
- ⚠ **采指纹时两边必须同为"热" slot**：第一次对比时新版刚重启、slot 没被填充，
  报出 53 个字段"消失"，全是假警报（与陷阱 56 同族：比较的两边条件必须一致）。

## 落地与回滚

```sh
# 看现在哪个在跑
sh /var/lib/llm/llama/promote-bin-test.sh status

# CUDA 版切换（改名式，秒级可逆）
sh /var/lib/llm/llama/promote-bin-test.sh rollback|promote

# CPU 版切换（会先验证向量数值等价，不通过就不换）
sh /var/lib/llm/llama/swap-cpu-bin.sh verify|swap|rollback
```

新板子从零部署：解这一个包到 `/var/lib/llm/`，两半就都齐了。

## 校验

| 文件 | SHA-256 |
|---|---|
| `llama-b10498-5ecbe1ac1-cuda-cpu.tar.gz` | 见同名 `.sha256` |

## 怎么重编

```
deploy/build/3-fetch-dflash2.sh     取源码 + 配置期体检
deploy/build/4-build-dflash2.sh     编 CUDA 版（GGML_STATIC=ON）
deploy/build/5-build-cpu-and-pack.sh 编 CPU 版（GGML_STATIC=OFF）+ 打成上面那个单一包
```

**三个坑写在脚本注释里，也记在 SKILL 陷阱 65**：

1. **配方不对称**：CUDA 版要 `-DGGML_STATIC=ON`，**CPU 版绝不能开**——
   开了会把非 PIC 的 `libpthread.a`/`libgomp.a` 塞进 `libggml-base.so`，
   报 `R_AARCH64_ADR_PREL_PG_HI21 against __stack_chk_guard`。
2. **两版都要那个 patch**：注释掉 `ggml/src/CMakeLists.txt` 的 `add_link_options(-static)`。
3. **"Provisioning UI assets" 会无声挂死**：它从 HuggingFace 拉预编译 Web UI
   （`LLAMA_USE_PREBUILT_UI=ON`），实测卡住 11 分钟、0% CPU、无任何网络连接，
   而同一时刻 `curl huggingface.co` 是 1 秒 200——**不是网络不通**。
   5 号脚本改为**复用 CUDA 构建里已取好的那份**（同一 commit，资源完全一样），
   既省一次下载也绕开这个不确定性。
