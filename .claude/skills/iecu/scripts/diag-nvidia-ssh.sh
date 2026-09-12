#!/bin/sh
# nvidia 密码哈希正确但 SSH 登录失败，查是谁拦的。
echo "=== 1. sshd 有没有 AllowUsers / DenyUsers / AllowGroups ==="
sshd -T 2>/dev/null | grep -iE '^(allowusers|denyusers|allowgroups|denygroups|match)' || echo "  无账户白/黑名单"

echo
echo "=== 2. nvidia 账户是否被锁 / 密码过期 ==="
passwd -S nvidia 2>/dev/null || echo "  passwd -S 不可用"
chage -l nvidia 2>/dev/null | grep -iE 'expire|password' || echo "  chage 不可用"
echo "  shadow 行第2字段前3位: $(awk -F: '$1=="nvidia"{print substr($2,1,3)}' /etc/shadow)"
echo "  shadow 完整字段数: $(awk -F: '$1=="nvidia"{print NF}' /etc/shadow)"
echo "  shadow 各期限字段(3-8): $(awk -F: '$1=="nvidia"{print $3"|"$4"|"$5"|"$6"|"$7"|"$8}' /etc/shadow)"

echo
echo "=== 3. 试着从 sshd 日志看 nvidia 登录被拒的原因 ==="
journalctl -u ssh -u sshd --no-pager 2>/dev/null | grep -i nvidia | tail -8
journalctl _COMM=sshd --no-pager 2>/dev/null | grep -iE 'nvidia|Failed|Accepted|denied' | tail -10

echo
echo "=== 4. PAM 对 sshd 的限制（access.conf / nologin / 组要求）==="
ls -l /etc/nologin /var/run/nologin 2>/dev/null || echo "  无 nologin 文件（不是全局禁登录）"
grep -vE '^#|^$' /etc/security/access.conf 2>/dev/null | head -5 || echo "  access.conf 为空/不存在"
echo "  --- pam sshd 配置里的关键行 ---"
grep -vE '^#|^$' /etc/pam.d/sshd 2>/dev/null | sed 's/^/    /'

echo
echo "=== 5. nvidia 的 home 是否存在且可用（home 不可写有时会拒登）==="
ls -ld /home/nvidia 2>/dev/null || echo "  ★ /home/nvidia 不存在"

echo
echo "=== 6. 对照：root 能登说明 sshd 本身正常，差异只在账户层 ==="
echo "  结论方向：如果 §1 有 AllowUsers 只列了 root，就是它拦的；"
echo "            如果 §5 home 缺失，可能是 login 阶段失败。"
