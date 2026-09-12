#!/bin/sh
# 屏蔽卖家公钥。/root 与 /home 都在只读根分区，文件删不掉（删要 remount,rw 写厂商根分区 = 红线 2），
# 改走 sshd 配置：把 AuthorizedKeysFile 指到我们控制的 /etc/ssh/authorized_keys.d/%u
# （/etc 是 overlay，可写且跨重启持久）。那两个 authorized_keys 从此不被读取。
#
# 安全次序：写配置 → sshd -t 语法测试 → 只有通过才 reload → reload 用 reload 不用 restart
# （配置有错时 reload 失败会保留旧配置继续服务，restart 可能让 sshd 起不来 = 彻底失联）
set -u

CONF=/etc/ssh/sshd_config
KEYDIR=/etc/ssh/authorized_keys.d
BAK=/etc/ssh/sshd_config.bak-iecu-20260817

echo "############ 1. 现状 ############"
echo "--- 生效的 AuthorizedKeysFile ---"
sshd -T 2>/dev/null | grep -i '^authorizedkeysfile'
echo "--- 主配置里是否有 Include ---"
grep -nE '^\s*Include' "$CONF" || echo "  无 Include 指令（直接改主配置）"
echo "--- 卖家公钥的两个位置 ---"
ls -l /root/.ssh/authorized_keys /home/nvidia/.ssh/authorized_keys 2>/dev/null

echo
echo "############ 2. 建我们自己的空 keys 目录 ############"
mkdir -p "$KEYDIR"
chmod 755 "$KEYDIR"
# 建空的 root / nvidia 条目，明确表示"这里就是空的"
: > "$KEYDIR/root"
: > "$KEYDIR/nvidia"
chmod 644 "$KEYDIR/root" "$KEYDIR/nvidia"
ls -la "$KEYDIR"

echo
echo "############ 3. 备份主配置 ############"
if [ ! -f "$BAK" ]; then
  cp "$CONF" "$BAK" 2>/dev/null || cat "$CONF" > "$BAK"
  echo "  已备份 → $BAK"
else
  echo "  备份已存在 → $BAK"
fi
ls -l "$BAK"

echo
echo "############ 4. 写入 AuthorizedKeysFile 指向 ############"
# 先去掉已有的 AuthorizedKeysFile 行（若有），再追加我们的
grep -v -iE '^\s*AuthorizedKeysFile' "$CONF" > /tmp/sshd_config.new 2>/dev/null
cat >> /tmp/sshd_config.new <<'SSHCONF'

# ===== [IECU 2026-08-17] 屏蔽卖家遗留公钥 =====
# /root/.ssh/authorized_keys 与 /home/nvidia/.ssh/authorized_keys 里有卖家遗留（vendor@buildhost）的公钥，
# 两个文件在只读根分区上删不掉，改为把 AuthorizedKeysFile 指到本机控制的空目录。
# 要恢复公钥登录：把自己的公钥写进 /etc/ssh/authorized_keys.d/<用户名>
AuthorizedKeysFile /etc/ssh/authorized_keys.d/%u
# ===== [IECU end] =====
SSHCONF
cat /tmp/sshd_config.new > "$CONF"
rm -f /tmp/sshd_config.new
echo "  --- 写入后的相关行 ---"
grep -nE 'AuthorizedKeysFile|IECU' "$CONF"

echo
echo "############ 5. 语法测试（不通过就回滚，绝不 reload）############"
if sshd -t 2>&1; then
  echo "  ✓ sshd -t 通过"
else
  echo "  ★ 语法错误，回滚配置"
  cat "$BAK" > "$CONF"
  sshd -t && echo "  已回滚且语法正常" || echo "  ★★★ 回滚后仍异常，人工介入"
  exit 1
fi

echo
echo "############ 6. reload（不用 restart，避免起不来就彻底失联）############"
systemctl reload sshd 2>&1 && echo "  ✓ reload 成功" || { echo "  ★ reload 失败，回滚"; cat "$BAK" > "$CONF"; systemctl reload sshd; exit 1; }
sleep 2
systemctl is-active sshd

echo
echo "############ 7. 验证生效 ############"
echo "--- 现在生效的 AuthorizedKeysFile ---"
sshd -T 2>/dev/null | grep -i '^authorizedkeysfile'
echo "--- 它指向的文件是空的 ---"
wc -c "$KEYDIR/root" "$KEYDIR/nvidia"
echo "--- 卖家公钥文件还在（只读分区删不掉），但已不在读取路径上 ---"
ls -l /root/.ssh/authorized_keys /home/nvidia/.ssh/authorized_keys 2>/dev/null
echo "--- 密码认证仍开启（我们靠它登录）---"
sshd -T 2>/dev/null | grep -iE '^(passwordauthentication|permitrootlogin)'

echo
echo "############ 8. 顺带查清那两个新出现的监听端口 ############"
ss -lntp 2>/dev/null | grep -E '34701|34213|LISTEN' | head -8
echo "--- NFS 客户端连接（34701/34213 疑似 NFSv4 callback）---"
cat /proc/fs/nfsfs/servers 2>/dev/null || echo "  无 /proc/fs/nfsfs/servers"
cat /proc/fs/nfsfs/volumes 2>/dev/null | head -5
echo "--- 内核 NFS 相关模块 ---"
lsmod 2>/dev/null | grep -E '^nfs|^rpcsec|^sunrpc'

echo
echo "############ 9. 其余账户风险（供决策，本脚本不改）############"
echo "--- 有密码且有登录 shell 的账户 ---"
for u in root nvidia; do
  sh=$(getent passwd "$u" | cut -d: -f7)
  echo "  $u  shell=$sh"
done
echo "  提醒：nvidia 账户也有密码且 shell 是 /bin/bash，PermitRootLogin 也是 yes。"
echo "  IECU_GUARD 已拦住非内网新入站，公网进不来；局域网内仍可用密码登录这两个账户。"
sync
echo
echo "############ 完成 ############"
