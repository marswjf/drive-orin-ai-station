#!/bin/sh
# 在上一块板上只读查看 llama 目录构成。不修改上一块板任何东西。
echo "=== /var/lib/llm/llama 结构 ==="
ls -la /var/lib/llm/llama/ 2>/dev/null || { echo "  目录不存在"; exit 1; }
echo
echo "=== 各子目录 ==="
for d in /var/lib/llm/llama/*/; do
  [ -d "$d" ] || continue
  echo "--- $d  $(du -shx "$d" 2>/dev/null | cut -f1)  $(find "$d" -type f | wc -l) 个文件 ---"
  ls -1 "$d" | head -12 | sed 's/^/    /'
done
echo
echo "=== 二进制版本 ==="
for b in /var/lib/llm/llama/bin-cuda/llama-server /var/lib/llm/llama/bin/llama-server; do
  if [ -x "$b" ]; then
    echo "--- $b ---"
    ls -l "$b" | sed 's/^/    /'
    "$b" --version 2>&1 | head -3 | sed 's/^/    /'
  else
    echo "  $b 不存在或不可执行"
  fi
done
echo
echo "=== 总体积（要传多少）==="
du -shx /var/lib/llm/llama 2>/dev/null
find /var/lib/llm/llama -type f | wc -l
echo
echo "=== 上一块板自己的服务状态（确认没被我们影响）==="
for u in llm-server llm-embedding iecu-panel iecu-frpc comfyui; do
  printf "  %-16s %s / %s\n" "$u" "$(systemctl is-enabled $u 2>/dev/null)" "$(systemctl is-active $u 2>/dev/null)"
done
