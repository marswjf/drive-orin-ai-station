# 阶段 2 — 存储：分区认识、腾空间、删留方案

目标：在四个可写分区上腾出足够空间，并且知道每样东西该放哪。

---

## 2.1 分区真相

128 GB 全部分配完，**没有隐藏盘、没有可扩容的空间**。基线板实测：

| 挂载点 | 容量 | 读写 | 用途 | 关键约束 |
|---|---|---|---|---|
| `/` | 4.2 G | **只读** | 厂商根文件系统 | 91% 满，装不进任何东西 |
| `/app` | 4.0 G | **只读** | 厂商智驾栈 | 92% 满，不要动 |
| `/etc` | 32 M | overlay 可写 | 配置 | 改动跨重启持久 |
| `/var` | 20 G | overlay 可写 | **我们的主战场** `/var/lib/llm` | 上层在 `/opt/other` |
| `/opt/m0` | 26 G | 可写 | 构建产物、生图环境实体 | **带 noexec** |
| `/opt/m` | 30 G | 可写 | LLM 模型 | **带 noexec** |
| `/opt/update` | 40 G | 可写 | 原 FOTA 固件包 → 改放生图模型 | **带 noexec** |
| `/opt/backup` | 232 M | 可写 | 厂商备份 | 太小，没用 |
| `/opt/other` | 20 G | 可写 | `/var` 的 overlay 上层 | **就是 `/var` 本身，别重复计算** |

### 两条会让人算错账的陷阱

**一、`/opt/*` 全部带 `noexec`。** 可执行文件和 `.so` 放上去会加载失败，
报错信息完全指不到根因。解法是 bind 回 `/var/lib/llm` 再 `remount` 去掉：

```bash
mount --bind /opt/m0/comfyui313 /var/lib/llm/comfyui313
mount -o remount,bind,rw,exec /var/lib/llm/comfyui313
```

这是纯加法、可逆，不写 `/etc/fstab`，由服务的 `ExecStartPre` 每次开机跑一遍。

**二、`du` 在本板子上两个方向都会骗人。**
`/var` 是 overlay，`/var/lib/llm/chroot-focal` 里又有多个 bind 挂载指向 `/opt/m0`。
`du` 报 chroot 有 19 G，而 `/var` 总共才用了 9.5 G——它把 bind 进来的内容重复计了。
排除 bind 目录后实测 4.7 G。

> **量空间只信 `df`。** 要看目录明细时，必须显式 `--exclude` 掉所有 bind 点。

---

## 2.2 腾空间：厂商的东西怎么处理

| 对象 | 大小 | 处置 | 理由 |
|---|---|---|---|
| `/opt/update/package` 的 A/B OTA 签名镜像 | 约 22 G | **迁到本地留存后删除** | 这是整块板子最大的一块可回收空间。是完整的原厂恢复素材，**本地必须留完整备份** |
| `application_start`（智驾栈） | — | `systemctl disable` | 占 11 GB 内存，与推理/生图互斥。**用 disable，不要卸载** |
| FOTA 相关服务 | — | `systemctl mask` | 防止它自己去拉固件包把空间填回来 |
| `/opt/update/*.log`（tndoip / fota / vcm 等） | 约 20 M | 可清 | 厂商日志，量不大 |
| `/opt/m/calib`、`/opt/m/map` | 约 300 M | **保留** | 标定与地图数据，删了智驾栈回不去 |
| `/` 与 `/app` | — | **一个字节都不要动** | 只读，且是回滚基准 |

⚠ 迁走 FOTA 包之前，**本地要有完整备份**。将来要恢复固件功能就靠它。

---

## 2.3 空间规划：什么放哪

```
/opt/m        30 G  ├─ llm/          LLM 模型（基线 20 G）
/opt/update   40 G  ├─ sd-models/    生图模型（基线 25 G）
/opt/m0       26 G  ├─ comfyui313/   生图环境实体      2.9 G
                    ├─ cuda122/      CUDA 运行时实体   2.4 G
                    └─ torchbuild/   构建产物与归档
/var          20 G  └─ lib/llm/      解释器、llama.cpp、面板、chroot、bind 挂载点
```

**为什么模型不放 `/var`**：`/var` 只有 20 G，还要装解释器、构建链和 chroot。
模型走 `/opt/m` 与 `/opt/update`，通过 ComfyUI 的 `extra_model_paths.yaml`
登记三个搜索根，跨分区对用户透明。

---

## 2.4 部署完成后的基线占用

基线板在**全部装完、清理完**之后的实测：

| 分区 | 已用 | 可用 | 使用率 |
|---|---|---|---|
| `/var` | 9.5 G | 9.2 G | 51% |
| `/opt/m0` | 17 G | 8.5 G | 66% |
| `/opt/m` | 20 G | 8.1 G | 72% |
| `/opt/update` | 25 G | 14 G | 65% |

新板子装完如果余量明显小于这个，说明有该清的没清。

---

## 2.5 装完之后可以回收的东西

这些在部署过程中会产生，验收通过后可以清：

| 对象 | 大小 | 说明 |
|---|---|---|
| torch 源码树 `chroot-focal/build/pytorch211` | 5.8 G | **只有从源码重编时才需要**。用归档落地的话根本不会产生 |
| 编译期 swapfile | 6 G | 只在源码重编时需要，用完 `swapoff` + 删除 |
| `qwen_3_4b.safetensors`（fp16 文本编码器） | 7.5 G | **已被 Q8_0 版取代**，现役工作流不用它 |
| `Qwen3-Embedding-0.6B-f16.gguf` | 1.2 G | 已被 Q8_0 版取代 |
| 构建期下载的 deb 与 tar（`torchbuild/dl*`） | 1.7 G | 可重新下载 |
| 各类构建日志 | 约 40 M | 留着不占地方，但也没用了 |

⚠ **删模型之前先确认没有工作流引用它。** 判据是 `/object_info` 里加载器的下拉选项，
以及 `grep` 一遍所有工作流 JSON 的文件名字段。

---

## 2.6 完成判据

- [ ] `df -h` 四个可写分区余量达到 2.4 节的量级
- [ ] `systemctl is-enabled application_start` 返回 `disabled`
- [ ] FOTA 包已迁走且**本地备份完整可校验**
- [ ] `/` 与 `/app` 的占用与出厂快照一致（证明没动过）
