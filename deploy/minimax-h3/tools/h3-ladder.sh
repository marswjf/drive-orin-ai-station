#!/bin/bash
# 逐级加帧数，每级独立判定；OOM 把服务打死时自动拉起再继续下一级。
# 用法: bash h3-ladder.sh "6.58 10.13"
#
# ⚠ 板上没有 curl（2026-09-02 确认：/usr/bin /bin /usr/local/bin /var/lib/llm/bin 都没有）。
#   早先版本用 curl 探端口，检测永远失败、循环 180 秒后继续，看起来像"在等服务"，
#   实际上是空转。一律改用路径确定的 node 探测。
NODE=/var/lib/llm/bin/node
WF=/var/lib/llm/tmp/h3-t2v-api.json
SECS="${1:-6.58 10.13}"

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

for s in $SECS; do
  echo ""
  echo "############ 秒数设定 $s ############"
  ensure_up || { echo "跳过 $s"; continue; }
  free -m | sed -n '2p' | awk '{print "  跑前 used="$3"MB avail="$7"MB"}'
  MARK=$(date '+%Y-%m-%d %H:%M:%S')
  $NODE /var/lib/llm/tmp/h3run.js "$WF" "$s" 2400
  echo "  退出码=$?"
  echo "  --- 本级 aimdo 记账 ---"
  journalctl -u comfyui --no-pager --since "$MARK" 2>/dev/null \
    | grep -aE "loaded partially|loaded completely|VRAMdebug: freed|code=killed|Prompt executed" | tail -8
done

echo ""
echo "############ 全部结束 ############"
free -m | sed -n '2p' | awk '{print "现在 used="$3"MB avail="$7"MB"}'
