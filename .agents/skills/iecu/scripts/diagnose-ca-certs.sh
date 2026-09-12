#!/bin/sh
# 查系统 CA 证书状态。git 走 https 靠它；node 自带 CA bundle 所以 node 不受影响
# （这也解释了为什么 dl.js 能下载而 git 不能——两者的信任源不是一个）。
echo "=== 1. 常见 CA 路径 ==="
for p in /etc/ssl/certs/ca-certificates.crt /usr/lib/ssl/cert.pem /etc/pki/tls/certs/ca-bundle.crt \
         /usr/share/ca-certificates /etc/ssl/certs; do
  if [ -e "$p" ]; then
    if [ -d "$p" ]; then
      echo "  [目录] $p  条目数 $(ls -1 "$p" 2>/dev/null | wc -l)"
    else
      echo "  [文件] $p  $(stat -c '%s 字节 权限 %a' "$p" 2>/dev/null)"
    fi
  else
    echo "  [缺失] $p"
  fi
done

echo
echo "=== 2. ca-certificates.crt 的真实情况 ==="
F=/etc/ssl/certs/ca-certificates.crt
if [ -e "$F" ]; then
  ls -lL "$F" 2>&1 | sed 's/^/  /'
  echo "  是符号链接吗: $(readlink -f "$F" 2>/dev/null)"
  echo "  字节数: $(stat -Lc %s "$F" 2>/dev/null)"
  echo "  含多少个证书: $(grep -c 'BEGIN CERTIFICATE' "$F" 2>/dev/null)"
  echo "  前两行:"
  head -2 "$F" 2>/dev/null | sed 's/^/    /'
else
  echo "  ★ 不存在"
fi

echo
echo "=== 3. ca-certificates 包装了没 ==="
dpkg -l ca-certificates 2>/dev/null | tail -2

echo
echo "=== 4. /etc 是 overlay，看上层有没有覆盖 ==="
ls -la /persistent/driveos/security/etc/ssl 2>/dev/null | head -5 || echo "  上层没有 ssl 目录（说明用的是下层原版）"

echo
echo "=== 5. 对照：node 能走 https（它自带 CA，不看系统）==="
/var/lib/llm/bin/node -e '
const https=require("https");
https.get("https://github.com/", {timeout:12000}, r=>{console.log("  node → github HTTP",r.statusCode,"✓");r.destroy();process.exit(0)})
 .on("error",e=>{console.log("  node 也失败:",e.message);process.exit(1)});'

echo
echo "=== 6. 拿 node 的 CA 生成一份给 git 用（如果系统那份坏了）==="
/var/lib/llm/bin/node -e '
const tls=require("tls"), fs=require("fs");
const ca=tls.rootCertificates;
console.log("  node 内置根证书数量:", ca.length);
const out="/var/lib/llm/gitroot/ca-bundle.crt";
fs.writeFileSync(out, ca.join("\n")+"\n");
console.log("  已写出:", out, fs.statSync(out).size, "字节");'

echo
echo "=== 7. 用这份 CA 重测 git https ==="
export GIT_SSL_CAINFO=/var/lib/llm/gitroot/ca-bundle.crt
if /var/lib/llm/bin/git ls-remote https://github.com/comfyanonymous/ComfyUI.git HEAD >/tmp/.gl 2>/tmp/.gle; then
  echo "  ✓ 用 node 的 CA 成功: $(head -1 /tmp/.gl | cut -c1-50)"
else
  echo "  ★ 仍失败:"; head -2 /tmp/.gle | sed 's/^/    /'
fi
rm -f /tmp/.gl /tmp/.gle
