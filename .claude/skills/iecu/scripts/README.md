# scripts — IECU 采集工具

本机 Windows 无 sshpass/python/wsl，密码式 SSH 自动化走 Node + ssh2。首次在本目录装依赖：

```powershell
& "__OPERATOR_HOME__\scoop\apps\nodejs\current\node.exe" -v   # 确认 node（scoop 版）
npm install                                                   # 装 ssh2
```

| 脚本 | 作用 | 用法 |
|---|---|---|
| `probe.js` | 只读批量采集，断点续跑+断线重连+增量落盘 | `node probe.js cmdset.json out.json` |
| `dump.js` | 把 out.json 按 group 拆成可读文本，列出空/失败项 | `node dump.js out.json txtdir/` |
| `thermal-monitor.js` | 温度/负载持续监控，输出 CSV | `node thermal-monitor.js out.csv 5` |

- 目标默认 `172.31.254.38` root/nvidia；改目标用环境变量 `IECU_HOST` / `IECU_USER` / `IECU_PASS`。
- cmdset 格式与可复用命令库见 `../references/probe-recipes.md`。
- 红线见 `../SKILL.md`：只读优先；绝不写 `/dev/vblkdev*`；绝不跑 `/app/shutdown_service.sh kill`。
- `node_modules/` 不纳入版本管理，用时 `npm install` 重装。
