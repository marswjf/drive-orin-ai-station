#!/bin/sh
# 部署 llama.cpp：解包 → 验证二进制 → 起服务 → 真实 HTTP 判据。
# 判据纪律：不看 systemctl is-active，只认「端口在听 + HTTP 有响应」（陷阱 51）。
set -u
D=/var/lib/llm
PKG=/opt/update/stage/llama-dd1ea52-cuda-cpu.tar.gz

echo "############ 0. 重启后原有 unit 是否自恢复 ############"
for u in iecu-lan-ip.service iecu-egress-audi.service var-lib-llm-disks-d23.mount \
         iecu-data.service iecu-frpc-audi.service iecu-panel.service comfyui.service; do
  printf "  %-34s enabled=%-9s active=%s\n" "$u" \
    "$(systemctl is-enabled "$u" 2>/dev/null)" "$(systemctl is-active "$u" 2>/dev/null)"
done
echo "--- 关键状态 ---"
echo "  uptime: $(uptime | sed 's/.*up //; s/,.*load.*//')"
echo "  合并视图: $(df -h /var/lib/llm/data 2>/dev/null | tail -1 | awk '{print $2" 总 / "$4" 可用"}')"
echo "  局域网地址: $(ip -4 -o addr show dev eth 2>/dev/null | awk '{print $4}' | tr '\n' ' ')"
echo "  时间: $(date '+%F %T %Z')  同步=$(timedatectl 2>/dev/null | awk -F': *' '/synchronized/{print $2}')"

echo
echo "############ 1. 解包 llama.cpp ############"
[ -f "$PKG" ] || { echo "  ★ 包不存在: $PKG"; exit 1; }
echo "  包体积: $(stat -c %s "$PKG") 字节"
tar -C "$D" -xzf "$PKG"
echo "  tar 退出码 $?"

echo
echo "############ 2. 解包结果核对（26 个符号链接必须还在）############"
echo "  普通文件: $(find $D/llama -type f | wc -l)（期望 129，含后来放的两个启动脚本会多）"
echo "  符号链接: $(find $D/llama -type l | wc -l)（期望 26）"
echo "  实际体积: $(du -sh $D/llama 2>/dev/null | cut -f1)（期望约 853M；注意别用 du -shx，/var 是 overlay）"
echo "  --- 三层链接 ---"
ls -l "$D/llama/bin-cuda/" | grep -E 'libggml-cuda\.so' | sed 's/^/    /'

echo
echo "############ 3. 二进制自检（设 LD_LIBRARY_PATH，像 run-server.sh 那样）############"
for sub in bin-cuda bin; do
  B=$D/llama/$sub/llama-server
  echo "--- $sub ---"
  [ -e "$B" ] || { echo "    不存在"; continue; }
  chmod 755 "$B" 2>/dev/null
  if LD_LIBRARY_PATH=$D/llama/$sub ldd "$B" 2>&1 | grep -q 'not found'; then
    echo "    ★ 有未解析的库:"
    LD_LIBRARY_PATH=$D/llama/$sub ldd "$B" 2>&1 | grep 'not found' | sed 's/^/      /'
  else
    echo "    依赖全齐 ✓"
  fi
  echo "    libcuda 来自（必须是板子自己的驱动）:"
  LD_LIBRARY_PATH=$D/llama/$sub ldd "$B" 2>&1 | grep -i libcuda | sed 's/^/      /'
  echo "    版本:"
  LD_LIBRARY_PATH=$D/llama/$sub "$B" --version 2>&1 | head -3 | sed 's/^/      /'
done

echo
echo "############ 4. 启动脚本就位（unit 的 ExecStart 指 llama/ 下）############"
ls -l "$D/llama/"*.sh | sed 's/^/  /'
