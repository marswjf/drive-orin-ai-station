#!/bin/sh
# 用 mergerfs 把三个分区并成一个 /var/lib/llm/data 视图。
# 关键设计：
#   1. vblkdev23 已是格式化好的 ext4，只挂载不 mkfs —— 全程不对块设备写，红线 2 不触及
#   2. 各分支只并入 data/ 子目录，厂商原有文件不进合并视图，看起来干净
#   3. 挂载点放 /var/lib/llm 下 —— /opt 在只读根分区上，mkdir /opt/xxx 会失败
#   4. category.create=mfs：写新文件时自动选剩余空间最多的分支
#   5. 不改 fstab（红线 4），持久化改用独立 systemd unit（本脚本只做运行时验证）
set -u

D23=/var/lib/llm/disks/d23
MERGED=/var/lib/llm/data
MFS=/var/lib/llm/bin/mergerfs

echo "=== 1. 挂载 vblkdev23（已有 ext4，不格式化）==="
mkdir -p "$D23"
if mountpoint -q "$D23"; then
  echo "  已挂载"
else
  mount -o rw,noatime,nosuid,nodev /dev/vblkdev23 "$D23" && echo "  ✓ 挂载成功" || { echo "  ★ 挂载失败"; exit 1; }
fi
df -h "$D23" | tail -1

echo
echo "=== 2. 在三个分支上建 data/ 子目录 ==="
for p in "$D23/data" /opt/update/data /opt/m/data; do
  mkdir -p "$p" && echo "  ✓ $p" || echo "  ★ 建不了 $p"
done

echo
echo "=== 3. 各分支当前可用空间 ==="
for p in "$D23" /opt/update /opt/m; do
  df -h "$p" | tail -1 | awk -v p="$p" '{printf "  %-28s %6s 总 / %6s 可用\n", p, $2, $4}'
done

echo
echo "=== 4. mergerfs 挂载 ==="
mkdir -p "$MERGED"
if mountpoint -q "$MERGED"; then
  echo "  已挂载，先卸载重挂"
  umount "$MERGED" 2>/dev/null || fusermount -u "$MERGED" 2>/dev/null
fi
"$MFS" -o category.create=mfs,minfreespace=2G,fsname=iecu-data,use_ino,allow_other,cache.files=partial,dropcacheonclose=true,noatime \
  "$D23/data:/opt/update/data:/opt/m/data" "$MERGED"
RC=$?
echo "  mergerfs 退出码 $RC"
if mountpoint -q "$MERGED"; then
  echo "  ✓ 合并视图已挂载"
else
  echo "  ★ 未挂载成功"
  exit 1
fi

echo
echo "=== 5. 合并后的容量（这就是"一块大盘"）==="
df -h "$MERGED" | tail -1
echo "--- 明细 ---"
df -h | grep -E 'Filesystem|iecu-data|vblkdev23|vblkdev50|vblkdev54'

echo
echo "=== 6. 写入测试：连写三个文件，看是否自动分散到不同分支 ==="
for i in 1 2 3; do
  dd if=/dev/zero of="$MERGED/test-$i.bin" bs=1M count=200 2>/dev/null
done
sync
echo "--- 合并视图里看到的 ---"
ls -lh "$MERGED"/test-*.bin
echo "--- 实际落在哪个分支 ---"
for i in 1 2 3; do
  for b in "$D23/data" /opt/update/data /opt/m/data; do
    [ -f "$b/test-$i.bin" ] && echo "  test-$i.bin -> $b"
  done
done

echo
echo "=== 7. 读写速度实测（600MB）==="
echo "--- 写 ---"
dd if=/dev/zero of="$MERGED/speed.bin" bs=1M count=600 conv=fsync 2>&1 | tail -1
echo "--- 读（先清缓存）---"
sync; echo 3 > /proc/sys/vm/drop_caches 2>/dev/null
dd if="$MERGED/speed.bin" of=/dev/null bs=1M 2>&1 | tail -1

echo
echo "=== 8. 清理测试文件 ==="
rm -f "$MERGED"/test-*.bin "$MERGED/speed.bin"
sync
df -h "$MERGED" | tail -1

echo
echo "=== 9. 单文件跨盘限制确认 ==="
echo "  合并视图总容量是三个分支之和，但单个文件必须装进某一个分支。"
echo "  当前最大单分支可用："
for p in "$D23" /opt/update /opt/m; do
  df -h "$p" | tail -1 | awk -v p="$p" '{printf "    %-28s %s\n", p, $4}'
done

echo
echo "=== 完成（当前是运行时挂载，重启会失效；持久化靠随后的 systemd unit）==="
