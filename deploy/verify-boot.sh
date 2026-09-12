# 断电重启后的完整验收：验证"插电即用"是否成立
# 用法: node scripts/exec.js --file deploy/verify-boot.sh 600
echo "════════ 1. 本次启动信息 ════════"
printf '  开机至今      : %s\n' "$(uptime -p 2>/dev/null || awk '{printf "%.1f 分钟", $1/60}' /proc/uptime)"
printf '  板上时间      : %s  (RTC 无同步，可能与真实时间有偏差)\n' "$(date)"
printf '  内核          : %s\n' "$(uname -r)"

echo
echo "════════ 2. 网络：__BOARD_LAN_IP__ 有没有自动配上 ════════"
ip -br -4 addr show dev eth.254
if ip -4 addr show dev eth.254 | grep -q '__BOARD_LAN_IP__'; then
  echo "  ★ 局域网 IP 自动恢复成功"
else
  echo "  !! __BOARD_LAN_IP__ 缺失"
  systemctl status iecu-lan-ip --no-pager -l 2>&1 | tail -8
fi

echo
echo "════════ 3. 四个服务是否自动拉起 ════════"
for u in iecu-lan-ip iecu-panel llm-server llm-embedding; do
  A=$(systemctl is-active $u 2>/dev/null)
  E=$(systemctl is-enabled $u 2>/dev/null)
  T=$(systemctl show $u -p ActiveEnterTimestamp --value 2>/dev/null)
  printf '  %-16s %-10s %-10s  起于 %s\n' "$u" "$A" "$E" "$T"
done

echo
echo "════════ 4. 智驾栈有没有偷偷回来 ════════"
printf '  application_start : %s / %s\n' "$(systemctl is-active application_start)" "$(systemctl is-enabled application_start)"
printf '  mfrlaunch 进程数  : %s\n' "$(pgrep -c mfrlaunch 2>/dev/null || echo 0)"

echo
echo "════════ 5. 冷启动耗时（关键：模型要从 eMMC 真读一遍）════════"
journalctl -u llm-server -b 0 --no-pager 2>/dev/null | grep -iE 'starting|load time|model load|server is listening|all slots' | tail -6
echo "  -- systemd 记录的启动完成时刻 --"
systemctl show llm-server -p ActiveEnterTimestamp --value
systemctl show llm-server -p ExecMainStartTimestamp --value

echo
echo "════════ 6. 端口与健康检查 ════════"
ss -tlnp 2>/dev/null | grep -E ':(8080|8081|9000)' | awk '{printf "  监听 %s\n", $4}'
printf '  llm-server /health   : %s\n' "$(wget -qO- --timeout=8 http://127.0.0.1:8080/health 2>&1 | head -c 80)"
printf '  embedding  /health   : %s\n' "$(wget -qO- --timeout=8 http://127.0.0.1:8081/health 2>&1 | head -c 80)"
printf '  面板 api/status      : %s\n' "$(wget -qO- --timeout=8 http://127.0.0.1:9000/api/status 2>&1 | head -c 60)"

echo
echo "════════ 7. 资源 ════════"
free -h | head -2
printf '  GPU 可分配 : %s\n' "$(grep -oE '[0-9]+' /sys/kernel/debug/nvmap/iovmm/free_size 2>/dev/null | head -1 | awk '{printf "%.2f GiB", $1/1073741824}')"
for z in /sys/class/thermal/thermal_zone*/; do
  t=$(cat $z/type 2>/dev/null)
  case "$t" in tj-therm) awk -v x="$(cat $z/temp)" 'BEGIN{printf "  结温 tj    : %.1f C\n", x/1000}';; esac
done
df -h /opt/m /var | tail -2

echo
echo "════════ 8. 实际推理冒烟测试 ════════"
cat > /var/tmp/smoke.js <<'EOF'
const http = require('http');
const t0 = Date.now();
const body = Buffer.from(JSON.stringify({
  model: 'qwen3.6-35b-a3b',
  messages: [{ role: 'user', content: '只回答两个字：正常' }],
  max_tokens: 600, temperature: 0.3,
  chat_template_kwargs: { enable_thinking: false },
}));
const r = http.request({ host: '127.0.0.1', port: 8080, path: '/v1/chat/completions', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': body.length }, timeout: 300000 }, (res) => {
  let b = ''; res.on('data', (c) => b += c);
  res.on('end', () => {
    try {
      const j = JSON.parse(b);
      const m = j.choices && j.choices[0] && j.choices[0].message || {};
      const u = j.usage || {};
      const s = (Date.now() - t0) / 1000;
      console.log(`  回答: ${String(m.content || m.reasoning_content || '(空)').replace(/\n/g, ' ').slice(0, 120)}`);
      console.log(`  ${u.completion_tokens || '?'} tok / ${s.toFixed(1)}s = ${u.completion_tokens ? (u.completion_tokens / s).toFixed(2) : '?'} tok/s`);
    } catch (e) { console.log('  解析失败:', b.slice(0, 200)); }
  });
});
r.on('error', (e) => console.log('  请求失败:', e.message));
r.on('timeout', () => { console.log('  超时'); r.destroy(); });
r.write(body); r.end();
EOF
/var/lib/llm/bin/node /var/tmp/smoke.js
rm -f /var/tmp/smoke.js

echo
echo "════════ 验收结论 ════════"
PASS=1
ip -4 addr show dev eth.254 | grep -q '__BOARD_LAN_IP__' || { echo "  ✗ 局域网 IP 未恢复"; PASS=0; }
for u in iecu-panel llm-server; do
  [ "$(systemctl is-active $u)" = active ] || { echo "  ✗ $u 未运行"; PASS=0; }
done
[ "$(systemctl is-enabled application_start)" = disabled ] || { echo "  ✗ 智驾栈仍会自启"; PASS=0; }
[ "$PASS" = 1 ] && echo "  ★★ 全部通过：插电即用成立"
