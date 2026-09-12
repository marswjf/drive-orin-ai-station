# 在 IECU 3.1 上跑本地 LLM —— 已建成的系统与全部实测

> 状态：**已建成并跑通**。Qwen3.6-35B-A3B (IQ4_XS) + 多模态 + Embedding，CUDA 后端，
> 开机自启，断电重启验证通过。本文是运维与二次开发的单一依据。
> 证据分级见 `evidence-levels.md`。凡标【估算】【未验证】的不得当作事实转述。
> 最后更新：2026-08-11 凌晨（板子 RTC 不准，勿信板上 `date`）。

---

## 一、当前系统长什么样

```
                    ┌─ :9000  iecu-panel（Node 20 aarch64）
                    │           ├─ 运维面板 UI + /api/status
                    │           ├─ /v1/*     聚合入口 ★对外只需这一个 base_url
用户浏览器/客户端 ──┤           │              ├ /v1/embeddings → :8081
                    │           │              ├ /v1/models     → 合并两边列表
                    │           │              └ 其余           → :8080
                    │           ├─ /llm/*   → 反代 :8080（含 llama.cpp 内置聊天 UI）
                    │           └─ /embed/* → 反代 :8081
                    ├─ :8080  llm-server     Qwen3.6-35B-A3B IQ4_XS + mmproj（CUDA）
                    └─ :8081  llm-embedding  Qwen3-Embedding-0.6B f16（CUDA）
```

### 对外 API（2026-08-12 局域网实测通过）

一个 base_url：**`http://__BOARD_LAN_IP__:9000/v1`**，OpenAI 兼容，未开鉴权（API Key 随便填）。

| 路径 | 落到 | 实测 |
|---|---|---|
| `/v1/chat/completions` | :8080 | 30.9 tok/s，支持多模态 |
| `/v1/embeddings` | :8081 | 1024 维，批量输入 OK |
| `/v1/models` | 两边合并 | 返回 `qwen3.6-35b-a3b` + `qwen3-embedding-0.6b` |

为什么要做这层聚合：Dify / Cherry Studio / OneAPI / LobeChat 只允许填一个 base_url，
且默认 chat 与 embeddings 同源；板上却是两个独立进程。分发放在面板里做，
外部就看到一个标准端点。`/llm/v1`、`/embed/v1` 保留，用于明确指定后端。

**不提供 Ollama 协议**：`/api/` 前缀被面板自身的 `/api/status` 等占用了，客户端选 OpenAI 兼容模式。

### 一个 base_url，两个对话模型名

`/v1/models` 返回三个条目，客户端在模型下拉里直接选：

| 模型名 | 思考 | 适合谁 | 实测（同一问题）|
|---|---|---|---|
| `qwen3.6-35b-a3b` | **跟随客户端**（模型默认开）| Cherry Studio、对话、要思考链 | 12.9s，思考 1220 字 |
| `qwen3.6-35b-a3b-nothink` | **强制关闭** | WeKnora、RAG、ReAct、agent 编排 | **1.6s**，直接出答案 |
| `qwen3-embedding-0.6b` | — | 向量 | — |

实现：面板转发前如果发现 `model` 以 `-nothink` 结尾，就把后缀去掉换回真名，
同时往请求体注入 `chat_template_kwargs:{enable_thinking:false}`。
上游 llama-server 只有一个模型实例，**不额外占内存**。

**为什么做成模型名而不是第二个 base_url 或服务端全局开关**：
客户端只认模型名——NewAPI 同步模型列表时自动带上，WeKnora 这类调用方在下拉里选中即可，
不需要改 base_url，也不需要它支持传 `chat_template_kwargs`。
而服务端全局 `--chat-template-kwargs` **会让客户端自己的思考开关彻底失效**
（Cherry Studio 的思考强度怎么调都没反应），2026-08-12 试过，已废弃。

> NewAPI/OneAPI 侧需要在渠道里重新「获取模型列表」或手工加上 `-nothink` 那个名字，
> 否则网关不知道有这个模型，会报模型不存在。

### ★ 并发、排队与超时（接 RAG / agent 编排必读）

**`parallel=1`，同一时刻只处理一个请求，其余排队。** 这不是保守配置，是必需的：
KV 按 `n_ctx` 总量分配，`parallel=2` 会把 128K 切成两个 64K。而 WeKnora 单次请求实测
**68,911 token 输入**——超过 65,536，`parallel=2` 时根本装不下。所以要支持长上下文就只能单并发。

**长 prompt 的处理时间是可算的**：68,911 ÷ 655 tok/s ≈ **105 秒**，这是物理下限，不是故障。
WeKnora 默认超时约 2 分钟，正好卡在边界上，于是 `client_gone / context canceled`。

排查这类"卡住"按顺序看三件事：

1. **是不是客户端自己超时了**：NewAPI 日志的 `FRT`（首字节耗时）≈ 输入 token ÷ 655，
   对得上就是 prompt 处理本身慢，不是板子故障。→ 把调用方超时调到 5 分钟以上。
2. **是不是 slot 被白跑的任务堵住**：查 `/slots` 的 `is_processing`。
   2026-08-12 修过一个真 bug——面板不传播客户端断开，导致断开后仍生成到 `max_tokens`，
   `parallel=1` 下把后续请求全堵死（现象："板子 99% 满载但没人拿到结果"）。已修。
3. **是不是注入的上下文太多**：68K token 的 RAG 上下文本身就该压缩，
   调小 top-k 比什么优化都有效——prompt 处理时间与 token 数成正比。
4. **★ 是不是调用方悄悄把思考打开了**（2026-08-21 加，那次事故的真根因）：
   同一批任务，思考版 150~190 秒/条、nothink 13.7~17.1 秒/条，**差 10 倍**。
   判据是**跟理论值对账，不是看落没落在"正常范围"**——
   3900 输入 + 4000 输出按 40 tok/s 该是 100 秒出头，实际 150~190，
   多出来的就是几千个 reasoning token。`/v1/chat/completions` 的响应里
   `usage.completion_tokens` 远大于正文长度，就是这个情况。

### ★ 面板层的三道闸（2026-08-21 上线）

在这之前**这一层一道拦截都没有**，全靠调用方自律，因此打出过一次拥塞崩溃
（9 条请求横跨 35 分钟全挂在队列里，队尾等到 1860 秒；详见 SKILL 陷阱 68）。
常量都在 `deploy/panel/server.js` 顶部，改之前先读那段注释：

| 闸 | 值 | 触发时 | 怎么定的 |
|---|---|---|---|
| 并发上限 `CHAT_GATE.max` | 3 | 10 ms 内 429 + `Retry-After: 160` | 队尾最坏等待 =（N-1）× 单条服务时间。调用方超时要 ≥ 420 秒 |
| 请求超时 `CHAT_TIMEOUT_MS` | 900 秒 | 断开上游、释放 slot | 按 `--predict 16384` 算：16384÷25 t/s + 最坏 prefill 187 秒 = 842 秒 |
| 请求体上限 `MAX_BODY_BYTES` | 60 MB | 413 + `Connection: close` | 给多模态留的。纯文本吃满 128K 也才 0.6 MB（约 4.3 字节/token）|

配套还在四份配置里加了 **`--predict 16384`**：`--predict` 默认是 **-1（无限）**，
不传 `max_tokens` 的调用方能一路生成到吃满 128K（`n_tokens_max` 顶到 131071 就是这么来的）。
客户端传的 `max_tokens` 优先级更高，这只是天花板。
⚠ **改 `--predict` 就要同步重算 `CHAT_TIMEOUT_MS`**，两者配套。

⚠ **三道闸都是兜底，不是治本**。上面那次事故补完闸之后问题仍在，
真根因是调用方误开了思考。**别把"指标变好"当成"问题解决"**。

**★ 并发该设几，取决于调用方怎么排任务**（2026-08-21 实测，一天内被推翻一次）：
单 slot 只保留最后一次的 prompt 缓存，所以**同类请求连续排 → 第二条命中同一份
system 前缀，并发无损**，还能填住网络往返的空档；**交替排 → 互相顶掉缓存，并发净亏**。
实测：交替取样时 `cached_tokens` 3418→1；生产跑批按业务线连续排时，
前 20 条中位数 3418、19/20 命中 >3000，201 条里只在跨线交界处冲刷一次。
→ 接新调用方时**先问它怎么排任务**，比直接给一个并发数字有用。

### ★ 思考模式：接客户端"没反应"的头号原因

Qwen3.6 先输出 `reasoning_content` 再输出 `content`。流式实测（同一句 `hi`）：

| | 思考开（模型默认） | 思考关 |
|---|---|---|
| 首个数据包 | 262 ms | 264 ms |
| **首个正文字符** | **5617 ms**（前面 619 字思考）| **264 ms** |
| 总耗时 | 5966 ms | 577 ms |
| 工具调用 | 正常 | 正常（1.97 秒返回 `tool_calls`）|

客户端不渲染 `reasoning_content` 就表现为长时间空白；`max_tokens` 给小了更会
把 token 全烧在思考上、`content` 返回空串。接 agent 的人会直接判定"服务挂了"。

**关掉的方式，按推荐顺序**：

1. **改用 `qwen3.6-35b-a3b-nothink` 这个模型名**（推荐）：不动任何配置，互不干扰。
2. **请求级**：请求体加 `"chat_template_kwargs": {"enable_thinking": false}`。
3. **服务端全局**：config.json 设 `"chatTemplateKwargs": "{\"enable_thinking\":false}"`。
   ⚠ **这会让所有客户端的思考开关失效**，只适合整台机器都不需要思考的场景。
   2026-08-12 曾这样设过，结果 Cherry Studio 看不到思考链、思考强度调了没反应，已改回。

**思考内容的返回格式**由 `reasoningFormat` 控制（现设 `deepseek-legacy`）：
`content` 里保留 `<think>` 标签的同时也填 `reasoning_content`，两种解析法的客户端都能显示。
客户端看不到思考链时，先确认这一项，再怀疑别的。Responses API（`/v1/responses`，
Cherry Studio 可以开）会把思考放在独立的 `reasoning` 输出项里，实测正常。

**客户端可以覆盖服务端的全局设置**【实测】：服务端设了 `enable_thinking:false` 之后，
请求里传 `"chat_template_kwargs": {"enable_thinking": true}` **能把思考开回来**
（实测 reasoning_content 2072 字）。所以"服务端默认关 + 需要时客户端开"是最灵活的组合。

- **Cherry Studio**：模型设置 →「自定义参数」加一条，键 `chat_template_kwargs`，
  值（JSON 类型）`{"enable_thinking": true}`。
- **NewAPI/OneAPI**：渠道的「参数覆盖」里加同样的字段；想两种模式并存就配两个模型别名
  指向同一渠道，一个带 override 一个不带。

**三个无效的方式，别浪费时间**【实测】：
- `--reasoning-budget 0`：参数确实传进去了，照样输出 619 字思考、首字仍要 5.6 秒。
- 消息里加 `/no_think` 后缀：对 3.6 无效（仍思考 778 字）。
- 请求级 `reasoning_effort: "high"`（OpenAI 风格）和顶层 `enable_thinking: true`：
  llama.cpp 两个都忽略，必须包在 `chat_template_kwargs` 里。

| 位置 | 内容 | 说明 |
|---|---|---|
| `/var/lib/llm/bin/` | Node 20.20.2 aarch64 | 官方二进制，glibc 2.28 要求，板上 2.31 满足 |
| `/var/lib/llm/llama/bin/` | llama.cpp **CPU 版** | 保留作回退 |
| `/var/lib/llm/llama/bin-cuda/` | llama.cpp **CUDA 版** | 生产用；`libggml-cuda.so` 753 MB（cuBLAS 静态链入）|
| `/var/lib/llm/llama/run-server.sh` | 主模型启动包装 | 读 `config.json`，支持后端切换 |
| `/var/lib/llm/llama/run-embedding.sh` | 嵌入服务启动包装 | 同上 |
| `/var/lib/llm/panel/` | 面板 server.js + index.html | 零外部依赖 |
| `/var/lib/llm/config.json` | 唯一配置源 | 面板可改，改完重启服务生效 |
| `/opt/m/llm/*.gguf` | 模型（19 GB） | 该分区 noexec，只放数据 |
| `/etc/systemd/system/` | 4 个 unit | overlay→`/persistent`，跨重启持久 |

**为什么二进制在 `/var/lib` 而模型在 `/opt/m`**：板上所有大分区都是 `noexec`，`/` 和 `/app` 是 `ro`；
只有 `/var` 系（overlay，upperdir 在 `/opt/other`）可写又可执行。`/var/tmp` 也行但有被
`systemd-tmpfiles` 清理的理论风险，所以选 `/var/lib`。

### 生产配置：双模型预设（2026-08-12 深夜起）

`config.json` 不再手写，由两份预设覆盖（面板「模型配置」卡或 `POST /api/preset/{mtp|mm}`
切换，切换会重启 llm-server）。

> **预设是字段级合并，不是整份覆盖**（2026-08-13 改）：`server.js` 里的 `PRESET_KEEP`
> 列出向量服务（`embedding*`）、站点、面板行为等字段，切预设时从当前 config 保留。
> 此前整份覆盖，新增字段漏写进预设文件就会被静默清掉——`embeddingModel` 踩过一次。
> **新增 config 字段时先判断它归不归推理预设管，不归就加进 `PRESET_KEEP`。**

公共参数两份一致：

```json
{
  "backend": "cuda",
  "ctx": 131072, "ngl": 99, "threads": 4, "parallel": 1,
  "flashAttn": "on", "cacheTypeK": "q8_0", "cacheTypeV": "q8_0",
  "batchSize": 2048, "ubatchSize": 1024,
  "reasoningFormat": "deepseek-legacy",
  "port": 8080,
  "embeddingPort": 8081, "embeddingParallel": 1,
  "embeddingCtxSlot": 4096, "embeddingCacheRam": 0,
  "embeddingModel": "/opt/m/llm/Qwen3-Embedding-0.6B-Q8_0.gguf",
  "embeddingBackend": "cpu"
}
```

> `embeddingModel` 与 `embeddingBackend` 由 `PRESET_KEEP` 保留，**不写进预设文件**——
> 写进去反而会让切预设时覆盖掉用户当前的选择。

差异部分（`/var/lib/llm/config-preset-{mtp,mm}.json`，`modelSizeB` 供面板做就绪校验，
应用时被剥掉不进 config.json）：

| 预设 | model | mmproj | extraArgs 前两项 | cacheRamMiB | 加载 |
|---|---|---|---|---|---|
| **mtp（MTP 加速，默认）** | `/opt/m/llm/Qwen3.6-35B-A3B-MTP-UD-IQ4_XS.gguf` | 无 | `--spec-type draft-mtp --spec-draft-n-max 2` | 1024 | 78s |
| mm（多模态） | `/opt/m0/llm/Qwen3.6-35B-A3B-UD-IQ4_XS.gguf` | `/opt/m/llm/mmproj-F16.gguf` | `--spec-type ngram-mod` | 1024 | 213s |

> **缓存池容量怎么定**：MTP 档的 prompt 缓存条目实测 **35.2 KiB/token**（A-83），
> 是非 MTP 时期（17.9 KiB，A-57）的两倍，所以 1024 MiB 只装得下 **2.98 万 token** 的
> 会话——6 万 token 级的 RAG 会话每次都 `exceeds cache size limit ... skipping`，
> 这 1 GB 对长上下文场景零收益。定容量前先跑
> `journalctl -u llm-server | grep 'prompt state size'` 配对 `prompt_n` 重算这个系数，
> 换模型或换投机方案后它会变。
>
> 历史：MTP 上线当晚曾把池降到 512 救急（A-81 的 +1.7GB 让稳态贴到 0.4GB 守护线），
> 后因 embedding 换 Q8 省回 531MB 而回调 1024——但那等于把省下的又花回去（净收益
> 19MB，A-85），2026-08-13 凌晨仍被内核 OOM 连杀三次。真正解决问题的是把 embedding
> 切到 CPU 档（省 2.5GB，见下节）。

### 向量服务的计算后端（2026-08-13 起默认 CPU）

`embeddingBackend` 取 `cuda` 或 `cpu`，面板「模型配置」卡下半区切换
（`POST /api/embedding-backend/{cuda|cpu}`，重启约 10 秒）。

| 档 | nvmap | RssAnon | 切换后 MemAvailable | 单条延迟（17/277/1243 tok） |
|---|---|---|---|---|
| cuda | 2.18 GB | 1.30 GB | 0.71 GB | 12.1 / 12.0 / 15.2 ms，很稳 |
| **cpu（默认）** | **0** | 0.95 GB | **3.18 GB** | 18.4 / 21.6 / 28 ms，偶有 77~164 ms 抖动 |

`run-embedding.sh` 里 CPU 档做三件事：`CUDA_VISIBLE_DEVICES=` 置空、`--n-gpu-layers 0`、
`--threads 11`。

> ⚠ **只给 `-ngl 0` 不够**：`bin/` 与 `bin-cuda/` 是同一个带 CUDA 的二进制（字节数相同），
> 仍会建 CUDA 上下文并占 GPU 映射内存。必须置空 `CUDA_VISIBLE_DEVICES`，启动日志出现
> `failed to initialize CUDA: no CUDA-capable device is detected` 才算真进 CPU 档（A-87）。
>
> ⚠ **两档算出的向量不是同一组数值**：余弦相似度 0.9997、单维最大差 5.6e-3，比
> F16→Q8 换装的差异还大（A-88）。**建库与查询必须用同一档**，"平时 CPU、建库切 GPU"
> 的错峰思路等于混用。换档要整库重建。
>
> 线程数 11 = `nproc` 值；CPU5 被 `isolcpus` 隔离，nproc 已经排除它，不需要额外绑核。

两份的 extraArgs 都带官方采样五件套 `--temp 1.0 --top-p 0.95 --top-k 20 --min-p 0
--presence-penalty 1.5`。依据见第十一章与 `references/llm-deploy.md`；
旧单模型回滚备份 `config.json.bak-tune20260812`。

---

## 二、性能实测

### 主模型 Qwen3.6-35B-A3B IQ4_XS（16.50 GiB，34.66B 参数）

| | pp128 (prompt) | tg32 (生成) |
|---|---|---|
| **CUDA** | **282.04 ± 12.78 t/s** | **28.82 ± 0.72 t/s** |
| CPU（10 线程） | 26.95 t/s | 10.28 t/s |
| 倍数 | **10.5×** | **2.8×** |

### ★ 开 Flash Attention + KV q8_0 后（2026-08-12 起的生产配置）

真实 API 实测，上下文 128K：

| prompt 长度 | prompt 处理 | 生成 | 总耗时 |
|---|---|---|---|
| 1173 tok | **571 tok/s** | 35.8 tok/s | 2.2 s |
| 9223 tok | **655 tok/s** | 33.3 tok/s | 13.2 s |
| 27623 tok | **622 tok/s** | 28.4 tok/s | 30.7 s |

**对比开 FA 之前**：prompt 处理 282~385 → **571~655 tok/s（约 2 倍）**，生成 29~31 → **33~36 tok/s**。
`-fa on` 在 qwen35moe 这种 linear+full 混合架构上**工作正常**，此前文档里"等实测确认"的悬念到此关闭。

> ★ 上表是 ub=512 时代的数字。**2026-08-12 调优（ub=1024 + ngram）后的现役数字**：
> prompt 处理 800@4K / 744@32K / 742@64K tok/s，生成 48@4K / 23@32K tok/s，
> 复述型任务最高 125 tok/s。详见第十一章。

**内存代价**：ctx 32K→128K 且 KV 换 q8_0 后，`available` 从 3247 MiB 降到 **2455 MiB**（-792 MiB）。
KV 是启动时预分配的，所以这个数字已经包含满上下文的开销，不会再随对话增长。

### ⚠ 网上的「128K MoE 生产推荐参数」有几条对这块板子有害

2026-08-12 检索到的主流建议是给 H100/A6000 那类**独立显存**机器写的，直接照抄会更慢：

| 建议参数 | 这块板子上的判断 |
|---|---|
| `--n-cpu-moe 4`（把部分 expert 放 CPU 省显存）| **有害**。Orin 是统一内存，权重本来就在同一块 DRAM 里，挪到 CPU **一个字节都省不下**，只会把算力从 30 tok/s 的 GPU 换到 10 tok/s 的 CPU。它解决的是"显存装不下但内存装得下"，这个前提在统一内存架构下不存在。 |
| `--rope-scaling yarn --yarn-ext-factor 1.0` | **不要加**。模型 `n_ctx_train=262144`，我们要的 128K 还在训练长度**以内**，不需要外推。无谓地开 YARN 只会损失短上下文质量。 |
| `--numa distribute` | 无意义，单路 SoC 没有 NUMA 节点。 |
| `-t 0`（自动线程）| 不要。需要显式控制以避开 isolcpus 隔离的 CPU5。 |
| `--n-parallel 16` | 内存不允许。并发数直接乘 KV 占用，这里只有 1。 |
| `--log-disable` | 不要。板子没有串口，日志是主要排障手段，省那点 IO 不值。 |
| `--flash-attn` + `--cache-type-k/v q8_0` | **采纳，实测有效**（见上表）。这是整份建议里真正适用的部分。 |

教训：**照抄配置前先问"它解决的问题在我这儿存在吗"**。统一内存、无 NUMA、
训练长度 256K、单并发——这四条把大半"最佳实践"筛掉了。

### 线程数：CUDA 后端下 4 和 11 没有区别【实测】

`ngl=99` 时 40 层全在 GPU，CPU 只做采样、tokenize 和调度，加线程无处可用：

| 场景 | threads=4 | threads=11 |
|---|---|---|
| prompt 1173 tok | 571.2 t/s | 573.1 t/s |
| prompt 9223 tok | 654.7 t/s | 655.0 t/s |
| prompt 27623 tok | 621.8 t/s | 622.2 t/s |
| 生成（长上下文）| 28.4 t/s | 27.3 t/s |

差异 ±0.3%，在噪声范围内，生成还略降。**所以 threads=4 不是没榨干 11 个核心，
而是 CUDA 路径下这 11 个核心本来就没活干。**「11 核可用」是 CPU 后端的说法
（那时候 threads 该设 10~11，并且要用 `cpuList` 避开被 isolcpus 隔离的 CPU5）。

真实 API 对话：**29~31 tok/s**（长期混合负载下 26.5 tok/s）。
prompt 提升远大于生成，因为生成受内存带宽限制而非算力。tg 28.8 t/s 换算等效带宽约
46 GB/s，离 Orin 标称 204.8 GB/s 尚远，**说明还有调优空间**（细粒度 MoE 的 kernel 效率）。

### CPU 后端线程配置（若需回退）

| 配置 | tg32 |
|---|---|
| `taskset -c 0-4,6-11` + 11 线程 | **10.54 t/s** ← 最优 |
| 不绑核 10 线程 | 10.09 |
| 不绑核 12 线程 | 4.79 |
| `taskset -c 0-11` + 12 线程（含 CPU5） | **1.67** ← 最差 |

**被 `isolcpus=5` 隔离的 CPU5 绝不能用于推理**，详见 evidence-levels.md。

### Embedding（Qwen3-Embedding-0.6B f16，1024 维）

板上：短文本 33.5 ms、长文本 314 tok/条 63 ms → **4400~8500 tok/s**。
横向对照（同一模型文件，从 PC 侧同时测）：比 `__ROUTER_IP__00:11434` 的 LM Studio 快
**10~64 倍**。但**该对照不能当硬件性能结论**——对方的 GPU offload 配置未知，
37 秒/16 条更像纯 CPU 推理。

### 多模态【实测确认】

`--mmproj mmproj-F16.gguf` 生效，`/v1/models` 返回 `capabilities:["completion","multimodal"]`。
拿板上真实摄像头标定图（`/opt/m0/calib_shadow/.../calib1_group28_patch7_camera4.jpeg`）测试，
正确识别为"自动驾驶或计算机视觉算法的测试/演示"。图片编码成 441 prompt token，
生成 300 token 用 56 秒（CPU 后端时的数据，CUDA 下未单独复测）。

### 热与稳定性

**2026-08-12 用户加装风扇，这个问题已解决。**

| | 无风扇（2026-08-11）| **有风扇（2026-08-12）** |
|---|---|---|
| 空载 | 62~66°C | 49~54°C |
| 持续推理负载 | 9 分钟 66.0 → **87.4°C 仍在爬升** | 140 秒 60.9 → **64.7°C，波动走平** |
| GPU-therm 峰值 | — | 74.3°C |
| 稳态判断 | 外推【估算】90~95°C | **实测 tj 60~65°C** |
| 降频 | 无（2009.6 MHz）| 无（2009 MHz）|

**降幅超过 20°C，且明确走平**（不再是单调上升）。Orin 硬件 throttle 点通常 105°C，
现在余量充足。此前"加载态稳态温度未知""散热是否够用"两条未决项到此关闭。

---

## 三、内存预算（这是本项目最容易踩坑的地方）

### 实测各项占用

```
系统总内存                    28.73 G
系统底噪（所有 LLM 服务停）    4.58 G
主模型 ctx32768/parallel1     16.40 G   （cache-ram=256 时的净值）
embedding 5 并发 × 4096        4.87 G
embedding 3 并发 × 4096        4.01 G
embedding 2 并发 × 4096        3.59 G
embedding 5 并发 × 2048        3.83 G
```

**注意：5→2 并发只省 1.28 G**。0.6B 模型的权重和 CUDA context 是固定开销，KV 占小头。

⚠ **上表是 2026-08-11 的测量，「当前采用」那一档已经过期**：向量服务于 2026-08-12
连同 `--cache-ram 64→0` 一起降到 **`--parallel 1`**（省 837 MB，nvmap 3.27→2.45 GiB），
2026-08-13 又整体换到 CPU 档。**这里说的是向量服务自己的服务端槽位数，
与调用方该开几路并发无关**——2026-08-21 有人把这一档误读成"板端并发 2 是上限"
并据此设置调用方并发，见陷阱 68。

### 当前生产配置的稳态

```
空载        available 3.6 G
25 轮对话后 available 2.97 G（第 10 轮起完全不动）
混合负载    available 3.0 G，GPU 可分配 2.97 G
```

### ★ `--cache-ram` 是必须设的，默认值会吃光内存

`llama-server` 的 **`-cram / --cache-ram` 默认 8192 MiB**，即 prompt cache 池上限 8 GiB。
在这块 28 GiB 的板子上，默认值会让 RSS 持续增长直到逼近 OOM。

实测（24 轮请求）：

| cache-ram | RSS 增长 | 行为 |
|---|---|---|
| 8192（默认） | +2.88 G 且**继续涨** | 单轮 123 MB，线性不收敛 |
| 1024 | +1.08 G 后**完全平** | 第 12/18/24 轮数字一模一样 |
| 0 | +0.09 G | 几乎不涨，但丢失前缀复用加速 |

**这不是内存泄漏，是缓存池按上限正常填充。**

**生产值 1024 MiB**（2026-08-12 从 512 上调，实测撑到溢出后可用内存稳定在 **1.54~1.66 GiB**，
守护线 0.35，余量充足）。收益实测：同一份 8.7K tokens 的长输入，命中缓存后
**14.5 秒 → 1.0 秒**；512 时长对话状态频繁 `exceeds cache size limit ... skipping`，
1024 之后改为正常淘汰最旧条目。再往上调之前先看 `MemAvailable`：
这块板子没有 swap，且多模态请求会临时吃内存，别让稳定水位低于 1 GiB。

**这条是本轮最大的一次误判**：从"线性增长 + drop_caches 不回收 + PSS 也在涨"
推断成内存泄漏，做了四组对照实验（mmproj/ctx/后端/CUDA graph）都无果，
最后查 `--help` 才发现是配置默认值。**遇到内存持续增长，先花 10 秒查有没有配置上限，
再怀疑泄漏。**

帮助文本的准确语义（板上实测）：`-cram, --cache-ram N`，
**默认 8192，`-1` 无限制，`0` 关闭**。

#### Embedding 服务应该把它关掉（2026-08-12）

推理服务需要这个池子（多轮对话前缀可复用），**Embedding 不需要**：
每段待编码文本的前缀都不一样，命中率接近零，池子只会占内存，
还会不断刷 `prompt state size 91.667 MiB exceeds cache size limit 64.000 MiB, skipping`。
连同并发 2→1 一起改，实测**省 837 MB**（nvmap 3.27 → 2.45 GiB），
单条编码耗时不变（16~56 ms 端到端）。并发降到 1 之后请求排队即可——
单人使用场景下，第二条请求最多多等几十毫秒。

### 内存守护（兜底，阈值已三次下调）

| 时间 | 阈值 | 它造成了什么 |
|---|---|---|
| 初版 | soft 4.0 GiB | embedding 启动的正常波动就误触发重启，污染了一次内存测量 |
| 第二版 | soft 1.8 / hard 1.0 | **WeKnora 的 RAG+ReAct 跑到一半被重启**，任务 context deadline exceeded |
| **现行** | **soft 0.35 / hard 0.2** | 另加：**5 分钟内有过推理请求就绝不重启** |

关键认识：**`/slots` 显示空闲 ≠ 任务结束**。ReAct / RAG 是多轮调用，轮次之间必然有间隙，
那一刻 slot 就是 idle 的，按它重启会把整条链打断。所以面板现在记录最后一次代理请求的时间戳
（`GUARD.lastProxyAt`，`/v1`、`/v1-fast`、`/llm`、`/embed` 四条路径都记），静默满 5 分钟才允许动手。

而且守护存在的前提已经不成立了：KV 按 ctx 在启动时**预分配**、`cacheRamMiB` 封顶 1024，
内存有确定上界，不会无限增长。它现在只防真正的 OOM 死机——板子没有远程上电手段，
系统真卡死只能物理断电，所以保留 0.2 GiB 这道底线。

面板内置，参数在 `panel/server.js` 的 `GUARD`：
`available < 1.8 GiB 且连续 3 次采样确认且服务空闲` → 重启 `llm-server`；
`< 1.0 GiB` → 强制重启。服务启动后 5 分钟宽限期内不干预。

阈值最初设 4.0 GiB，**结果 embedding 一启动造成的正常波动就误触发了重启**，
还污染了一次内存测量（出现"embedding 净增 -6.73 G"的荒谬数据）。设了
`cache-ram` 上限后内存本就不会无限涨，守护只是兜底，门槛必须压低。

---

## 四、交叉编译：完整可复现流程

宿主 **WSL2 Ubuntu 20.04 x86_64**（16 核）。脚本在 `../../deploy/build/`，
同步到纯 ASCII 路径 `<你的模型目录>\build\` 后用 `wsl -d Ubuntu-20.04 -u root bash <你的模型目录>/build/xxx.sh` 执行
（中文路径在 WSL 里易出编码问题；脚本必须转成 LF）。

### 为什么必须 Ubuntu 20.04

`gcc-aarch64-linux-gnu` 的目标 sysroot 跟随宿主发行版：20.04 → **glibc 2.31 / gcc 9.4**，
与板子严丝合缝。22.04(2.35)/24.04(2.39) 编出来的会重蹈官方预编译版覆辙
（`GLIBC_2.38 not found`）。实测产出的二进制最高只需 **GLIBC_2.17**。

### 依赖

```bash
apt install gcc-aarch64-linux-gnu g++-aarch64-linux-gnu ninja-build
apt install cuda-nvcc-12-1                   # ★ host 侧 nvcc 本体（x86_64 repo）
apt install cuda-cross-aarch64-12-1          # aarch64 目标的库+头文件（cross repo，见下）
# cmake ≥3.18（20.04 自带 3.16 不够，装了 3.30.5）
```

**★ 两个包在两个不同的 NVIDIA repo 里，必须都加源**（2026-08-13 踩坑：只加 x86_64 源时
`apt install cuda-cross-aarch64-12-1` 报 `E: Unable to locate package`）：

| 包 | repo |
|---|---|
| `cuda-nvcc-12-1` | `.../repos/ubuntu2004/x86_64/` |
| `cuda-cross-aarch64-12-1` | `.../repos/ubuntu2004/`**`cross-linux-aarch64/`** |

```bash
wget https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2004/x86_64/cuda-keyring_1.1-1_all.deb
dpkg -i cuda-keyring_1.1-1_all.deb           # 装 GPG key，两个 repo 共用
echo "deb [signed-by=/usr/share/keyrings/cuda-archive-keyring.gpg] \
https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2004/cross-linux-aarch64/ /" \
  > /etc/apt/sources.list.d/cuda-cross-aarch64.list
apt update
```

cross repo 里的包一律带 `-cross-aarch64-` 中缀：`cuda-cudart-cross-aarch64-12-1`、
`libcublas-cross-aarch64-12-1`、`cuda-nvcc-cross-aarch64-12-1` 等；
`cuda-cross-aarch64-12-1` 是把它们全拉齐的 meta 包。
**清华的 `nvidia-cuda` 镜像实测 403，只能走 NVIDIA 官方源**（国内直连约 5 KB/s，需要代理）。

CUDA 版本选 **12.1**，因为 `cuDriverGetVersion()` 实测返回 **12010**，精确匹配不赌兼容性。

### 没有 WSL 时的替代：在任意 x86_64 Docker 机器上编译

宿主发行版不必是 20.04，**用 `ubuntu:20.04` 容器即可**（决定 aarch64 sysroot glibc 版本的是
容器里的 `gcc-aarch64-linux-gnu`，不是宿主）。2026-08-13 在 你的宿主机 LXC（Ubuntu 22.04）上
用这个办法搭成。Dockerfile 与构建脚本见 `deploy/build/`。
⚠ 别改 LXC 的 `/etc/docker/daemon.json` 或重启 dockerd——那会波及上面 6+ 个业务栈；
容器内需要代理时用 `docker build --build-arg http_proxy=...` 传，不碰 daemon。

### 五个坑（都实际踩过）

1. **`cuda-nvcc-cross-aarch64-12-1` 不含 nvcc 本体**。包描述是 "dev links, headers"，
   编译器在 `cuda-nvcc-12-1`（x86 host 版）里。**两个包都要装**。
2. **CUDA 12 没有 `--target-dir`**（那是 11.x 写法）。实测**只要 `-ccbin aarch64-linux-gnu-g++`**，
   nvcc 12.1 就自动产出 aarch64 目标，不需要任何额外目标选项。
3. **`-DGGML_STATIC=ON` 会链接失败**：它执行 `add_link_options(-static)`，把非 PIC 的
   `libc.a` / `libgomp.so` 往 `.so` 里塞 →
   `relocation R_AARCH64_ADR_PREL_PG_HI21 against '__stack_chk_guard'`。
   **解法：patch 掉 `ggml/src/CMakeLists.txt` 里那行 `add_link_options(-static)`，
   保留 GGML_STATIC 的"选静态 CUDA 库"逻辑**——这是必须的，因为 aarch64 cross 包
   **只提供 `libcublas_static.a` 和 `stubs/libcublas.so`，没有 `libcublas.so.12` 真库**。
4. **`-DLLAMA_CURL=OFF` 必须加**，否则链 OpenSSL 3，板上只有 1.1，运行报 `libssl.so.3` 缺失。
5. **运行时 `LD_LIBRARY_PATH` 第一项必须是二进制自己的目录**。llama.cpp 拆成了
   `libllama-*-impl.so`/`libggml*.so`，交叉产物没有 `$ORIGIN` RPATH。

### 验收标准（实测通过）

```
objdump -T llama-cli | grep GLIBC_ | sort -uV | tail   → GLIBC_2.17（板上 2.31，稳过）
readelf -d libggml-cuda.so | grep NEEDED               → 只有 libcuda.so.1，无 libcudart/libcublas
```
CUDA 运行时全部静态链入，板上只依赖驱动 `libcuda.so.1`。

---

## 五、GPU / 驱动事实【实测确认】

```
cuDriverGetVersion → 12010  =>  CUDA 12.1
Device 0: Orin, compute capability sm_87, 16 SM, 1.275 GHz, L2 4 MiB
total mem 28.73 GiB, integrated=1, unifiedAddressing=1, managedMem=1, concurrentManaged=0
```

用 `dlopen("libcuda.so.1")` + `dlsym` 直接问驱动（源码 `scripts/cudaprobe.c` 思路，
zig 一行交叉编译：`zig cc -target aarch64-linux-gnu.2.31 cudaprobe.c -o cudaprobe`），
**不需要 CUDA toolkit 也不需要 nvcc**。CUDA 12 独有符号全部 dlsym 成功。

**`concurrentManaged=0`** → Orin 不支持并发托管内存访问。曾据此怀疑
`GGML_CUDA_ENABLE_UNIFIED_MEMORY=1` 造成泄漏，实测**该假设错误**（去掉后 nvmap 稳定但
系统 used 照涨），但仍不该开这个变量——Orin 本就是统一内存，没有"回落"这回事。

### 5.1 llama.cpp 用的是 CUDA 12.1，升级到 12.2 没有收益【2026-08-16 复核，A-161】

**先记住三个容易搞错的事实**：

| 问题 | 答案 | 怎么查的 |
|---|---|---|
| llama.cpp 用哪个 CUDA 编的 | **12.1** | `deploy/build/1-setup-wsl.sh` 的 `CUDA_VER=12-1` |
| 为什么 `ldd` 看不出版本 | **CUDA 运行时是静态链接的** | `libggml-cuda.so` 只链 `libcuda.so.1`；753 MB 体积即由此而来 |
| ggml 用不用 INT8 张量核心 | **用**，MMQ 内核里有 8 处 IMMA 指令 | 拉 `ggml/src/ggml-cuda/mma.cuh` 源码，搜到 `mma.sync.aligned.*.s32.s8.s8.s32` |

**升级到 12.2 不会提速，三条依据**：

1. **源码门槛已全部越过**。`common.cuh` 与 `mma.cuh` 的条件编译最高是
   `CUDART_VERSION >= 11080`（CUDA 11.8）。12.1 已满足全部门槛，
   **升 12.2 不解锁任何新代码路径**。
2. **生成阶段是内存带宽受限**。A3B 每 token 激活约 3B 参数，IQ4_XS 下约 1.6 GB；
   35.5 tok/s × 1.6 GB ≈ 57 GB/s，与 A-53 的等效带宽 41~57 GB/s 吻合。
   换编译器不改变内存带宽。
3. **热路径不是 cuBLAS**，是 ggml 自己的 MMQ 内核，cuBLAS 版本影响很小。

可能有收益的只有 prefill（计算受限），但它已经 665 tok/s，不是瓶颈。
代价是重新交叉编译整套。**结论：不做。**

⚠ **方法论**：这个问题上搜索给的"升级提速 5~15%"结论 `primary_sources` 为空，
是 A-143 记过的幻觉特征，未采信。改为直接拉 GitHub raw 读条件编译门槛——
**版本门槛这类问题，源码是唯一可判定的证据。**

llama.cpp 自己也把它识别为 UMA：
`ggml_backend_cuda_get_available_uma_memory: 26337224 KB`，报的 "VRAM 29415 MiB" 就是系统内存。

---

## 六、模型账目：Qwen3.6-35B-A3B

架构（读 HF `config.json`，非推断）：

```
architectures: Qwen3_5MoeForConditionalGeneration    model_type: qwen3_5_moe
llama.cpp 对应 LLM_ARCH_QWEN35MOE ("qwen35moe")，已支持
num_hidden_layers 40，其中 full_attention 仅 10 层（full_attention_interval=4），
  其余 30 层是 linear_attention
hidden_size 2048   head_dim 256   num_attention_heads 16   num_key_value_heads 2
num_experts 256    num_experts_per_tok 8   moe_intermediate_size 512   ← 极细粒度
vocab_size 248320  max_position_embeddings 262144
mtp_num_hidden_layers 1（llama.cpp 目前不用）
pipeline_tag: image-text-to-text  ← 多模态
```

**KV cache 只有 20 KB/token**（10 层 × 2 kv_head × 256 dim × 2 × 2B）：

| 上下文 | F16 KV |
|---|---|
| 32K | 640 MB |
| 128K | 2.5 GB |
| 256K | 5.0 GB |

所以**"KV cache 压缩"在这个模型上收益很小**，真正吃内存的是权重和 prompt cache 池。

**GGUF 档位**（源：`unsloth/Qwen3.6-35B-A3B-GGUF`，ModelScope 有镜像且更快）：
IQ4_XS 16.51 / Q4_K_S 19.46 / MXFP4_MOE 20.22 / Q4_K_M 20.61 / Q4_K_XL 20.82 GiB。
**当前用 IQ4_XS**（质量与 Q4_K 相当甚至略优，省 4.3 GiB）。
mmproj 只有 BF16/F16/F32 三档，**没有量化版**，F16 840 MB —— 视觉塔不在解码热路径上，
量化它收益接近零。

**Qwen3.6 默认走 thinking 模式**：`max_tokens` 给小了会发现 `content` 为空、
内容全在 `reasoning_content` 里且被截断。用 `chat_template_kwargs:{enable_thinking:false}` 关闭。

---

## 七、开机自启与持久化【断电重启实测通过】

```
iecu-lan-ip.service    enabled   __BOARD_LAN_IP__/24 on eth.254
iecu-panel.service     enabled   :9000
llm-server.service     enabled   :8080   Conflicts=application_start.service
llm-embedding.service  enabled   :8081
application_start      disabled  ← 智驾栈已关闭开机自启
```

断电重启实测（2026-08-11）：**全部通过**。IP 自动恢复、四服务自动拉起、
智驾栈没有回来、推理冒烟通过。**冷启动 42 秒**（systemd 拉起 → `model loaded`，
16.5 GiB 从 eMMC 真读一遍），热缓存时 12 秒。

**副作用**：板子 RTC 无电池保持也无 NTP，**断电后系统时间会跳回过去**
（实测从 Aug 07 跳回 May 16）。排查问题请用 `uptime` 和 journal 的相对顺序，别信 `date`。

**恢复车机模式**：面板上点"切到车机模式"，或
`systemctl disable --now llm-server && systemctl enable --now application_start`。
`application_start.service` 的 `RequiredBy` 为空、无其他 unit 依赖它，disable 是安全的。
**停智驾栈用 `systemctl stop`，不要用 `pkill`**——前者走 cgroup 正常停止，
后者会让 service 留在 failed 状态。两者都不会碰到会导致整机关机的
`/app/shutdown_service.sh kill`（该 unit 没有 ExecStop）。

---

## 八、网络

```
eth (MGBE3, 6b10000.ethernet)  Port: MII  Speed: 10000Mb/s  MTU 1466
  └─ 16 个 VLAN 子接口，eth.254 上有 172.31.254.38/24 + __BOARD_LAN_IP__/24
默认路由 via __HYPERVISOR_GATEWAY__ dev eth.8（内部虚拟网关，故意不改）
```

**`Port: MII` 意味着这不是接物理网线的 PHY，而是 MAC 直连板载交换芯片 88Q6113**
（固件 `88Q6113_SW046_V4.2_20230703.bin`，不是之前记的 88Q5072）。
所以 "10000Mb/s" 是 Tegra↔交换芯片的内部链路速率，**与插哪个外部物理口无关**。
外部口的 VLAN 归属由 Aurix 配置的交换芯片决定，Tegra 侧 `status=disabled` 看不到也改不了。
**换插万兆口不会提速，只会赌那个口是否承载 VLAN 254 —— 赌输就失联，而板子没有串口。**

**MTU 1466【实测确认】**：`ping -M do` 实测 payload 1438B(总 1466)通过、1450B 不通。
对 TCP 无影响（握手协商 MSS=1426），只影响 UDP 大包和 PMTU 黑洞场景。

**板子不跑任何 DHCP 客户端**（dhclient/dhcpcd/udhcpc/NetworkManager 全无，
systemd-networkd 虽 active 但 eth 是 `unmanaged`）。所以路由器上的静态 DHCP 绑定
**不会生效也不需要**；但要确保 DHCP 池不覆盖 `.15`，否则可能派给别的设备造成冲突。

### 局域网接入实测（2026-08-12）★通过

板子已接入路由器（**仍用原来那个网口**）。从 PC 实测：

| 项 | 结果 |
|---|---|
| `__BOARD_LAN_IP__:9000 / 8080 / 8081` | 三个端口 TCP 全通 |
| SSH + SFTP over `__BOARD_LAN_IP__` | 正常，`push.js`/`exec.js` 直接用 |
| `/v1` 聚合端点端到端 | 对话 30.9 tok/s、向量 1024 维、模型列表合并，全部 200 |

日常把 `IECU_HOST` 指到 `__BOARD_LAN_IP__` 即可。
（此前直连网线时 `__BOARD_LAN_IP__` 从 PC 不通，是因为 PC 的 WLAN 也在 192.168.1.x，
路由表把该地址走了无线而非直连网线——不是板子的问题，接同一物理网段后自然消失。）

**板子无外网**（默认路由指向内部虚拟网关）。所有文件从 PC 经 SFTP 推。

---

## 九、工具脚本（`../scripts/`）

| 脚本 | 用途 |
|---|---|
| `probe.js` | 只读批量采集（断点续跑+重连+增量落盘）|
| `dump.js` | probe 输出按 group 拆成可读文本 |
| `push.js` | 单文件 SFTP 上传（30~100 MiB/s）。**默认整传 + 传后校验字节数**；`--resume` 才断点续传 |
| `pull.js` | 目录递归下载，**带排除/大小上限/文件名百分号编码**，只读远端 |
| `exec.js` | 远程执行，**实时流式输出**；`--file` 模式喂脚本给 `bash -s`，零引号套娃 |
| `thermal-monitor.js` | 温度/负载持续采样 CSV |

`pull.js` 的两个陷阱都已内建防护，见 evidence-levels.md：
稀疏文件（Docker devicemapper 100 GiB 空洞）、Windows 非法文件名（Linux 侧的冒号）。

`push.js` 的续传陷阱（2026-08-12 踩到，面板因此挂掉）：旧版默认续传，判据只有文件大小。
覆盖一个已存在的**不同**文件时，会从远端旧文件末尾偏移开始写，拼出「前半旧 + 后半新」的
嵌合体；大小恰好相等时更是直接 SKIP，一个字节没传却报 OK。两种都不报错。
现已改为默认整传并在传完后 stat 校验字节数。**"本地测好的代码上板就崩"，先查传输。**

---

## 十、可观测性：llama-server 到底能读到什么【2026-08-12 实测】

**先说结论：网上文章里的字段名基本都对不上，一律以 `curl` 实际返回为准。**

### `/metrics`（Prometheus 文本，14 个指标，前缀 `llamacpp:`）

```
llamacpp:prompt_tokens_total / prompt_seconds_total          累计（counter）
llamacpp:tokens_predicted_total / tokens_predicted_seconds_total
llamacpp:prompt_tokens_seconds / predicted_tokens_seconds    瞬时速度（gauge）
llamacpp:requests_processing / requests_deferred             处理中 / 排队
llamacpp:n_decode_total / n_tokens_max / n_busy_slots_per_decode
llamacpp:spec_decode_num_draft_tokens_total / _accepted_tokens_total / _drafts_total
```

**不存在**：`llama_kv_cache_usage_ratio`、`llama_slots_total`、`llama_ttft_seconds`、
`llama_request_duration_seconds`——这些是检索结果里编出来的。

- **速率要自己做差分**：累计量除以累计耗时得终身平均；相邻两次采样做差得瞬时速率。
  **差分的分母要用服务端的累计秒数，不要用墙上时间**——空闲时墙上时间在走而模型没在算。
- **KV 使用率要自己算**：`/slots` 的 `n_prompt_tokens + next_token[0].n_decoded` ÷ `n_ctx`。
- **缓存命中率也要自己算，而且不能用 `n_prompt_tokens_cache`**：从 `--cache-ram` 池恢复
  状态时那个字段仍然是 0，只有 `n_prompt_tokens_processed` 会变小。
  正确公式 `(n_prompt_tokens − n_prompt_tokens_processed) ÷ n_prompt_tokens`。
  实测一次命中：8696 / 0 / 4，旧公式显示 0%，实为 100%。
- **KV 每 token 开销实测约 17.9 KB（q8_0）**，别按层数纸面推算。取值方法：
  日志里把 `release: ... n_tokens = N` 和紧随其后的 `prompt state size X MiB` 配对，
  六组样本落在 16.2~21.6 KB。面板此前按 10 KB 算，界面上少报了四成。

> ⚠ **`--metrics` 只对生成服务有效。**
> Embedding 服务即使加了 `--metrics`，`prompt_tokens_total` 与 `prompt_seconds_total`
> 也**恒为 0**——那两个计数器只在生成路径累加，编码请求不经过；会动的只有
> `n_decode_total`（解码批次数）和 `n_tokens_max`。**不加 `--metrics` 则整个端点回 501**，
> 两种情况在面板上都表现为"统计全空"，别把它们混为一谈。
> 编码用量的正确来源是响应体自带的 `"usage":{"prompt_tokens":N}`（实测在第 48 字节），
> 面板 `proxyEmbed()` 转发时嗅探前 512 字节取走，不缓存整个 20 KB 的向量响应。

### `/slots`（JSON 数组，每个处理位一项）

有用的字段：`n_ctx`、`is_processing`、`id_task`、`n_prompt_tokens`、
**`n_prompt_tokens_cache`（前缀缓存命中数）**、`n_prompt_tokens_processed`（真正要算的）、
`next_token[0].n_decoded`、`params.*`（该请求实际生效的采样参数与 `reasoning_format`）。
**没有** `timings` 对象。

### `/props`（JSON，实际生效的配置）

`model_path` / `model_alias` / `model_ftype` / `total_slots` /
`default_generation_settings.n_ctx` / `.params.*` / **`modalities`（本模型 vision+video 均为 true）** /
`endpoint_slots` / `endpoint_metrics`。面板用它做「配置值 vs 运行值」对照——
只显示 config.json 的话，改完根本不知道有没有生效。

### 首 Token 延迟（TTFT）

llama.cpp 不提供，**只能在反向代理层量**：记录"请求转发出去"到"上游第一个字节返回"。
面板在 `proxyWithBody` 里做，保留最近 120 条，算 P50/P95。
**只对流式请求有意义**——非流式的第一个字节在生成完毕时才出现，那是总耗时不是 TTFT。

实测两个数量级参考（`-nothink` 变体、短 prompt）：**TTFT 230~350 ms**，
生成 260 tokens 总耗时约 7~8 秒。而 NewAPI / WeKnora 这类调用方默认非流式，
样本池里可能一条流式都没有，所以面板在没有流式样本时改显示总耗时的 P50/P95。

### 硬件占用怎么读（容易读反）

- **`GR3D_FREQ` 高不代表算力饱和**：生成时长期 94~99%，但按激活参数量反推的等效带宽
  只有约 50 GB/s（标称 204.8）。这个计数器把"等内存返回"的时间也算作 busy。
- **`EMC_FREQ` 在这块板子上永远是 `@0`**，没有百分比也没有频率，满载采样同样如此。
  内存带宽占用采不到，面板已撤掉该指标；要定论只能自己写 CUDA 带宽基准。
- **两个服务并发的实际影响很小**（同 GPU 时间片轮转，非阻塞）：
  编码 31 ms → 45 ms，生成 31.53 → 30.90 tok/s。RAG 场景下先查向量再调 LLM 是安全的。

### 日志句式

`slot print_timing` 既是周期性进度行（`n_decoded = N, tg = N t/s`）又是汇总行
（`prompt eval time = ...`），消息体里还嵌了一层自己的时间戳与级别（`555.03.812.604 I `）。
写解析规则前先用 SKILL 认知陷阱第 24 条那条采样命令把句式列全。

两条最值得关注的日志（以前完全被埋没）：

```
srv alloc: - making room for prompt cache entry, removing oldest entry (size = 380 MiB)
srv alloc: - prompt state size N MiB exceeds cache size limit 512 MiB, skipping
```

第一条是池满后的正常淘汰，第二条表示这次状态**大到根本存不进去**。
128K 上下文下单条状态就有一两百 MB，512 MB 时长对话经常直接命中第二条；
2026-08-12 上调到 1024 MiB 后第二条消失，只剩正常淘汰。

---

## 十一、提速：2026-08-12 调优定稿（全过程见 `references/llm-deploy.md`）

### 1. 已落地的生产配置与实测收益

```
batchSize=2048  ubatchSize=1024                    ← 预填充 +19%，decode@4K +59%
extraArgs: --spec-type ngram-mod                   ← 零内存投机解码，复述型任务最高 125 t/s
           --temp 1.0 --top-p 0.95 --top-k 20 --min-p 0 --presence-penalty 1.5
                                                   ← 官方模型卡思考档推荐值（MoE 版 presence=1.5）
面板对 -nothink 别名注入 temp0.7/top_p0.8（客户端显式传参优先）
回滚备份：/var/lib/llm/config.json.bak-tune20260812
```

实测：预填充 800 t/s@4K / 744@32K / 742@64K（深度衰减仅 −9%）；decode 48 t/s@4K、
23@32K（长上下文是 KV 扫描带宽墙，调参无效）；池满 + 双服务可用内存 1.3~1.8 GB。

**ubatch 的三条实测规律**（A-68/A-69）：512→1024 预填充 +20%、1024→2048 只 +7%、
4096 反降；**decode 跟着 ubatch 走**（1024/2048 时 48，512/4096 时 30，机制未拆）；
ub2048 会让池满后可用内存贴近守护线（0.62 GB），所以生产取 1024。

### 2. KV 复用现状与限制（A-70~A-72）

- 追加式复用（多轮对话）与缓存池热切换（≤8 万 token 会话切回 0.13 秒）正常。
- **中段任何分叉都全量重算**：DeltaNet 混合架构不支持 KV 搬移（`cache_reuse
  not supported by this context`，与 mmproj 无关），检查点加密（`-cms 2048`）也救不了。
  RAG 侧对策：固定前缀放最前、检索结果排序确定化。
- **slot save 可用、restore 是上游 bug**（#26676，板上复现：报成功实际失效还破坏缓存池）。
  磁盘条件已具备（顺序读 541 MB/s，423MB 快照存取 0.3/0.2 秒），**等升级 llama.cpp
  修复后再启用**——届时 117K 会话跨重启恢复约 4 秒 vs 重算 2.8 分钟。
- KV 放 swap 判死：decode 每 token 全量扫 KV，必抖动 + eMMC 磨损。

### 3. 已判死的路线（证据链在 tuning 报告，不要重查）

- **换引擎**：TRT-LLM 从未支持 TRT8.6/CUDA11.4（v0.5 的 `>=8.6` 是虚标），Qwen3 MoE
  支持始于要 CUDA12.8 的 v1.0.0；DRIVE OS 的 CUDA/TRT 官方确认不可单独升级（Tegra
  的 forward compat 只到 CUDA 12.2 且仅 Jetson 适用）；DriveOS LLM SDK 排除 Orin 与
  DRIVE OS 6 且无 MoE；vLLM/SGLang/ExLlama 倒在 aarch64+CUDA11 的 torch 上限 2.1.0a0；
  CTranslate2 无 MoE；MLC-LLM 的 prefill 比 llama.cpp 慢 1.5~2 倍。同硬件 TRT-LLM
  预填充优势实测约 1.7~1.8 倍、decode 打平——即使能跑也够不上"奇效"。
- **经典 draft 模型投机解码**：A3B 极稀疏 MoE 批量验证放大专家读取，RTX3090 同款模型
  19 组配置全部负收益（接受率 100% 仍亏）；Qwen3-0.6B/1.7B 词表(151936)≠本模型(248320)，
  llama.cpp 词表检查直接拒启。
- llama.cpp 的 MMQ 已在用 INT8 tensor core（源码级确认），SmoothQuant 边际小；
  sm_87 无 FP8；DLA 无矩阵乘且不支持动态维度，LLM 用不上。

### 4. 还开着的口子

- **MTP（用户决策项）**：唯一证实正收益的投机路线（同类统一内存设备 1.18~1.28×，
  `--spec-draft-n-max 2`），build 已支持 `--spec-type draft-mtp`。代价：换
  `unsloth/Qwen3.6-35B-A3B-MTP-GGUF`（先核对大小 vs /opt/m0 剩 17G）、**与 --mmproj
  互斥**（丢多模态）、只加速 decode、prefill 还略降。
- **llama.cpp 升级重编译**（交叉编译环境在另一台机器）：restore bug 修复 + 上游
  MoE/CUDA 内核持续优化。
- 量化格式对比（IQ4_XS vs Q4_K_S）：MMQ 原生支持 IQ4_XS，收益存疑，磁盘也紧，搁置。

### 5. 与提速无关的待办

- **备份**：`/opt/m0` 因文件名含冒号中断过，已修 `pull.js`，需重跑补全。
- **生图**：交叉编译环境已就绪，编 `stable-diffusion.cpp` 是顺带的（可用性未验证）。
- **视频输入**：`/props` 显示 `modalities.video = true`，从未实际试过。
