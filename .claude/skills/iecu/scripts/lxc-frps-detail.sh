#!/bin/sh
# 查 frps 版本与目录内容，为板上装匹配版本的 frpc 做准备。token 不输出。
echo "=== 1. frps 目录内容 ==="
ls -la /opt/iecu-edge/frps/

echo
echo "=== 2. frps 版本 ==="
docker exec iecu-frps /opt/frps --version 2>&1 || echo "  取不到"

echo
echo "=== 3. frps.toml（token/password 脱敏）==="
sed -E 's/(token[[:space:]]*=[[:space:]]*")[^"]*/\1<REDACTED>/; s/(password[[:space:]]*=[[:space:]]*")[^"]*/\1<REDACTED>/' \
  /opt/iecu-edge/frps/frps.toml | grep -vE '^[[:space:]]*#|^[[:space:]]*$'

echo
echo "=== 4. token 状态（只判断是否占位符，不打印内容）==="
T=$(grep -E '^[[:space:]]*auth\.token' /opt/iecu-edge/frps/frps.toml | sed -E 's/.*=[[:space:]]*"([^"]*)".*/\1/')
echo "  长度 ${#T} 字符"
if [ "$T" = "REPLACE_TOKEN" ] || [ -z "$T" ]; then
  echo "  ★ 仍是占位符，隧道认证没配好"
else
  echo "  ✓ 已是真实 token"
fi

echo
echo "=== 5. LXC 上有没有现成的 frpc 二进制可直接复用 ==="
ls -la /opt/iecu-edge/frps/frpc 2>/dev/null || echo "  frps 目录里没有 frpc"
find / -maxdepth 4 -name 'frpc' -type f 2>/dev/null | head -5 || true
echo "--- 路由器上那套 frpc 不在本机，跳过 ---"

echo
echo "=== 6. 架构确认（LXC 是 amd64，板子是 aarch64，二进制不能直接搬）==="
uname -m
file /opt/iecu-edge/frps/frps 2>/dev/null | head -1 || echo "  无 file 命令"

echo
echo "=== 7. Caddyfile 的 iecu 段全文（要改上游 .15 → .16）==="
sed -n '15,50p' /opt/iecu-edge/Caddyfile
