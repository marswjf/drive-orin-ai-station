#!/bin/sh
# 建 iecufrp 专用用户、修配置权限、启动反向隧道并验证注册。
set -u

echo "=== 1. 建 iecufrp 用户（固定 uid 998，与上一块板保持一致便于维护）==="
if id iecufrp >/dev/null 2>&1; then
  echo "  已存在: $(id iecufrp)"
else
  # 998 可能被占，被占就让系统分配
  if getent passwd 998 >/dev/null 2>&1; then
    echo "  uid 998 已被 $(getent passwd 998 | cut -d: -f1) 占用，改由系统分配"
    groupadd -r iecufrp 2>/dev/null
    useradd -r -g iecufrp -s /usr/sbin/nologin -d /var/lib/llm/frp -M iecufrp
  else
    groupadd -g 998 iecufrp 2>/dev/null
    useradd -r -u 998 -g 998 -s /usr/sbin/nologin -d /var/lib/llm/frp -M iecufrp
  fi
  id iecufrp && echo "  ✓ 已建立" || echo "  ★ 建立失败"
fi

echo
echo "=== 2. 配置与二进制的归属和权限 ==="
chown iecufrp:iecufrp /var/lib/llm/frp/frpc.toml
chmod 600 /var/lib/llm/frp/frpc.toml
chown root:iecufrp /var/lib/llm/frp/frpc
chmod 750 /var/lib/llm/frp/frpc
chown root:iecufrp /var/lib/llm/frp
chmod 750 /var/lib/llm/frp
ls -la /var/lib/llm/frp/
echo "  --- 确认 iecufrp 真的读得到配置 ---"
su -s /bin/sh -c 'head -1 /var/lib/llm/frp/frpc.toml >/dev/null' iecufrp && echo "  ✓ 可读" || echo "  ★ 读不到，unit 会起不来"

echo
echo "=== 3. 启动隧道 ==="
systemctl daemon-reload
systemctl enable iecu-frpc-audi 2>&1 | tail -2
systemctl start iecu-frpc-audi 2>&1
sleep 6
echo "--- unit 状态 ---"
systemctl is-enabled iecu-frpc-audi
systemctl is-active iecu-frpc-audi

echo
echo "=== 4. 隧道日志（看是否注册成功）==="
journalctl -u iecu-frpc-audi -n 25 --no-pager 2>/dev/null | tail -25

echo
echo "=== 5. 判据：两个 proxy 是否都 start 成功 ==="
OK=$(journalctl -u iecu-frpc-audi --no-pager 2>/dev/null | grep -c 'start proxy success')
ERR=$(journalctl -u iecu-frpc-audi --no-pager 2>/dev/null | grep -ciE 'start error|login to server failed|authentication failed|port already used')
echo "  start proxy success: $OK 次（期望 2）"
echo "  错误行: $ERR 次（期望 0）"
if [ "$OK" -ge 2 ] && [ "$ERR" -eq 0 ]; then
  echo "  ✓ iecu2-ssh 与 iecu2-panel 都已注册到 frps"
else
  echo "  ★ 未全部注册，看上面的日志"
fi

echo
echo "=== 6. 出网路径确认（隧道是主动连出，走 table 100）==="
ip rule show | grep -E '30480|30490|30500'
getent hosts __PUBLIC_DOMAIN__ || echo "  ★ 域名解析失败，隧道连不出去"
