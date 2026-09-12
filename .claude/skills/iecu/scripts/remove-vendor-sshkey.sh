#!/bin/sh
# 删除卖家留下的 SSH 公钥，并把整个 SSH 入口查一遍。
# 顺序很重要：先确认密码认证可用，否则删完公钥可能把自己也锁在外面。
set -u

echo "############ 1. 先确认密码认证是开的（否则删完就进不来）############"
echo "--- sshd_config 有效配置 ---"
sshd -T 2>/dev/null | grep -iE '^(passwordauthentication|permitrootlogin|pubkeyauthentication|authorizedkeysfile|challengeresponseauthentication|kbdinteractiveauthentication)' \
  || grep -iE '^\s*(PasswordAuthentication|PermitRootLogin|PubkeyAuthentication|AuthorizedKeysFile)' /etc/ssh/sshd_config
PW=$(sshd -T 2>/dev/null | grep -i '^passwordauthentication' | awk '{print $2}')
if [ "$PW" = "yes" ]; then
  echo "  ✓ 密码认证已开启，删公钥不会锁死自己"
else
  echo "  ★★★ 密码认证状态是 '$PW'，中止！删了公钥可能就进不来了"
  exit 1
fi

echo
echo "############ 2. 删除前：列出所有账户的 authorized_keys ############"
for f in /root/.ssh/authorized_keys /root/.ssh/authorized_keys2 /home/*/.ssh/authorized_keys; do
  if [ -f "$f" ]; then
    echo "--- $f ---"
    ls -l "$f"
    awk '{print "    ["NR"] "$1" ... "$NF}' "$f"
  fi
done
echo "--- 系统级 authorized_keys（若 AuthorizedKeysFile 指向别处）---"
ls -la /etc/ssh/authorized_keys* 2>/dev/null || echo "  无"

echo
echo "############ 3. 本地也留一份备份，再删 ############"
mkdir -p /var/lib/llm/backup-sshkeys
if [ -f /root/.ssh/authorized_keys ]; then
  cp /root/.ssh/authorized_keys /var/lib/llm/backup-sshkeys/root-authorized_keys.removed 2>/dev/null
  cat /root/.ssh/authorized_keys > /var/lib/llm/backup-sshkeys/root-authorized_keys.removed 2>/dev/null
  echo "  已备份到 /var/lib/llm/backup-sshkeys/root-authorized_keys.removed"
  ls -l /var/lib/llm/backup-sshkeys/
  echo "  --- 执行删除 ---"
  rm -f /root/.ssh/authorized_keys
  if [ -f /root/.ssh/authorized_keys ]; then
    echo "  ★ 删除失败，文件仍在"
  else
    echo "  ✓ /root/.ssh/authorized_keys 已删除"
  fi
fi
rm -f /root/.ssh/authorized_keys2 2>/dev/null

echo
echo "############ 4. 其它可能的入口检查 ############"
echo "--- /root/.ssh 目录内容 ---"
ls -la /root/.ssh/ 2>/dev/null
echo "--- 是否有别的私钥留在板上（卖家可能留了跳板凭证）---"
ls -la /root/.ssh/id_* /root/.ssh/*.pem 2>/dev/null || echo "  无私钥文件"
echo "--- known_hosts（能看出卖家从这台连过谁）---"
[ -f /root/.ssh/known_hosts ] && cat /root/.ssh/known_hosts || echo "  无 known_hosts"
echo
echo "--- 除 root 外有登录 shell 的账户 ---"
awk -F: '$3>=1000 && $7 !~ /(nologin|false)$/ {print "    "$1"  uid="$3"  shell="$7}' /etc/passwd
echo "--- 有密码的账户（第二字段不是 ! 或 *）---"
awk -F: '$2 !~ /^[!*]/ && $2 != "" {print "    "$1}' /etc/shadow 2>/dev/null
echo
echo "--- root 的 crontab ---"
crontab -l -u root 2>/dev/null || echo "  无 root crontab"
echo "--- /etc/cron.d 里的非厂商项 ---"
ls -la /etc/cron.d/ 2>/dev/null
echo
echo "--- 监听端口（确认没有多出来的服务）---"
ss -lntp 2>/dev/null

echo
echo "############ 5. 重启 sshd 让配置生效（authorized_keys 是每次读的，其实不需要重启）############"
echo "  authorized_keys 每次认证时读取，无需重启 sshd —— 跳过重启，避免打断当前连接"
echo
echo "############ 6. 验证：当前连接仍在，且公钥已不存在 ############"
[ -f /root/.ssh/authorized_keys ] && echo "  ★ 公钥文件仍在" || echo "  ✓ 公钥文件已不存在"
echo "  当前登录方式：密码（exec.js 用 password 认证），不受影响"
sync
echo
echo "############ 完成 ############"
