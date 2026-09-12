# 阶段 4 — 服务：LLM、生图、面板、systemd、隧道

目标：三个端口在听，三种运行模式能互斥切换，面板能开。

---

## 4.1 三种模式为什么必须互斥

内存装不下两套。板子共 28.73 GB 统一内存：

| 模式 | 跑什么 | 占用 |
|---|---|---|
| 推理 | `llm-server` + `llm-embedding` | nvmap 约 20 GB + 进程约 1 GB |
| 生图 | `comfyui` + `llm-embedding` | 进程约 10 GB + nvmap 约 10 GB |
| 车机 | `application_start` | 约 11 GB |

**`llm-embedding` 不参与互斥。** 它走 CPU 档只占 0.93 GB，推理和生图都容得下，
多数场景要它常驻。需要腾这块内存时由面板显式停，
`comfyui.service` 的 `Conflicts` 里**故意不写它**——否则每次切生图都会打断向量库。

互斥靠 systemd 声明：

```ini
Conflicts=application_start.service llm-server.service
```

⚠ **生图模式是临时态**，`comfyui.service` 保持 `disabled`，断电重启回到推理模式。

---

## 4.2 内存看不见的那一半

这是本板子最容易看错的地方：

```
llama-server 进程 RSS 只有 0.93 GB，但 MemAvailable 从 28 GB 掉到 3.6 GB
```

差额在 **nvmap**（GPU 映射内存），**不计入进程 RSS**。
所以判断内存去向必须看 `MemAvailable` 的差分，不能看 `ps` 的 RSS，
也不能信 `systemd` 报的 `MemoryCurrent`。

---

## 4.3 LLM 推理栈

二进制是交叉编译的 llama.cpp（`/var/lib/llm/llama/bin/llama-server`），
配置在 `/var/lib/llm/config.json`，由面板读取后拼命令行。基线配置：

```json
{
  "model": "/opt/m/llm/Qwen3.6-35B-A3B-MTP-UD-IQ4_XS.gguf",
  "mmproj": "/opt/m/llm/mmproj-F16.gguf",
  "ctx": 131072, "ngl": 99, "threads": 10, "parallel": 1,
  "cacheTypeK": "q8_0", "cacheTypeV": "q8_0", "flashAttn": "on",
  "backend": "cuda", "cacheRamMiB": 1024,
  "extraArgs": ["--spec-type","draft-mtp","--spec-draft-n-max","2",
                "--temp","1.0","--top-p","0.95","--top-k","20","--min-p","0",
                "--presence-penalty","1.5","--no-mmproj-offload",
                "--chat-template-file","/var/lib/llm/3.6_chat_template-v10.jinja"]
}
```

几个参数是用代价换来的，不要凭直觉改：

| 参数 | 为什么 |
|---|---|
| `threads: 10` | 板上 11 个可用核（`isolcpus=5` 已被内核隔离）。曾经写死 4，**七个核全程闲置**，CPU 视觉编码因此慢了一倍多 |
| `--no-mmproj-offload` | **MTP 与 GPU 视觉编码硬互斥**，不加这条一发图就 CUDA OOM。代价是图像走 CPU 编码 |
| `cacheRamMiB: 1024` | 默认 8192 会持续填池子，看起来像内存泄漏。查配置比怀疑泄漏快得多 |
| `parallel: 1` | KV 按 `n_ctx` 总量分，调大会装不下长请求 |
| 对话模板 v10 | 修好了工具调用，并带一行中文预填——思考量砍掉 74~82%，且从纯英文变中文 |

---

## 4.4 生图栈

```ini
ExecStartPre=/var/lib/llm/mount-stack313.sh
WorkingDirectory=/var/lib/llm/comfyui313
ExecStart=/var/lib/llm/comfyui313/run.sh --listen 0.0.0.0 --port 8188 --highvram --disable-smart-memory
OOMScoreAdjust=200
Restart=on-failure
RestartSec=15
```

四处都是必需项：

| 配置 | 为什么必需 |
|---|---|
| `ExecStartPre` 挂载 | 实体在 `/opt/m0`（带 noexec），要 bind 回来并 remount 去掉 |
| `--highvram` | 统一内存下 offload 省不出一个字节却要真搬运。默认策略与 lowvram 都会算错账——前者第一张就 OOM，后者慢 2.75 倍。代价：**模型总量约 14 GB 上限**，装不下就换更低量化档，不要退回 offload |
| `OOMScoreAdjust=200` | 内存吃紧时**优先牺牲生图，保住面板**。实测生效过两次：内核选中 ComfyUI，面板与隧道全程没断 |
| `Restart=on-failure` | 配合上一条，被杀之后 15 秒自动拉起 |

---

## 4.5 运维面板

零依赖单文件 Node 服务，是整套系统的唯一入口。三个访问平面分开管：

| 路径 | 平面 | 策略 |
|---|---|---|
| `/v1/*`、`/embed/*` | 数据面 | **仅局域网**。来自公网一律 403，判据是有无 `X-Forwarded-For` |
| `/api/*` | 控制面 | 公网必须登录，写操作还要带 `X-Panel-Request` 头 |
| `/llm/*`、`/comfy/*`、静态页 | 调试面 | 公网必须登录 |

密码用 Node 内置 scrypt 存在 `/var/lib/llm/panel-auth.json`（权限 600）。

面板还承担两件容易被忽略的事：

1. **模型名别名**。`/v1/models` 里多出一个 `-nothink` 条目，
   转发时注入 `chat_template_kwargs.enable_thinking=false`。
   **llama-server 本身不认这个名字**——直连 `:8080` 测会绕过它，测出来的不是用户看到的行为。
2. **取消信号传播**。客户端断开时必须 `destroy` 到上游的连接，
   否则 llama.cpp 看不见下游已走，会继续生成到 `max_tokens`。
   `parallel=1` 只有一个 slot，一个白跑的任务就能让后续全部排队超时。

---

## 4.6 反向隧道

`frpc` 反连家里的 `frps`，把面板送出去。**只送 :9000，绝不送 SSH**。

公网入口是 LXC 上的 Caddy 反代。⚠ **反代必须改写 Origin**，
否则浏览器的 WebSocket 挂死、ComfyUI 界面卡在启动动画。

---

## 4.7 完成判据

```bash
ss -lntp | grep -E ':8080|:8081|:8188|:9000'
```

- [ ] 端口真的在听（**`systemctl is-active` 说 active 不算数**）
- [ ] 面板能打开，三种模式能互相切换
- [ ] 切模式后端口跟着变，且旧模式的进程确实退了
- [ ] `journalctl -u comfyui | grep -c 'IMPORT FAILED'` 为 0
- [ ] 断电重启后回到推理模式，`llm-server` 与 `iecu-panel` 自动起来
