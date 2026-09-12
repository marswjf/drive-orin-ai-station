#!/bin/sh
# 查清上一块板 llama 目录的真实位置与体积。只读。
# 起因：du -shx 报 12K 但有 129 个文件 —— -x 不跨设备（陷阱 58），
# 说明 bin/bin-cuda 可能是挂载点或符号链接，实体在别的分区。
echo "=== 1. 是不是挂载点 ==="
grep -E 'llama|llm' /proc/mounts | sed 's/^/  /'
echo "--- 逐个查 ---"
for p in /var/lib/llm/llama /var/lib/llm/llama/bin /var/lib/llm/llama/bin-cuda; do
  if mountpoint -q "$p" 2>/dev/null; then echo "  $p 是挂载点"; else echo "  $p 不是挂载点"; fi
  echo "    所在设备: $(stat -c %d "$p" 2>/dev/null)  真实路径: $(readlink -f "$p")"
done

echo
echo "=== 2. 目录项本身（看有没有符号链接）==="
ls -la /var/lib/llm/llama/ | sed 's/^/  /'
echo "--- bin/ 前 6 项详情 ---"
ls -la /var/lib/llm/llama/bin/ | head -8 | sed 's/^/  /'
echo "--- bin-cuda/ 前 6 项详情 ---"
ls -la /var/lib/llm/llama/bin-cuda/ | head -8 | sed 's/^/  /'

echo
echo "=== 3. 真实体积（du 不带 -x，跨设备也算）==="
du -sh /var/lib/llm/llama 2>/dev/null | sed 's/^/  /'
du -sh /var/lib/llm/llama/bin /var/lib/llm/llama/bin-cuda 2>/dev/null | sed 's/^/  /'
echo "--- 用 find+stat 累加（最可靠，绕开 du 的设备边界）---"
echo "  bin:      $(find /var/lib/llm/llama/bin -type f -printf '%s\n' 2>/dev/null | awk '{s+=$1} END {printf "%.1f MB / %d 个文件", s/1048576, NR}')"
echo "  bin-cuda: $(find /var/lib/llm/llama/bin-cuda -type f -printf '%s\n' 2>/dev/null | awk '{s+=$1} END {printf "%.1f MB / %d 个文件", s/1048576, NR}')"
echo "  合计:     $(find /var/lib/llm/llama -type f -printf '%s\n' 2>/dev/null | awk '{s+=$1} END {printf "%.1f MB / %d 个文件", s/1048576, NR}')"

echo
echo "=== 4. 最大的 10 个文件 ==="
find /var/lib/llm/llama -type f -printf '%s %p\n' 2>/dev/null | sort -rn | head -10 | awk '{printf "  %8.1f MB  %s\n", $1/1048576, $2}'

echo
echo "=== 5. 符号链接清单（拉取时要保留还是解引用）==="
find /var/lib/llm/llama -type l -printf '  %p -> %l\n' 2>/dev/null | head -20
echo "  符号链接总数: $(find /var/lib/llm/llama -type l 2>/dev/null | wc -l)"

echo
echo "=== 6. 用正确方式验证二进制（设 LD_LIBRARY_PATH，像 run-server.sh 那样）==="
for d in bin-cuda bin; do
  B=/var/lib/llm/llama/$d/llama-server
  [ -x "$B" ] || continue
  echo "--- $d ---"
  LD_LIBRARY_PATH=/var/lib/llm/llama/$d "$B" --version 2>&1 | head -4 | sed 's/^/    /'
done

echo
echo "=== 7. run-server.sh 怎么设 LD_LIBRARY_PATH 的 ==="
grep -nE 'LD_LIBRARY_PATH|BINDIR|exec ' /var/lib/llm/llama/run-server.sh | sed 's/^/  /'

echo
echo "=== 8. 上一块板服务现在的端口（确认它健康，我们没打扰它）==="
ss -lntp 2>/dev/null | grep -E ':(8080|8081|8188|9000)' | awk '{print "  "$4"  "$6}'
echo "--- llm-server 加载完了吗 ---"
journalctl -u llm-server -n 5 --no-pager 2>/dev/null | sed 's/.*run-server\.sh\[[0-9]*\]: //' | tail -5
