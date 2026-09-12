#!/bin/sh
# 阶段 6 判据：三种模式互斥是否真的生效。
# 判据是端口的实际变化 + 旧模式进程确实退了，不是 systemctl 的自述。
set -u
D=/var/lib/llm

ports() {
  printf "    端口: "
  for p in 8080 8081 8188 9000; do
    ss -lnt 2>/dev/null | grep -q ":$p" && printf "%s✓ " "$p" || printf "%s✗ " "$p"
  done
  printf "\n"
}
states() {
  printf "    unit : "
  for u in llm-server llm-embedding comfyui iecu-panel; do
    printf "%s=%s " "$u" "$(systemctl is-active $u 2>/dev/null)"
  done
  printf "\n"
}
mem() {
  printf "    内存 : available %s MB / nvmap %s\n" \
    "$(free -m | awk '/^Mem:/{print $7}')" \
    "$(awk '/^total/{printf "%.2f GB", $NF/1048576}' /sys/kernel/debug/nvmap/iovmm/clients 2>/dev/null || echo '读不到')"
}

echo "############ 1. 当前（推理模式）############"
ports; states; mem

echo
echo "############ 2. 切到生图模式：start comfyui 应自动停 llm-server ############"
echo "  （comfyui.service 里写着 Conflicts=application_start.service llm-server.service）"
systemctl start comfyui
i=0
while [ $i -lt 60 ]; do ss -lnt 2>/dev/null | grep -q ':8188' && break; sleep 2; i=$((i+1)); done
echo "  8188 起来用了 $((i*2)) 秒"
ports; states; mem
echo "    --- 判据 ---"
ss -lnt 2>/dev/null | grep -q ':8080' && echo "    ★ 8080 还在听，互斥没生效" || echo "    ✓ 8080 已停（llm-server 被自动踢掉）"
pgrep -f 'Qwen3.6-35B' >/dev/null 2>&1 && echo "    ★ 主推理进程还在" || echo "    ✓ 主推理进程已退出"
ss -lnt 2>/dev/null | grep -q ':8081' && echo "    ✓ 8081 仍在（向量服务故意不参与互斥）" || echo "    ★ 8081 被误停了"
ss -lnt 2>/dev/null | grep -q ':9000' && echo "    ✓ 9000 仍在（面板全程不动）" || echo "    ★ 面板断了"

echo
echo "############ 3. 切回推理模式：start llm-server 应自动停 comfyui ############"
systemctl start llm-server
i=0
while [ $i -lt 90 ]; do
  code=$($D/bin/node -e 'const h=require("http");h.get({host:"127.0.0.1",port:8080,path:"/health",timeout:4000},r=>{console.log(r.statusCode);r.resume();process.exit(0)}).on("error",()=>{console.log(0);process.exit(0)}).on("timeout",function(){this.destroy();console.log(0);process.exit(0)})' 2>/dev/null)
  [ "$code" = "200" ] && break
  sleep 3; i=$((i+1))
done
echo "  /health 200 用了 $((i*3)) 秒"
ports; states; mem
echo "    --- 判据 ---"
ss -lnt 2>/dev/null | grep -q ':8188' && echo "    ★ 8188 还在听，互斥没生效" || echo "    ✓ 8188 已停（comfyui 被自动踢掉）"
systemctl is-enabled comfyui | grep -q disabled && echo "    ✓ comfyui 仍是 disabled（生图是临时态，断电重启回推理模式）" || echo "    ★ comfyui 变成 enabled 了"

echo
echo "############ 4. 最终态确认 ############"
for u in iecu-lan-ip iecu-egress-audi var-lib-llm-disks-d23.mount iecu-data iecu-frpc-audi iecu-panel llm-server llm-embedding comfyui; do
  printf "  %-32s enabled=%-9s active=%s\n" "$u" "$(systemctl is-enabled $u 2>/dev/null)" "$(systemctl is-active $u 2>/dev/null)"
done
echo "--- 存储 ---"
df -h /opt/m /opt/update /var/lib/llm/data /var | grep -v '^Filesystem'
echo "--- 温度 ---"
for z in 0 1 2 3; do
  t=$(cat /sys/class/thermal/thermal_zone$z/temp 2>/dev/null)
  [ -n "$t" ] && printf "  zone%s %s°C  " "$z" "$((t/1000))"
done
echo
