#!/bin/sh
# 应用 CA 修复：重装 git 包装器（带 CA 路径）→ 验证 git https → 重启 ComfyUI 用新 run.sh。
set -u

echo "############ 1. 重装 git 包装器 ############"
bash /var/lib/llm/tmp/install-git.sh /var/lib/llm/dl/git 2>&1 | tail -8

echo
echo "############ 2. 独立调用 git 的 https（判据：直接看退出码，不接管道）############"
if /var/lib/llm/bin/git ls-remote https://github.com/comfyanonymous/ComfyUI.git HEAD > /var/lib/llm/tmp/gitls.out 2> /var/lib/llm/tmp/gitls.err; then
  echo "  ✓ 通: $(head -1 /var/lib/llm/tmp/gitls.out)"
else
  echo "  ★ 失败:"
  head -2 /var/lib/llm/tmp/gitls.err | sed 's/^/    /'
fi

echo
echo "############ 3. 包装器里的 CA 指向 ############"
grep -E 'CA=|CAINFO|SSL_CERT' /var/lib/llm/bin/git | sed 's/^/    /'
echo "  ca-bundle.crt: $(stat -c '%s 字节' /var/lib/llm/ca-bundle.crt 2>/dev/null || echo 缺失)"

echo
echo "############ 4. 重启 ComfyUI（用修正后的 run.sh）############"
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
echo "############ 5. 本次启动的判据 ############"
SINCE=$(date -d "@$((T0 - 5))" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo '-3min')
echo "  IMPORT FAILED: $(journalctl -u comfyui --since "$SINCE" --no-pager 2>/dev/null | grep -c 'IMPORT FAILED') 次"
echo "  PRESTARTUP FAILED: $(journalctl -u comfyui --since "$SINCE" --no-pager 2>/dev/null | grep -c 'PRESTARTUP FAILED') 次"
echo "  证书类报错: $(journalctl -u comfyui --since "$SINCE" --no-pager 2>/dev/null | grep -ciE 'CERTIFICATE_VERIFY|SSL.*CA|certificate verif') 次"
echo "--- Manager 状态 ---"
journalctl -u comfyui --since "$SINCE" --no-pager 2>/dev/null | grep -iE 'manager' | sed 's/.*run\.sh\[[0-9]*\]: //' | head -5 | sed 's/^/    /'
echo "--- run.sh 选中的 CA（从进程环境读，最权威）---"
PID=$(ss -lntp 2>/dev/null | grep ':8188' | sed -E 's/.*pid=([0-9]+).*/\1/' | head -1)
if [ -n "${PID:-}" ]; then
  tr '\0' '\n' < /proc/$PID/environ 2>/dev/null | grep -E 'SSL_CERT_FILE|GIT_SSL_CAINFO|REQUESTS_CA' | sed 's/^/    /'
fi

echo
echo "############ 6. 模型下载进度 ############"
grep -E '^(OK|FAIL|BEGIN)' /var/lib/llm/tmp/models-dl.log 2>/dev/null | tail -3
grep PROGRESS /var/lib/llm/tmp/models-dl.log 2>/dev/null | tail -1
systemctl is-active iecu-model-dl
df -h /opt/m /opt/update | grep -v Filesystem
