#!/bin/sh
# 查"把多个分区并成一块大盘"的三条路各自的前置条件。全程只读，不动任何分区。
#   路 A: mergerfs（FUSE 联合挂载）—— 不格式化、不改 fstab、可逆
#   路 B: LVM（把空分区做成一个大逻辑卷）—— 要格式化，性能最好
#   路 C: 分别挂载 + 符号链接分流 —— 零风险，手工管理
echo "=== 1. FUSE 支持（路 A 的前提）==="
ls -l /dev/fuse 2>/dev/null || echo "  无 /dev/fuse"
grep -qw fuse /proc/filesystems && echo "  内核支持 fuse ✓" || { modprobe fuse 2>/dev/null && grep -qw fuse /proc/filesystems && echo "  fuse 模块加载成功 ✓" || echo "  ★ 内核不支持 fuse"; }
ls /lib/modules/$(uname -r)/kernel/fs/fuse/ 2>/dev/null || echo "  无 fuse 模块文件"
command -v mergerfs >/dev/null 2>&1 && echo "  mergerfs 已装" || echo "  mergerfs 未装（需下载 aarch64 版）"
command -v fusermount fusermount3 2>/dev/null || echo "  无 fusermount"

echo
echo "=== 2. device-mapper / LVM 支持（路 B 的前提）==="
grep -qw device-mapper /proc/devices && echo "  device-mapper 在 ✓" || echo "  ★ 无 device-mapper"
ls -l /dev/mapper/ 2>/dev/null
lsmod 2>/dev/null | grep -E '^dm_|^dm-' || echo "  无 dm_* 模块已加载"
for m in dm_mod dm-mod; do modprobe $m 2>/dev/null && echo "  $m 加载成功"; done
grep -qw device-mapper /proc/devices && echo "  加载后 device-mapper 可用 ✓"
for c in pvcreate vgcreate lvcreate lvm mdadm; do
  p=$(command -v $c 2>/dev/null); echo "  $c -> ${p:-（无）}"
done

echo
echo "=== 3. 各分区的文件系统与 UUID（判断哪些能动）==="
for d in 0 1 21 23 50 51 52 53 54 55 56; do
  dev=/dev/vblkdev$d
  [ -b "$dev" ] || continue
  sz=$(awk -v n="vblkdev$d" '$4==n {printf "%.1fG", $3/1024/1024}' /proc/partitions)
  mp=$(awk -v d="$dev" '$1==d {print $2; exit}' /proc/mounts)
  echo "  $dev  ${sz:-?}  挂载点=${mp:-（未挂载）}"
done

echo
echo "=== 4. /etc/fstab 内容（红线 4：不改它，改用独立 unit）==="
grep -vE '^[[:space:]]*#|^[[:space:]]*$' /etc/fstab 2>/dev/null

echo
echo "=== 5. 由 fstab 自动生成的挂载 unit（要绕开它们就得 mask）==="
systemctl list-units --type=mount --no-pager --no-legend 2>/dev/null | awk '{print "  "$1"  "$4}'

echo
echo "=== 6. 空闲可动的分区确认（内容必须为空才敢动）==="
mkdir -p /var/lib/probe-mnt/x 2>/dev/null
for d in 23 ; do
  dev=/dev/vblkdev$d
  if mount -o ro "$dev" /var/lib/probe-mnt/x 2>/dev/null; then
    n=$(find /var/lib/probe-mnt/x -mindepth 1 -not -name 'lost+found' -not -name '.gitkeep' | wc -l)
    echo "  $dev 非空条目数（排除 lost+found/.gitkeep）: $n"
    umount /var/lib/probe-mnt/x
  fi
done
echo "  /opt/m   非空条目: $(find /opt/m -mindepth 1 -not -name 'lost+found' | wc -l)"
echo "  /opt/update 非空条目: $(find /opt/update -mindepth 1 -not -name 'lost+found' | wc -l)"

echo
echo "=== 7. 当前可用容量汇总 ==="
df -h --output=source,size,used,avail,pcent,target 2>/dev/null | grep -E 'vblkdev|Filesystem' || df -h | grep -E 'vblkdev|Filesystem'
echo
echo "--- 未挂载分区的容量（df 看不到）---"
awk '$4 ~ /vblkdev(23|51)/ {printf "  %s  %.1fG\n", $4, $3/1024/1024}' /proc/partitions

echo
echo "=== 8. 单文件跨盘限制的参考：现有最大分区 ==="
echo "  vblkdev54 (/opt/update) 40G —— mergerfs 下单个文件最大不能超过它"
