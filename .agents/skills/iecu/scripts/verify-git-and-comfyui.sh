#!/bin/sh
# 验证 git 的 https 能力，再重启 ComfyUI 确认 Manager 修好。
set -u
export PATH=/var/lib/llm/bin:$PATH

echo "############ 1. git 基本能力 ############"
/var/lib/llm/bin/git --version
echo "--- GIT_EXEC_PATH 里有没有 git-remote-https（https clone 的关键）---"
ls /var/lib/llm/gitroot/usr/lib/git-core/git-remote-https && echo "  ✓ 在"

echo
echo "############ 2. 实测 https 协议（ls-remote 最轻量，不下载内容）############"
if timeout 60 /var/lib/llm/bin/git ls-remote https://github.com/comfyanonymous/ComfyUI.git HEAD 2>&1 | head -3; then
  echo "  ✓ https 协议可用（能读远端 ref）"
else
  echo "  ★ https 失败"
fi

echo
echo "############ 3. 重启 ComfyUI ############"
systemctl restart comfyui
T0=$(date +%s)
i=0
while [ $i -lt 90 ]; do
  ss -lnt 2>/dev/null | grep -q ':8188' && break
  sleep 2; i=$((i + 1))
done
T1=$(date +%s)
echo "  8188 监听耗时 $((T1 - T0)) 秒"

echo
echo "############ 4. 判据：这次 IMPORT FAILED 应该是 0 ############"
# 只看本次启动之后的日志
SINCE=$(date -d "@$T0" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo "-2min")
F=$(journalctl -u comfyui --since "$SINCE" --no-pager 2>/dev/null | grep -c 'IMPORT FAILED')
P=$(journalctl -u comfyui --since "$SINCE" --no-pager 2>/dev/null | grep -c 'PRESTARTUP FAILED')
echo "  IMPORT FAILED: $F 次（必须 0）"
echo "  PRESTARTUP FAILED: $P 次（必须 0）"
echo "--- 本次的节点加载耗时 ---"
journalctl -u comfyui --since "$SINCE" --no-pager 2>/dev/null | grep -E 'seconds:.*custom_nodes|seconds \(' | sed 's/.*run\.sh\[[0-9]*\]: //' | sed 's/^/    /'
echo "--- Manager 相关 ---"
journalctl -u comfyui --since "$SINCE" --no-pager 2>/dev/null | grep -i 'manager' | sed 's/.*run\.sh\[[0-9]*\]: //' | head -6 | sed 's/^/    /'

echo
echo "############ 5. 服务与内存 ############"
systemctl is-active comfyui
ss -lntp 2>/dev/null | grep 8188 | awk '{print "  "$4}'
free -m | head -2

echo
echo "############ 6. 模型下载进度 ############"
grep -E '^(OK|FAIL|BEGIN|SKIP)' /var/lib/llm/tmp/models-dl.log 2>/dev/null | tail -5
grep PROGRESS /var/lib/llm/tmp/models-dl.log 2>/dev/null | tail -1
systemctl is-active iecu-model-dl
df -h /opt/m /opt/update | grep -v Filesystem
