#!/bin/sh
# 数据盘点：搞清板上有什么、多大、能不能删。全程只读（vblkdev 只以 ro 挂载后立即卸载）。
# 注意陷阱 58：判断分区用量只认 df；du 只用于比较同一挂载点内部的相对大小。
echo "=== A. 分区总览（df 是唯一可信的分区用量）==="
df -h | grep -E 'Filesystem|vblkdev|overlay'
echo
echo "=== B. /opt/update  vblkdev54 40G ==="
ls -la /opt/update/
echo "--- 子目录大小 ---"
du -shx /opt/update/* 2>/dev/null | sort -rh
echo
echo "=== C. /opt/m0  vblkdev56 20G（与 /opt/other 同一设备）==="
ls -la /opt/m0/
echo "--- 子目录大小 ---"
du -shx /opt/m0/* 2>/dev/null | sort -rh
echo
echo "=== D. /opt/m  vblkdev50 30G ==="
ls -la /opt/m/
du -shx /opt/m/* 2>/dev/null | sort -rh
echo
echo "=== E. /opt/backup  vblkdev53 232M ==="
ls -la /opt/backup/
du -shx /opt/backup/* 2>/dev/null | sort -rh
echo
echo "=== F. /app  vblkdev52 4G 只读（智驾应用本体，删不了）==="
ls -la /app/
du -shx /app/* 2>/dev/null | sort -rh | head -12
echo
echo "=== G. /eol（产线测试工具）==="
du -shx /eol 2>/dev/null
echo
echo "=== H. /persistent  vblkdev1 32M ==="
ls -la /persistent/
echo
echo "=== I. /opt/etc  vblkdev55 40M ==="
ls -la /opt/etc/
echo
echo "=== J. vblkdev23  26G  当前未挂载 —— 只读挂载看内容 ==="
mkdir -p /var/lib/probe-mnt/vb23 2>/dev/null
if mount -o ro /dev/vblkdev23 /var/lib/probe-mnt/vb23 2>&1; then
  echo "  ro 挂载成功"
  df -h /var/lib/probe-mnt/vb23 | tail -1
  ls -la /var/lib/probe-mnt/vb23/
  echo "  --- 子目录大小 ---"
  du -shx /var/lib/probe-mnt/vb23/* 2>/dev/null | sort -rh | head -20
  umount /var/lib/probe-mnt/vb23 && echo "  已卸载"
else
  echo "  挂载失败（上面是原因）"
fi
echo
echo "=== K. vblkdev51  4G  /app 的 A/B 备份槽 —— 只读确认（红线 12，绝不写）==="
mkdir -p /var/lib/probe-mnt/vb51 2>/dev/null
if mount -o ro /dev/vblkdev51 /var/lib/probe-mnt/vb51 2>&1; then
  df -h /var/lib/probe-mnt/vb51 | tail -1
  ls /var/lib/probe-mnt/vb51/ | head -12
  umount /var/lib/probe-mnt/vb51 && echo "  已卸载"
else
  echo "  挂载失败"
fi
echo
echo "=== L. 50MB 以上的大文件（按分区分别扫，-xdev 不跨挂载点）==="
for d in /opt/update /opt/m0 /opt/m /app /eol /opt/backup; do
  find "$d" -xdev -type f -size +50M 2>/dev/null | while read -r f; do
    ls -lh "$f" 2>/dev/null | awk '{print $5"\t"$9}'
  done
done | sort -rh | head -30
echo
echo "=== M. 智驾相关进程现状（决定停不停）==="
ps -ef 2>/dev/null | grep -E 'mfrlaunch|execution-man|routingmanager|vsomeip|crash_monitor|sensor|recorder|shadow' | grep -v grep
echo
echo "=== N. 智驾相关 systemd unit ==="
systemctl list-unit-files --no-pager --no-legend 2>/dev/null | grep -viE '^nv_|^systemd|^dbus|^getty|^user|^session|^ssh|^cron|^rsyslog|^apt|^dpkg|^e2scrub|^console|^emergency|^rescue|^blk|^lvm|^md|^mdmon|^plymouth|^quota|^remote|^setvtrgb|^syslog|^ufw|^unattended|^networkd|^resolved|^timesync|^tmp|^udisks|^upower|^wpa|^ modem' | head -40
echo
echo "=== O. FOTA / OTA 服务状态（红线 5 相关）==="
systemctl is-enabled CpApFOTA 2>/dev/null || echo "  CpApFOTA: 无此 unit"
ls -la /app/bin/CpApFOTA 2>/dev/null
