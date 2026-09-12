#!/bin/bash
# 设置运维面板的登录密码。在板上执行：
#   /var/lib/llm/panel/set-panel-password.sh '你的密码'
#
# 为什么用 scrypt 而不是 argon2：板上装不了 npm 包，只能用 node 内置的 crypto。
# scrypt 是 Node 自带的正经 KDF，参数取 N=16384 已足够扛离线爆破。
set -u

NODE=/var/lib/llm/bin/node
OUT=/var/lib/llm/panel-auth.json

PW="${1:-}"
if [ -z "$PW" ]; then
  echo "用法: $0 '密码'"
  echo "密码至少 12 位。面板会被公网访问，别用弱口令。"
  exit 2
fi
if [ "${#PW}" -lt 12 ]; then
  echo "拒绝：密码只有 ${#PW} 位，至少要 12 位。"
  exit 2
fi

PANEL_PW="$PW" "$NODE" -e '
const crypto = require("crypto"), fs = require("fs");
const pw = process.env.PANEL_PW;
const N = 16384, r = 8, p = 1;
const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(pw, salt, 64, { N, r, p });
fs.writeFileSync(process.argv[1], JSON.stringify({
  salt: salt.toString("hex"), hash: hash.toString("hex"), N, r, p,
  createdAt: new Date().toISOString(),
}, null, 2), { mode: 0o600 });
console.log("已写入 " + process.argv[1]);
' "$OUT" || exit 1

chmod 600 "$OUT"
echo "面板密码已设置。已登录的会话不受影响，重启面板服务后全部失效："
echo "  systemctl restart iecu-panel"
