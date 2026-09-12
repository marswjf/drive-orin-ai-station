# 成品样例（2026-09-02）

板上 MiniMax-H3 实际跑出来的片子，直接播放即可。
**画面与 32kHz 立体声是模型一次联合去噪生成的**，不是后期合成。

| 文件 | 帧数 | 时长 | 耗时 | 大小 |
|---|---|---|---|---|
| `H3_243frames_10.13s.mp4` | 243 | **10.13 秒** | 510.6 s | 874 KB |
| `H3_73frames_3.04s.mp4` | 73 | 3.04 秒 | 306.4 s | 315 KB |

608×352 / 24fps / 4 步 / cfg 1.0，H.264 + AAC 双轨
（`mvhd` 解出时长，`hdlr` 解出 `vide`+`soun` 两条轨）。

10.13 秒这条是**换 DynamicVRAM 启动档之后**才做得出来的——
在此之前板子的上限是 22 帧（0.92 秒）。过程见 `../dynamic-vram.md`。

⚠ 这两个文件是**过程留档**，不是回归基准。要做 A/B 请用固定种子重新生成，
别拿这里的文件比对（它们的种子是随机的）。

## 怎么再跑一条

```bash
# 板上。先切档 + 重启（起步内存必须干净，否则加载 DiT 阶段会被杀）
/var/lib/llm/comfy-profile.sh video

# 秒数设定 → 帧数换算表在 ../tools/README.md
/var/lib/llm/bin/node /var/lib/llm/tmp/h3run.js /var/lib/llm/tmp/h3-t2v-api.json 10.13 2400
```

拉回本地（`pull.js` 是目录同步工具，单个文件用面板的 HTTP 接口）：

```powershell
curl.exe -s -o out.mp4 "http://__BOARD_LAN_IP__:9000/comfy/view?filename=MiniMax_H3_00006_.mp4&type=output&subfolder=video"
```
