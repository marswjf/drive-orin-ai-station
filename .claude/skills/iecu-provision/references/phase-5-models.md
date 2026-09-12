# 阶段 5 — 模型：下载清单与落点

模型不在归档里（合计 45 GB），要单独下载。

**下面每一条的来源都是用 HuggingFace / ModelScope API 实查、并按字节数完全一致确认的**，
不是按文件名猜的。字节数就是校验值——下完对一下大小，不对就是拿错了文件。

---

## 5.1 LLM 模型（落 `/opt/m/llm/`，合计约 20 GB）

| 文件 | 字节数 | 来源 |
|---|---|---|
| `Qwen3.6-35B-A3B-MTP-UD-IQ4_XS.gguf` | 18 209 036 576 | `unsloth/Qwen3.6-35B-A3B-MTP-GGUF` |
| `mmproj-F16.gguf` | 899 283 680 | `Youseff1987/Qwen3.6-35B-A3B-Claude-4.6-Opus-Reasoning-Distilled-GGUF-with-mmproj` |
| `Qwen3-Embedding-0.6B-Q8_0.gguf` | 639 150 592 | `Qwen/Qwen3-Embedding-0.6B-GGUF` |

⚠ **主模型上游叫 `Qwen3.6-35B-A3B-UD-IQ4_XS.gguf`，板上被改名加了 `MTP-`**，
用来和非 MTP 版区分。两者同名但**不是同一个文件**：MTP 版 18 209 036 576 字节，
非 MTP 版 17 730 509 792 字节。**下错了会没有 MTP 投机解码，生成速度掉一截。**

```
HF:         https://huggingface.co/unsloth/Qwen3.6-35B-A3B-MTP-GGUF/resolve/main/Qwen3.6-35B-A3B-UD-IQ4_XS.gguf
ModelScope: https://modelscope.cn/models/unsloth/Qwen3.6-35B-A3B-MTP-GGUF/resolve/master/Qwen3.6-35B-A3B-UD-IQ4_XS.gguf
```

国内用 ModelScope，实测 15 MiB/s，HF 直连约 2.9 MiB/s。

---

## 5.2 生图模型（落 `/opt/update/sd-models/`，合计约 25 GB）

### 必需件（缺任何一个，四张现役工作流都跑不了）

| 落点 | 文件 | 字节数 | 来源仓库 |
|---|---|---|---|
| `diffusion_models/` | `z_image_turbo-Q8_0.gguf` | 7 224 707 136 | `jayn7/Z-Image-Turbo-GGUF` |
| `text_encoders/` | `Qwen_3_4b-Q8_0.gguf` | 4 280 404 704 | `worstplayer/Z-Image_Qwen_3_4b_text_encoder_GGUF` |
| `vae/` | `ae.safetensors` | 335 304 388 | `vpakarinen/zimage-vae-clip-lora` |

⚠ **VAE 不要量化。** UNet 与文本编码器都用 Q8_0，VAE 保持原样——
量化 VAE 会让输出画质明显劣化，而它只有 320 MB，省不出什么。

### 按需件

| 用途 | 落点 | 文件 | 字节数 | 来源仓库 |
|---|---|---|---|---|
| ControlNet 双分支 | `model_patches/` | `Z-Image-Turbo-Fun-Controlnet-Union-2.1-lite-2602-8steps.safetensors` | 2 016 627 488 | `alibaba-pai/Z-Image-Turbo-Fun-Controlnet-Union-2.1` |
| 四步蒸馏 | `loras/` | `Z-Image-Fun-Lora-Distill-4-Steps-2602-ComfyUI.safetensors` | 568 275 120 | `alibaba-pai/Z-Image-Fun-Lora-Distill` |
| 去 JPEG 伪影 | `loras/` | `dejpeg_v3.safetensors` | 680 326 512 | `wcde/Z-Image-Turbo-DeJPEG-Lora` |
| 去伪影（细节版） | `loras/` | `dejpeg_detailed.safetensors` | 170 127 808 | `wcde/Z-Image-Turbo-DeJPEG-Lora` |
| 视频超分 | `SEEDVR2/` | `seedvr2_ema_3b-Q4_K_M.gguf` | 1 995 344 224 | `cmeka/SeedVR2-GGUF` |
| 视频超分 VAE | `SEEDVR2/` | `ema_vae_fp16.safetensors` | 501 324 814 | `numz/SeedVR2_comfyUI` |
| 四倍放大 | `/opt/m0/sd-models/upscale_models/` | `4x-UltraSharp.pth` | 66 961 958 | `lokCX/4x-Ultrasharp` |
| 四倍放大 | 同上 | `RealESRGAN_x4plus.pth` | 67 040 989 | `schwgHao/RealESRGAN_x4plus` |

直链一律是 `https://huggingface.co/<仓库>/resolve/main/<文件名>`。

### 两个不建议装的

| 文件 | 字节数 | 为什么 |
|---|---|---|
| `qwen_3_4b.safetensors`（fp16 文本编码器） | 8 044 982 048 | **已被 Q8_0 版取代**。省下的 3.3 GB 直接变成采样余量——1664×928 就是靠它从"被杀"变成能跑。来源 `Norby/Z_Image_text_encoders` |
| `z_image_turbo_distill_patch_lora_bf16.safetensors` | 158 826 336 | **来源没查到**，且不是四张现役工作流的必需件 |

---

## 5.3 搜索根登记

三个分区各放一部分，靠 ComfyUI 的 `extra_model_paths.yaml` 登记，对用户透明：

```yaml
iecu_m0:
  base_path: /opt/m0/sd-models/
  checkpoints: checkpoints
  loras: loras
  vae: vae
  controlnet: controlnet
  model_patches: model_patches
  upscale_models: upscale_models
  clip: clip
  clip_vision: clip_vision
  diffusion_models: diffusion_models
  text_encoders: text_encoders
  embeddings: embeddings
iecu_m:
  base_path: /opt/m/sd-models/
  ...
iecu_update:
  base_path: /opt/update/sd-models/
  ...
```

⚠ **子目录必须真实存在**，否则 ComfyUI 扫描时**静默跳过那一类**，
界面上只表现为"少了几个模型"，不报任何错。

---

## 5.4 下载注意事项

- 大文件用 `aria2c -x 8 -c`。**`curl -C -` 实测出现过续传失败把文件截断**，
  而截断的 GGUF 加载时报的错完全指不到根因。
- 板上有下载器 `/var/lib/llm/tmp/dl.js`，支持断点续传并在结束时校验 `Content-Length`。
  判断"下完了"以日志里的 `DONE` 行为准，**不要看进程还在不在**。
- 长时间下载挂 `systemd-run --unit=... --collect`，断 SSH 不受影响。

---

## 5.5 完成判据

- [ ] 每个文件的字节数与上表**完全一致**
- [ ] `extra_model_paths.yaml` 里三个搜索根的子目录都真实存在
- [ ] ComfyUI 重启后，`/object_info` 里 `UnetLoaderGGUF.unet_name`、
      `CLIPLoaderGGUF.clip_name`、`VAELoader.vae_name` 的下拉选项能看到对应文件名

最后一条是唯一算数的判据：**文件在磁盘上 ≠ ComfyUI 能看到它。**
