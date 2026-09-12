#!/bin/sh
# 清掉上一块板上的临时打包目录，确认没给上一块板留垃圾、也没影响它的服务。
set -u
T=/opt/m0/llama-pack
if [ -d "$T" ]; then
  echo "删除前:"
  ls -l "$T" | sed 's/^/  /'
  rm -rf "$T"
  if [ -d "$T" ]; then echo "  ★ 删除失败"; else echo "  ✓ 已删除"; fi
else
  echo "  目录不存在（已清理过）"
fi

echo
echo "=== 上一块板空间 ==="
df -h /opt/m0 /opt/m /opt/update /var | grep -v '^Filesystem'

echo
echo "=== 上一块板服务复查（确认我们全程只读、没打扰它）==="
for u in llm-server llm-embedding iecu-panel iecu-frpc comfyui; do
  printf "  %-16s enabled=%-9s active=%s\n" "$u" "$(systemctl is-enabled $u 2>/dev/null)" "$(systemctl is-active $u 2>/dev/null)"
done
echo "--- 端口 ---"
ss -lnt 2>/dev/null | grep -E ':(8080|8081|8188|9000)' | awk '{print "  "$4}'
echo "--- 当前加载的模型（上一块板是 q38 档，我们没动它的预设）---"
journalctl -u llm-server --no-pager 2>/dev/null | grep -oE "loading model '[^']+'" | tail -1 | sed 's/^/  /'
echo "--- 隧道 ---"
journalctl -u iecu-frpc -n 3 --no-pager 2>/dev/null | sed 's/.*frpc\[[0-9]*\]: //' | tail -3 | sed 's/^/  /'

echo
echo "=== 顺便记录：上一块板将来做 mergerfs 合并的可行性（只读采集，不动手）==="
echo "  fuse 支持: $(grep -qw fuse /proc/filesystems && echo 有 || echo '需 modprobe fuse')"
echo "  /dev/fuse: $([ -e /dev/fuse ] && echo 在 || echo 缺)"
echo "  fusermount: $(command -v fusermount >/dev/null 2>&1 && echo 有 || echo 缺)"
echo "  mergerfs: $([ -x /var/lib/llm/bin/mergerfs ] && echo 已装 || echo 未装)"
echo "  --- 可合并的分区剩余量 ---"
for p in /opt/m0 /opt/m /opt/update; do
  df -h "$p" | tail -1 | awk -v p="$p" '{printf "    %-14s %6s 总 / %6s 可用\n", p, $2, $4}'
done
echo "  ⚠ 上一块板与新板的关键差异：上一块板 /opt/m0 是 vblkdev23 独立 26G 设备（可放模型），"
echo "    新板 /opt/m0 是 vblkdev56、与 /opt/other 同设备（是 /var 的宿主，不能放）。"
