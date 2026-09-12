#!/bin/bash
# 跑「时长 × 分辨率」组合，找出这块板子上可行的边界。
# 用法: bash h3-matrix.sh "6.58:0.15 6.58:0.1 10.13:0.1"
#       每项是 <秒数>:<megapixels>
#
# 思路：帧数到顶之后，降分辨率是换时长的主要手段——latent 变小，同样内存能放更多帧。
# 画面用 SeedVR2 超分补回来（实测 78 秒、峰值 12.9 GB，很宽松）。
# ⚠ 板上没有 curl，探活一律用 node（见 tools/README.md）。
NODE=/var/lib/llm/bin/node
WF=/var/lib/llm/tmp/h3-t2v-api.json
ITEMS="${1:-6.58:0.15 6.58:0.1 10.13:0.1}"

up() {
  $NODE -e "
    const r=require('http').get({host:'127.0.0.1',port:8188,path:'/queue'},res=>{res.resume();process.exit(0)});
    r.on('error',()=>process.exit(1));
    r.setTimeout(3000,()=>{r.destroy();process.exit(1)});
  " 2>/dev/null
}

ensure_up() {
  if up; then return 0; fi
  echo "  [服务不在，拉起中…]"
  systemctl start comfyui
  for i in $(seq 1 90); do
    sleep 2
    if up; then echo "  [已监听 $((i*2))s]"; return 0; fi
  done
  echo "  [⛔ 180 秒仍拉不起来]"; return 1
}

for item in $ITEMS; do
  s="${item%%:*}"
  mp="${item##*:}"
  echo ""
  echo "############ $s 秒 @ $mp MP ############"
  ensure_up || { echo "跳过"; continue; }
  free -m | sed -n '2p' | awk '{print "  跑前 used="$3"MB avail="$7"MB"}'
  MARK=$(date '+%Y-%m-%d %H:%M:%S')
  $NODE /var/lib/llm/tmp/h3run.js "$WF" "$s" 2400 "$mp"
  echo "  退出码=$?"
  echo "  --- aimdo 记账 ---"
  journalctl -u comfyui --no-pager --since "$MARK" 2>/dev/null \
    | grep -aE "loaded partially|VRAMdebug: freed|code=killed|Prompt executed" | tail -6
done

echo ""
echo "############ 矩阵结束 ############"
free -m | sed -n '2p' | awk '{print "现在 used="$3"MB avail="$7"MB"}'
