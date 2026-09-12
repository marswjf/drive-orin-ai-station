#!/bin/sh
# 给板子造一份可用的 CA 证书 bundle。
#
# 为什么需要：厂商镜像**没装 ca-certificates**（2026-08-17 在这块板实测）——
#   /etc/ssl/certs/ca-certificates.crt、/usr/lib/ssl/cert.pem、/usr/share/ca-certificates
#   全部不存在，/etc/ssl/certs 是空目录，dpkg 里 ca-certificates 状态是 `un`（从未安装）。
#   后果：git 的 https 报 `server certificate verification failed. CAfile: none`，
#   pip / uv / requests 一切 TLS 都不可信。
#   ⚠ ComfyUI 的 run.sh 里那句 SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt（A-136）
#     在这块板上指向的是一个**不存在的文件** —— 那个"修复"是空指针。
#
# 为什么不装 ca-certificates deb：根分区只读，装不进 /usr；而且我们已经有更现成的来源——
#   node 二进制里内置了 145 个根证书（tls.rootCertificates），提取出来即可，零额外依赖。
#
# 为什么落在 /var/lib/llm 而不是 gitroot：install-git.sh 开头会 `rm -rf $G`，
#   放 gitroot 里下次装 git 就被删掉了。
set -u
D=/var/lib/llm
OUT=$D/ca-bundle.crt
NODE=$D/bin/node

[ -x "$NODE" ] || { echo "★ 需要先装 node: $NODE"; exit 1; }

echo "=== 系统自带的 CA 状况 ==="
if [ -s /etc/ssl/certs/ca-certificates.crt ]; then
  echo "  系统有 $(grep -c 'BEGIN CERTIFICATE' /etc/ssl/certs/ca-certificates.crt) 个证书，无需本脚本"
  SYS_OK=1
else
  echo "  系统缺 CA bundle（这是厂商镜像的既有状况，不是我们弄坏的）"
  SYS_OK=0
fi

echo
echo "=== 从 node 提取根证书 ==="
"$NODE" -e '
const tls = require("tls"), fs = require("fs");
const ca = tls.rootCertificates;
fs.writeFileSync(process.argv[1], ca.join("\n") + "\n");
console.log("  根证书数量:", ca.length);
console.log("  写出:", process.argv[1], fs.statSync(process.argv[1]).size, "字节");
' "$OUT"
chmod 644 "$OUT"

echo
echo "=== 自检：git 用它能不能走 https ==="
if [ -x "$D/bin/git" ]; then
  GIT_SSL_CAINFO=$OUT "$D/bin/git" ls-remote https://github.com/comfyanonymous/ComfyUI.git HEAD >/tmp/.cachk 2>/tmp/.cachk.err
  if [ $? = 0 ]; then
    echo "  ✓ git https 可用: $(head -1 /tmp/.cachk | cut -c1-46)"
  else
    echo "  ★ git https 仍失败:"; head -2 /tmp/.cachk.err | sed 's/^/    /'
  fi
  rm -f /tmp/.cachk /tmp/.cachk.err
else
  echo "  （git 还没装，跳过）"
fi

echo
echo "=== 自检：python/requests 用它能不能走 https ==="
VP=$D/comfyui313/venv/bin/python
if [ -x "$VP" ]; then
  SSL_CERT_FILE=$OUT REQUESTS_CA_BUNDLE=$OUT "$VP" - <<'PY' 2>&1 | sed 's/^/  /'
import os, ssl, urllib.request
try:
    ctx = ssl.create_default_context(cafile=os.environ["SSL_CERT_FILE"])
    with urllib.request.urlopen("https://pypi.org/simple/", timeout=15, context=ctx) as r:
        print("✓ python https 可用, pypi HTTP", r.status)
except Exception as e:
    print("★ python https 失败:", type(e).__name__, str(e)[:100])
PY
else
  echo "  （venv 还没就位，跳过）"
fi

echo
echo "=== 用法 ==="
echo "  export SSL_CERT_FILE=$OUT"
echo "  export REQUESTS_CA_BUNDLE=$OUT"
echo "  export GIT_SSL_CAINFO=$OUT"
echo "  （comfyui313/run.sh 与 /var/lib/llm/bin/git 都应指向这里）"
