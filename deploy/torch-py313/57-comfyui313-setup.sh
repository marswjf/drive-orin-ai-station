#!/bin/bash
# 宿主上执行：建 ComfyUI 新栈运行环境 /var/lib/llm/comfyui313（py3.13 + torch 2.11 + CUDA 12.2）
# 现役 /var/lib/llm/comfyui310 全程不动，达标才切服务。
#
# 空间安排（关键）：/var 只有 20G，装不下第二套完整环境。所以
#   实体放 /opt/m0/comfyui313 与 /opt/m0/cuda122（14G 可用），
#   再 bind 回 /var/lib/llm/ 下并 remount 去掉 noexec —— 与 chroot 用的是同一招，
#   纯加法、可逆。开机挂载由 mount-stack313.sh 负责（comfyui.service 的 ExecStartPre）。
set -e
ROOT=/var/lib/llm/chroot-focal
SRC_M0=/opt/m0/comfyui313
DST=/var/lib/llm/comfyui313
CUDA_M0=/opt/m0/cuda122
CUDA_DST=/var/lib/llm/cuda122

echo "===== [1] 建实体目录并 bind（去 noexec） ====="
mkdir -p "$SRC_M0" "$DST" "$CUDA_M0/lib64" "$CUDA_DST"
is_mounted() { awk -v p="$1" '$2==p{f=1} END{exit !f}' /proc/mounts; }
is_mounted "$DST"      || mount --bind "$SRC_M0" "$DST"
mount -o remount,bind,rw,exec "$DST"
is_mounted "$CUDA_DST" || mount --bind "$CUDA_M0" "$CUDA_DST"
mount -o remount,bind,rw,exec "$CUDA_DST"
grep -E "comfyui313|cuda122" /proc/mounts | sed 's/^/  /'
echo "-- 验证 exec 生效（noexec 会让下面这行失败）:"
printf '#!/bin/sh\necho exec-ok\n' > "$DST/.exectest"; chmod +x "$DST/.exectest"
"$DST/.exectest" && rm -f "$DST/.exectest"

echo "===== [2] venv + ComfyUI 源码 ====="
PY=/var/lib/llm/py313/bin/python3.13
[ -x "$PY" ] || { echo "ABORT: py313 未就绪"; exit 3; }
if [ ! -d "$DST/venv" ]; then
  "$PY" -m venv "$DST/venv"
fi
. "$DST/venv/bin/activate"
python -VV
pip install -q --upgrade pip setuptools wheel

# ⚠ 必须设运行时库路径，否则第 [5] 步的版本回读会报
#   `libcudart.so.12: cannot open shared object file`，把好环境误判成坏的。
#   这一串与 comfyui313/run.sh 完全一致——**验的必须是产品配置**（A-154）。
export LD_LIBRARY_PATH=/var/lib/llm/cuda122/lib64:${LD_LIBRARY_PATH:-}

# TLS 证书（A-136：自建 CPython 找不到系统证书，Manager 会连不上 GitHub）
export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
export SSL_CERT_DIR=/etc/ssl/certs
export REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
export GIT_SSL_CAINFO=/etc/ssl/certs/ca-certificates.crt

# ⚠ 一律用包装器 /var/lib/llm/bin/git，不要手工拼 gitroot 的环境。
#   手工只设 PATH+LD_LIBRARY_PATH 会漏掉 **GIT_EXEC_PATH**，表现为
#   `fatal: unable to find remote helper for 'https'`——git 本体能跑，
#   但找不到 git-remote-https 这个子命令，https 克隆全废。
GIT=/var/lib/llm/bin/git
[ -x "$GIT" ] || { echo "ABORT: 缺 $GIT，先跑 deploy/comfyui/install-git.sh"; exit 5; }
if [ ! -d "$DST/ComfyUI/.git" ]; then
  "$GIT" clone --depth 1 https://github.com/comfyanonymous/ComfyUI "$DST/ComfyUI"
fi
cd "$DST/ComfyUI" && ("$GIT" log -1 --oneline || true)

echo "===== [3] 装自编的 torch / torchvision / torchaudio（--no-deps，别让 pip 从 PyPI 顶掉） ====="
for w in torch-2.11 torchvision-0.26 torchaudio-2.11; do
  f=$(ls -t /opt/m0/torchbuild/out/${w}*cp313*.whl 2>/dev/null | head -1)
  [ -z "$f" ] && { echo "  !! 缺 $w 的 cp313 wheel"; exit 4; }
  echo "  install $(basename $f)"
  pip install -q --no-deps --force-reinstall "$f"
done

echo "===== [4] 装 ComfyUI 依赖，用约束文件钉死我们自编的三件套 ====="
CONS=/tmp/constraints313.txt
cat > "$CONS" <<EOF
torch==2.11.0
torchvision==0.26.0
torchaudio==2.11.0
EOF
PIP_CONSTRAINT=$CONS pip install -q -r "$DST/ComfyUI/requirements.txt" || {
  echo "  !! requirements 未全部装上，逐条重试以便定位"
  while read -r line; do
    [ -z "$line" ] && continue; case "$line" in \#*) continue;; esac
    PIP_CONSTRAINT=$CONS pip install -q "$line" 2>/dev/null || echo "     装不上: $line"
  done < "$DST/ComfyUI/requirements.txt"
}

echo "===== [4.5] 模型路径 + 用户数据（不做这步，新环境一个模型都找不到） ====="
OLD=/var/lib/llm/comfyui310
# 三个搜索根的登记表：模型分放在 /opt/m0、/opt/m、/opt/update 三个分区
if [ -f "$OLD/extra_model_paths.yaml" ]; then
  cp -f "$OLD/extra_model_paths.yaml" "$DST/ComfyUI/extra_model_paths.yaml"
  echo "  extra_model_paths.yaml 已复制，登记的搜索根："
  grep -E '^\s*base_path' "$DST/ComfyUI/extra_model_paths.yaml" | sed 's/^/    /'
else
  echo "  !! 现役环境里没有 extra_model_paths.yaml，需手工放置"
fi
# 用户数据：工作流、界面设置（中文界面 Comfy.Locale=zh 就在这里）
if [ -d "$OLD/user" ]; then
  mkdir -p "$DST/ComfyUI/user"
  cp -a "$OLD/user/." "$DST/ComfyUI/user/" 2>/dev/null || true
  echo "  user/ 已迁移，工作流数量: $(ls "$DST/ComfyUI/user/default/workflows" 2>/dev/null | wc -l)"
  grep -o '"Comfy.Locale"[^,]*' "$DST/ComfyUI/user/default/comfy.settings.json" 2>/dev/null | sed 's/^/    /'
fi
# 输入图（工作流里引用的素材）
if [ -d "$OLD/input" ]; then
  mkdir -p "$DST/ComfyUI/input"
  cp -a "$OLD/input/." "$DST/ComfyUI/input/" 2>/dev/null || true
  echo "  input/ 已迁移，文件数: $(ls "$DST/ComfyUI/input" 2>/dev/null | wc -l)"
fi
mkdir -p "$DST/ComfyUI/output"
# 板上模型目录必须真实存在，否则 ComfyUI 扫描时会静默跳过那一类
for root in /opt/m0/sd-models /opt/m/sd-models /opt/update/sd-models; do
  [ -d "$root" ] && echo "  搜索根在位: $root ($(ls "$root" 2>/dev/null | tr '\n' ' '))"
done

echo "===== [5] 回读版本，确认自编版没被顶掉（陷阱：间接依赖会拖 PyPI 的 torch） ====="
python - <<'PY'
import importlib
for m in ('torch','torchvision','torchaudio','numpy'):
    try:
        mod = importlib.import_module(m)
        print(f"  {m:12s} {getattr(mod,'__version__','?'):12s} {getattr(mod,'__file__','')}")
    except Exception as e:
        print(f"  {m:12s} IMPORT-FAIL {str(e)[:90]}")
import torch
print("  cuda:", torch.version.cuda, "| available:", torch.cuda.is_available())
PY
echo COMFY313-SETUP-DONE
