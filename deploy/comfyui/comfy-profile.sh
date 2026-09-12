#!/bin/bash
# ComfyUI 启动档切换（生图 / 生视频）。
# 板上落点: /var/lib/llm/comfy-profile.sh
#
# 用法:
#   comfy-profile.sh              # 只看当前是哪一档，不改动
#   comfy-profile.sh image        # 切到生图档（legacy ModelPatcher，--highvram）
#   comfy-profile.sh video        # 切到生视频档（DynamicVRAM）
#   comfy-profile.sh <档> --no-restart   # 只改配置不重启
#
# 为什么用 systemd drop-in 而不是第二个 unit：
#   两个 unit 就有两套 Conflicts、两个 is-active 判据、面板要维护两份状态，
#   而它们其实是同一个服务的两组参数。drop-in 只覆盖 ExecStart 一行，
#   `systemctl status comfyui` 仍然是唯一的真相来源。
#
# ⚠ sitecustomize.py 与 video 档是绑定的：
#   video 档必须有 /var/lib/llm/comfyui313/venv/lib/python3.13/site-packages/sitecustomize.py，
#   否则 ComfyUI 起不来（static TLS，见 deploy/torch-py313/sitecustomize.py）。
#   本脚本切 video 前会检查它在不在，不在就拒绝切换并说明原因。
set -u

UNIT=/etc/systemd/system/comfyui.service
DROPDIR=/etc/systemd/system/comfyui.service.d
DROPIN=$DROPDIR/profile.conf
RUNSH=/var/lib/llm/comfyui313/run.sh
SITECUSTOMIZE=/var/lib/llm/comfyui313/venv/lib/python3.13/site-packages/sitecustomize.py
BASE="--listen 0.0.0.0 --port 8188"

# 生图档：legacy ModelPatcher。A-124——统一内存下 offload 省不出内存却要真搬运，
#   默认策略会算错账直接 OOM，全常驻反而快 2.75 倍。代价是模型总量 ≤14 GB。
IMAGE_ARGS="$BASE --highvram --disable-smart-memory"

# 生视频档：DynamicVRAM（comfy-aimdo）。三个参数是一组，别单独删任何一个：
#   · 不带 --highvram —— 它在 cli_args.py:315 是 DynamicVRAM 的一票否决项
#   · --disable-smart-memory —— 绕过 model_management.py:882「不为 dynamic 卸 dynamic」的短路
#   · --disable-pinned-memory —— 统一内存下 pinned host buffer 与设备内存是同一块物理内存，
#     且 pinned_hostbuf_size() 还要 ×2。73 帧成败就差这一个参数。
VIDEO_ARGS="$BASE --disable-smart-memory --disable-pinned-memory"

current_profile() {
  local line
  line=$(systemctl cat comfyui 2>/dev/null | grep -E '^ExecStart=' | tail -1)
  case "$line" in
    *--highvram*) echo image ;;
    *--disable-pinned-memory*) echo video ;;
    *) echo unknown ;;
  esac
}

show() {
  echo "当前档: $(current_profile)"
  systemctl cat comfyui 2>/dev/null | grep -E '^ExecStart=' | tail -1 | sed 's/^/  /'
  echo "  服务: $(systemctl is-active comfyui 2>/dev/null)"
  if [ -s "$SITECUSTOMIZE" ]; then echo "  sitecustomize.py: 在（video 档可用）"
  else echo "  sitecustomize.py: 缺失（只能用 image 档）"; fi
}

PROFILE="${1:-}"
[ -z "$PROFILE" ] && { show; exit 0; }

case "$PROFILE" in
  image) ARGS="$IMAGE_ARGS" ;;
  video)
    if [ ! -s "$SITECUSTOMIZE" ]; then
      echo "⛔ 拒绝切到 video 档：缺 $SITECUSTOMIZE" >&2
      echo "   没有它，去掉 --highvram 后 ComfyUI 会报" >&2
      echo "   ImportError: libc10.so: cannot allocate memory in static TLS block 起不来。" >&2
      echo "   先跑 deploy/torch-py313/install-sitecustomize.sh。" >&2
      exit 1
    fi
    ARGS="$VIDEO_ARGS" ;;
  *) echo "用法: $0 [image|video] [--no-restart]" >&2; exit 2 ;;
esac

mkdir -p "$DROPDIR"
# ExecStart= 空行是必需的：不先清空，drop-in 里的这行会被当作追加，
# systemd 会报 "Service has more than one ExecStart= setting" 而拒绝启动。
cat > "$DROPIN" <<EOF
# 由 comfy-profile.sh 生成，档位: $PROFILE（$(date '+%Y-%m-%d %H:%M:%S')）
# 手工改这个文件会在下次切档时被覆盖；要改默认值请改 comfy-profile.sh。
[Service]
ExecStart=
ExecStart=$RUNSH $ARGS
EOF

systemctl daemon-reload
echo "已切到 $PROFILE 档"

if [ "${2:-}" = "--no-restart" ]; then
  echo "（--no-restart：配置已写入，下次启动生效）"
  show
  exit 0
fi

systemctl restart comfyui
# ⚠ 判据不能只看 systemctl is-active——陷阱 51：active 不等于能接请求，
#   ComfyUI 要 20~40 秒才开始监听。必须探端口。
#   ⚠ 板上没有 curl，用 node（陷阱见 deploy/minimax-h3/tools/README.md）。
NODE=/var/lib/llm/bin/node
for i in $(seq 1 90); do
  sleep 2
  if $NODE -e "
    const r=require('http').get({host:'127.0.0.1',port:8188,path:'/queue'},res=>{res.resume();process.exit(0)});
    r.on('error',()=>process.exit(1));
    r.setTimeout(3000,()=>{r.destroy();process.exit(1)});
  " 2>/dev/null; then
    echo "★ 已监听（$((i*2)) 秒）"
    show
    exit 0
  fi
done
echo "⛔ 180 秒仍未监听，查 journalctl -u comfyui -n 50" >&2
exit 1
