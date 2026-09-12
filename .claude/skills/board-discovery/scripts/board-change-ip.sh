#!/bin/sh
# 在板子上原子改地址，带 90 秒自恢复：万一新地址不通，不用断电就能自动回旧地址。
# 用法（在板子上跑，或通过 exec.js --file 推送执行）:
#   sh board-change-ip.sh <网口名> <旧地址/掩码位数> <新地址/掩码位数>
#   例: sh board-change-ip.sh eth_xg __ROUTER_IP__/24 __ROUTER_IP__7/24
# 原理：后台子进程改完地址后 sleep 90，若 /tmp/ip_change_pending 还在（没被主动删除确认）
#   就自动改回旧地址。确认新地址可用后，从新地址那侧 SSH 进来 `rm -f /tmp/ip_change_pending` 即可。
IF="${1:?网口名}"
OLD="${2:?旧地址/掩码}"
NEW="${3:?新地址/掩码}"
OLDIP="${OLD%%/*}"; NEWIP="${NEW%%/*}"
touch /tmp/ip_change_pending
nohup sh -c "
  sleep 1
  ip addr add ${NEW} dev ${IF}
  ip addr del ${OLD} dev ${IF}
  echo changed_at_\$(date +%s) > /tmp/ipchange.log
  sleep 90
  if [ -f /tmp/ip_change_pending ]; then
    ip addr add ${OLD} dev ${IF} 2>/dev/null
    ip addr del ${NEW} dev ${IF} 2>/dev/null
    echo reverted_at_\$(date +%s) >> /tmp/ipchange.log
  fi
" >/dev/null 2>&1 &
echo "CHANGE_STARTED ${OLDIP} -> ${NEWIP}，90 秒内 SSH 到新地址执行:"
echo "  rm -f /tmp/ip_change_pending   # 确认可用，取消自动回滚"
