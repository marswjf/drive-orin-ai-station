# H3 跑测工具（2026-09-02）

两个都是**在板上跑**的（避免每 3 秒一次的轮询走局域网），
用 `push.js` 推到 `/var/lib/llm/tmp/` 再执行。

## `h3run.js` —— 跑一次并同时采样内存峰值

```bash
node .claude/skills/iecu/scripts/push.js deploy/minimax-h3/tools/h3run.js /var/lib/llm/tmp/h3run.js
# 板上：node h3run.js <api.json> <秒数> [超时秒]
/var/lib/llm/bin/node /var/lib/llm/tmp/h3run.js /var/lib/llm/tmp/h3-t2v-api.json 3.05 2400
```

它做四件事：改节点 132 的秒数、**换种子**（不换就是缓存命中，那是假数据）、
每 0.5 秒采样 `/proc/meminfo`、把结果打成一行 `RESULT <帧数> <耗时> <峰值used> <最低avail> <OK|FAIL|KILLED>`。

**帧数换算**（与板上 `ComfyMathExpression` 节点一致）：

```
b = max(5, round(秒 * 24))
帧数 = b + ((5 - b % 17) % 17)      ← 17k+5 网格
```

⚠ **JS 的 `%` 对负数返回负数，Python 的返回非负**。板上表达式是 Python 语义，
所以 JS 侧必须写成 `(((5 - b % 17) % 17) + 17) % 17`。
不补这一下，0.5 秒会被算成 5 帧（实际是 22 帧）——这个 bug 我踩过，
它只影响显示、不影响实际提交，所以特别容易蒙混过去。

常用秒数 → 帧数：

| 秒数设定 | 帧数 | 实际时长 |
|---|---|---|
| 0.5 | 22 | 0.92 s |
| 1.5 | 39 | 1.63 s |
| 2.33 | 56 | 2.33 s |
| 3.05 | 73 | 3.04 s |
| 5.17 | 124 | 5.17 s |
| 6.58 | 158 | 6.58 s |
| 10.13 | 243 | 10.13 s |

## `h3-ladder.sh` —— 逐级加帧数，OOM 后自动拉起继续

```bash
# 板上（必须 nohup，否则 SSH 一断进程就没）
nohup bash /var/lib/llm/tmp/h3-ladder.sh '6.58 10.13' > /tmp/ladder.log 2>&1 < /dev/null &
```

每级独立判定，某一级把 ComfyUI 打死了会自动 `systemctl start` 再跑下一级，
并在每级结束后打印该级的 aimdo 记账行（`loaded partially` / `VRAMdebug: freed` / `code=killed`）。

## ⚠ 写板上脚本的三个坑（都在 2026-09-02 踩过）

1. **板上没有 curl**。`/usr/bin` `/bin` `/usr/local/bin` `/var/lib/llm/bin` 都没有。
   用它探活不会报错，只会永远失败——循环等满超时后继续往下走，
   看起来像"在等服务启动"，实际整个脚本空转。用 `node -e` 探。
2. **`pkill -f <关键字>` 会杀掉自己**：`exec.js` 单行模式下，执行这条命令的 shell
   命令行里就含那个关键字。用 `exec.js --file`（命令行只是 `bash -s`），或先 `pgrep` 再 `kill`。
3. **长任务必须 `nohup`**：`exec.js` 被打断时，板上前台子进程会因为写 stdout 而死，
   而且不留任何痕迹——表现是"查的时候进程还在"，再查就没了、日志也没有。

## 相关

- 参数与机制：`../dynamic-vram.md`
- 生图基准（另一套，给 Z-Image 用）：`../../comfyui/tools/benchrun.js` + `../../comfyui/workflows/bench/`
