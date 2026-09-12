# llama.cpp 换版本的验收清单

> 起因：2026-08-19 为测 DFlash2 编了 `b10498-5ecbe1ac1`（比生产版 `dd1ea52` 新 143 个提交），
> 实测跑 MTP 反而更快，于是出现「要不要直接转生产」的问题。
> **性能持平或更好只是第一关。** 这块板上有一整圈东西是按当前版本的**真实输出**写死的，
> 换版本要逐项验，不能只看 tok/s。

## 零、为什么不能只看 tok/s

面板、向量服务、上游网关三处都在解析 llama.cpp 的输出：

| 谁 | 依赖什么 | 踩过的坑 |
|---|---|---|
| `deploy/panel/server.js` | `/metrics` 的 `llamacpp:` 字段名、`/slots` 的 `n_prompt_tokens`/`n_decoded`/`n_ctx`/`is_processing`、`/props` 结构 | 陷阱 22：网上文章写的字段名板上一个都不存在，只能 curl 实测 |
| `deploy/panel-ui/src/logtext.js` | llama.cpp 的**日志句式**（做中文化） | 陷阱 24：凭印象写解析规则一定错，真实格式里还嵌了一层时间戳和级别 |
| `run-embedding.sh` | **和推理服务共用同一套二进制** | 换 bin-cuda = 同时换掉向量服务 |
| 上游网关（NewAPI/WeKnora） | `finish_reason=tool_calls`、`reasoning_content`、`-nothink` 别名注入 | 陷阱 14/A-101 |

## 一、性能（必过）

- [ ] **MTP n=2 同法同长度 A/B**，新版 tok/s ≥ 旧版（噪声按 ±5% 算，基线要跑 ≥2 次取范围）
- [ ] prefill（`pp_tps`）不劣化
- [ ] 接受率（`/metrics` 的 `spec_decode_num_accepted_tokens_total` ÷ `_draft_tokens_total`）不劣化
- [ ] **nvmap 与 MemAvailable 最低水位**不劣化（A-108：刚重启的读数没有参考价值，要看压测中的最低点）
- [ ] 模型加载时间不显著变长

判据工具：`node /var/lib/llm/tmp/mtpbench.js <tag> '[["2k",2000,[1]],["8k",8000,[1]]]'`
⚠ **每次请求前缀必须不同**，否则命中 prompt 缓存拿到假数据。

## 二、接口兼容（面板靠它们活着）

- [ ] `/metrics` 的 14 个 `llamacpp:` 指标名逐个比对，**特别是 `spec_decode_num_*`、`n_decode_total`、`prompt_seconds_total`**
- [ ] `/slots` 字段：`n_prompt_tokens`、`n_decoded`、`n_ctx`、`is_processing`
- [ ] `/props`：`model_alias`、`model_path`、`build_info`、`default_generation_settings.n_ctx`
- [ ] `/v1/models` 合并两个后端后仍返回三个条目
- [ ] `/v1/chat/completions` 流式与非流式
- [ ] `/v1/responses`（Responses API）
- [ ] `/v1/embeddings` 响应体开头仍带 `"usage":{"prompt_tokens":N}`（面板的 `proxyEmbed()` 嗅探前 512 字节取它，A-25）

对比方法：新旧各 `curl` 一次，把字段名排序后 `diff`，**不要凭印象说"应该没变"**。

## 三、模型行为

- [ ] 带 tools 的请求返回 `finish_reason=tool_calls`（不是 `length`、tool_calls 不为空）
- [ ] `enable_thinking:false` 注入仍生效（面板 `-nothink` 别名走的就是它）
- [ ] `--reasoning-format deepseek-legacy` 仍被接受，`reasoning_content` 字段照旧
- [ ] `reasoning_effort: low|medium|xhigh` 三档仍可控（q38 档特性，A-163）
- [ ] GGUF 内嵌对话模板行为不变（q38 档不挂外部模板文件）
- [ ] ⚠ 若将来 3.6 档也要升级：`3.6_chat_template-v10.jinja` 的**中文预填那一行**必须还在，改完回归测 tool_calls（陷阱 37）

## 四、★ 向量服务（最容易漏，代价最大）

`run-embedding.sh` 用的是**同一个 `bin-cuda` 目录**，换二进制等于同时换掉向量服务。

- [ ] `CUDA_VISIBLE_DEVICES=` 置空后仍走到「没有可用设备」分支，nvmap 占用归零（陷阱 34）
- [ ] 向量维度仍是 1024
- [ ] **★ 向量数值等价性**：`node embed-fingerprint.js diff <基线>`
      - 基线在旧版上用 `save` 生成
      - 参照 A-88：F16→Q8 那次余弦 **0.9997**、单维最大差 **5.6e-3**，当时判定**必须整库重建**
      - 所以「余弦 0.999 看着很高」不是通过，**判据是 ≥0.999999 且单维差 <1e-5 才算等价**
- [ ] 若不等价 → **建库与查询必须用同一套向量**，要么整库重建，要么不升级

## 五、面板

- [ ] `logtext.js` 的日志汉化规则命中率（陷阱 24 给的采样命令）：
      ```bash
      journalctl -u llm-server -n 800 --no-pager \
        | sed -E 's/^[A-Z][a-z]{2} +[0-9]+ [0-9:]+ [^ ]+ //; s/^[a-zA-Z0-9_.-]+\[[0-9]+\]: //' \
        | sed -E 's/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+ [A-Z] //' \
        | sed -E 's/[0-9]+\.[0-9]+/N/g; s/[0-9]+/N/g' | sort | uniq -c | sort -rn | head -25
      ```
      新版句式若变了，`logtext.js` 要跟着改，否则日志页变成一片未汉化原文
- [ ] 面板各卡片数据不为空（生成速度、上下文、累计用量、峰值）
- [ ] 三档预设切换（mtp / mm / q38）都能起来

## 六、回滚设计（动手前先做）

```bash
# 保留旧版，回滚就是一次 rename
mv /var/lib/llm/llama/bin-cuda /var/lib/llm/llama/bin-cuda-b1-dd1ea52
mv /var/lib/llm/llama/bin-test /var/lib/llm/llama/bin-cuda
systemctl restart llm-server llm-embedding

# 回滚
systemctl stop llm-server llm-embedding
mv /var/lib/llm/llama/bin-cuda /var/lib/llm/llama/bin-test
mv /var/lib/llm/llama/bin-cuda-b1-dd1ea52 /var/lib/llm/llama/bin-cuda
systemctl start llm-server llm-embedding
```

- [ ] 旧二进制**留在板上**（约 800 MB，`/var` 要留够空间），不要只留在 PC 上
- [ ] 记下旧版 build 号：`b1-dd1ea52`（`/props` 的 `build_info`）
- [ ] 升级后第一次断电重启验证：九个 unit 全部自启、模式互斥仍生效

## 七、构建端要记住的两件事

1. **`GGML_STATIC=ON` 与「注释掉 `add_link_options(-static)`」必须成对**，见陷阱 65。
   判据看产物：`readelf -d libggml-cuda.so | grep NEEDED` 里**不能有 libcudart**，只该有 `libcuda.so.1`。
2. **GLIBC 上限 2.31**：`objdump -T llama-server | grep -oE 'GLIBC_[0-9.]+' | sort -uV | tail -3`，
   超了就在板上跑不起来。`b10498` 实测最高 2.18，安全。
