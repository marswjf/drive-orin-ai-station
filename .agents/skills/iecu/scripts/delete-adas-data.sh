#!/bin/sh
# 删除板上智驾数据。按 CLAUDE.md §六：绝对路径、先列后删、逐条明确、不用通配符。
#
# 不删的东西（删了会出事）：
#   /opt/m0/overlay  —— 它是 /var 的 overlay upperdir（这块板 /opt/m0 与 /opt/other 同一设备），
#                       删掉等于把 /var 的可写层铲了，服务成片异常
#   /app             —— 只读分区，且 vblkdev51 是它的 A/B 备份槽（红线 12）
#   lost+found       —— 文件系统自身结构
set -u
NAS=/var/lib/llm/mnt/nas
DST=$NAS/iecu-audi-20260817
STATE=$DST/board-state

echo "############ 0. 删除前：确认备份确实在 NAS 上 ############"
if ! mountpoint -q "$NAS" 2>/dev/null; then echo "★ NAS 未挂载，中止删除"; exit 1; fi
for f in opt-update.tar app.tar opt-m0-adas.tar opt-etc-and-eol.tar; do
  if [ -s "$DST/$f" ]; then
    ls -l "$DST/$f" | awk '{print "  ✓ "$9"  "$5" 字节"}'
  else
    echo "  ★ $f 不存在或为空，中止删除"; exit 1
  fi
done

echo
echo "############ 1. 顺手把改造前后的网络脚本单独存一份（很重要的证据）############"
cp -a /opt/update/tn_eth_init.sh.before_wan_20260814_204225 "$STATE/" 2>/dev/null && echo "  before_wan 版本 ✓"
cp -a /opt/update/tn_eth_init.sh.new "$STATE/" 2>/dev/null && echo "  .new 版本 ✓"
cp -a /root/.ssh/authorized_keys "$STATE/root-authorized_keys.txt" 2>/dev/null && echo "  authorized_keys 留证 ✓"

echo
echo "############ 2. 删除前的状态 ############"
echo "--- /opt/update 内容 ---"
ls -la /opt/update/
echo "--- 分区用量 ---"
df -h /opt/update /opt/m0 /opt/m | grep -v Filesystem

echo
echo "############ 3. 逐条删除 /opt/update（绝对路径，不用通配符）############"
for p in /opt/update/source \
         /opt/update/package \
         /opt/update/abup \
         /opt/update/backup \
         /opt/update/map \
         /opt/update/mnt \
         /opt/update/target ; do
  if [ -e "$p" ]; then
    echo "  删除目录 $p （$(du -shx "$p" 2>/dev/null | cut -f1)）"
    rm -rf "$p"
    [ -e "$p" ] && echo "    ★ 仍存在" || echo "    ✓ 已删"
  else
    echo "  跳过（不存在）$p"
  fi
done
for p in /opt/update/fota.log \
         /opt/update/tndoip-c.log \
         /opt/update/mpustate.log \
         /opt/update/fota_flag \
         /opt/update/tn_eth_init.sh.new \
         /opt/update/tn_eth_init.sh.before_wan_20260814_204225 ; do
  if [ -e "$p" ]; then
    rm -f "$p"
    [ -e "$p" ] && echo "  ★ $p 仍存在" || echo "  ✓ 已删 $p"
  fi
done

echo
echo "############ 4. 清 /opt/m0 的智驾残留（overlay 绝对保留）############"
for p in /opt/m0/link_mtbf \
         /opt/m0/lidar \
         /opt/m0/tmp_logs \
         /opt/m0/data \
         /opt/m0/calib_shadow \
         /opt/m0/corefile \
         /opt/m0/sensor_service \
         /opt/m0/switch \
         /opt/m0/FrameTest.bin \
         /opt/m0/vsomeip_17.log \
         /opt/m0/vsomeip_22.log \
         /opt/m0/vsomeip_48.log ; do
  if [ -e "$p" ]; then
    rm -rf "$p"
    [ -e "$p" ] && echo "  ★ $p 仍存在" || echo "  ✓ 已删 $p"
  fi
done
echo "--- 确认 overlay 还在（这条必须是 ✓）---"
[ -d /opt/m0/overlay ] && echo "  ✓ /opt/m0/overlay 完好" || echo "  ★★★ overlay 被删了，/var 有危险"
[ -d /opt/other/overlay/upper ] && echo "  ✓ /var 的 upperdir 完好" || echo "  ★★★ upperdir 丢失"

echo
echo "############ 5. 清系统日志（syslog 占了 553M，在 /var 的 overlay 上）############"
journalctl --vacuum-size=50M 2>&1 | tail -3
for f in /var/log/syslog.back /var/log/syslog.1 ; do
  [ -e "$f" ] && { rm -f "$f"; echo "  ✓ 已删 $f"; }
done
[ -e /var/log/syslog ] && { : > /var/log/syslog; echo "  ✓ 已截断 /var/log/syslog"; }
sync

echo
echo "############ 6. 删除后的存储情况 ############"
echo "--- 全部分区 ---"
df -h | grep -E 'Filesystem|vblkdev|overlay'
echo
echo "--- /opt/update 剩下什么 ---"
ls -la /opt/update/
echo "--- /opt/m0 剩下什么 ---"
ls -la /opt/m0/
echo
echo "--- 未挂载的空闲分区 ---"
grep -q vblkdev23 /proc/mounts && echo "  vblkdev23 已挂载" || echo "  vblkdev23 (26G) 未挂载，可用作数据盘"
grep -q vblkdev51 /proc/mounts && echo "  vblkdev51 已挂载" || echo "  vblkdev51 (4G) 未挂载 —— /app 的 A/B 备份槽，红线 12，不要动"
echo
echo "############ 完成 ############"
