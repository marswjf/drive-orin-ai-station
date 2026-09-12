#!/bin/sh
# 这块板模型下载（本轮基线口径：只 Qwen3.6 不要 27B；生图只要跑通过的文生图必需项）。
#
# ★ URL 是 2026-08-17 用 probe-model-urls.js 在板上逐个实测出来的，不是按格式拼的。
#   baseline/models.tsv 写着"国内走 ModelScope：把域名换成 modelscope.cn 即可"——
#   **这个假设不成立**，实测 8 个文件里 ModelScope 只有 3 个仓库存在，其余 404。
#   ModelScope 与 HuggingFace 是两个独立平台，仓库名不保证同名同在。
#   hf-mirror.com 八个全有，作为主力源；三个大文件走 ModelScope（实测 15 MiB/s）。
#
# 落点决策（与 models.tsv 有两处出入，都是这块板的特性所迫）：
#   LLM   → /opt/m/llm             真实分区。llama.cpp 靠 mmap 读 18G 模型，
#                                  不放 mergerfs 合并视图（FUSE 上的 mmap 性能未验证）
#   生图  → /opt/update/sd-models   真实分区，同上
#   放大  → /opt/update/...         models.tsv 原本落 /opt/m0，但这块板 /opt/m0 与 /opt/other
#                                  同一设备（/var 的宿主），放模型会挤爆 /var
#
# 顺序从小到大：小文件先跑通链路，避免 18G 下到一半才发现问题。
# 幂等：已存在且尺寸一致就跳过，尺寸不足则断点续传。
set -u
NODE=/var/lib/llm/bin/node
DL=/var/lib/llm/tmp/dl.js
LOG=/var/lib/llm/tmp/models-dl.log

mkdir -p /opt/m/llm /var/lib/llm/tmp
mkdir -p /opt/update/sd-models/diffusion_models \
         /opt/update/sd-models/text_encoders \
         /opt/update/sd-models/vae \
         /opt/update/sd-models/upscale_models

# 期望字节数|目标路径|实测可用 URL
LIST=$(cat <<'EOF'
66961958|/opt/update/sd-models/upscale_models/4x-UltraSharp.pth|https://hf-mirror.com/lokCX/4x-Ultrasharp/resolve/main/4x-UltraSharp.pth
67040989|/opt/update/sd-models/upscale_models/RealESRGAN_x4plus.pth|https://hf-mirror.com/schwgHao/RealESRGAN_x4plus/resolve/main/RealESRGAN_x4plus.pth
335304388|/opt/update/sd-models/vae/ae.safetensors|https://hf-mirror.com/vpakarinen/zimage-vae-clip-lora/resolve/main/ae.safetensors
639150592|/opt/m/llm/Qwen3-Embedding-0.6B-Q8_0.gguf|https://modelscope.cn/models/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/master/Qwen3-Embedding-0.6B-Q8_0.gguf
899283680|/opt/m/llm/mmproj-F16.gguf|https://hf-mirror.com/Youseff1987/Qwen3.6-35B-A3B-Claude-4.6-Opus-Reasoning-Distilled-GGUF-with-mmproj/resolve/main/mmproj-F16.gguf
4280404704|/opt/update/sd-models/text_encoders/Qwen_3_4b-Q8_0.gguf|https://hf-mirror.com/worstplayer/Z-Image_Qwen_3_4b_text_encoder_GGUF/resolve/main/Qwen_3_4b-Q8_0.gguf
7224707136|/opt/update/sd-models/diffusion_models/z_image_turbo-Q8_0.gguf|https://modelscope.cn/models/jayn7/Z-Image-Turbo-GGUF/resolve/master/z_image_turbo-Q8_0.gguf
18209036576|/opt/m/llm/Qwen3.6-35B-A3B-MTP-UD-IQ4_XS.gguf|https://modelscope.cn/models/unsloth/Qwen3.6-35B-A3B-MTP-GGUF/resolve/master/Qwen3.6-35B-A3B-UD-IQ4_XS.gguf
EOF
)
# ⚠ 最后一行：上游文件名是 Qwen3.6-35B-A3B-UD-IQ4_XS.gguf（无 MTP- 前缀），
#   板上存成带 MTP- 前缀的名字以示区分。非 MTP 仓库有同名文件但字节数是 17730509792，
#   下错会失去 MTP 投机解码（生成速度差 11~50%）。这里的 URL 指的是 MTP 仓库。

echo "===== 下载开始 $(date '+%F %T') =====" >> "$LOG"
echo "===== 下载开始 $(date '+%F %T') ====="

echo "$LIST" | while IFS='|' read -r want dest url; do
  [ -z "${want:-}" ] && continue
  name=$(basename "$dest")

  if [ -f "$dest" ]; then
    have=$(stat -c %s "$dest" 2>/dev/null || echo 0)
    if [ "$have" = "$want" ]; then
      echo "SKIP $name 已存在且尺寸一致 ($have)" | tee -a "$LOG"
      continue
    fi
    echo "RESUME $name 已有 $have / 期望 $want" | tee -a "$LOG"
  else
    echo "BEGIN $name 期望 $want 字节" | tee -a "$LOG"
  fi

  t0=$(date +%s)
  "$NODE" "$DL" "$url" "$dest" "$LOG"
  rc=$?
  t1=$(date +%s)
  have=$(stat -c %s "$dest" 2>/dev/null || echo 0)
  if [ "$rc" = "0" ] && [ "$have" = "$want" ]; then
    dt=$((t1 - t0)); [ "$dt" -lt 1 ] && dt=1
    echo "OK $name $have 字节 / ${dt}s / $((have / dt / 1048576)) MiB/s" | tee -a "$LOG"
  else
    echo "FAIL $name rc=$rc 实得 $have 期望 $want" | tee -a "$LOG"
  fi
done

echo "===== 下载结束 $(date '+%F %T') =====" | tee -a "$LOG"
{
  echo "--- LLM ---"; ls -l /opt/m/llm/
  echo "--- 生图 ---"; ls -lR /opt/update/sd-models/
  echo "--- 空间 ---"; df -h /opt/m /opt/update
} | tee -a "$LOG"
