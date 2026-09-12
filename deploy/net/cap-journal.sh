#!/bin/bash
# 给系统日志设上限。
#
# 起因：journald 默认按磁盘 10% 收，这块板子 /var 有 20G，等于放任它涨到 2GB。
# 实测已经占了 216MB 且还在涨。日志本身有用，但不能无限膨胀。
#
# 只改 journald 的保留策略，不重启 journald（平台服务，能不动就不动）——
# vacuum 立即生效，配置文件在下次开机生效。
set -u
CONF=/etc/systemd/journald.conf

echo "=== 当前占用 ==="
journalctl --disk-usage

if grep -q '^SystemMaxUse=' "$CONF" 2>/dev/null; then
  echo "已经设过上限，跳过写配置："
  grep -E '^(SystemMaxUse|SystemMaxFileSize|MaxRetentionSec)' "$CONF"
else
  cp -n "$CONF" "$CONF.orig" 2>/dev/null
  cat >> "$CONF" <<'EOF'

# ── IECU 运维加的日志上限（2026-08-12）──────────────────
# 默认是磁盘的 10%，在这块板子上等于 2GB，太多了。
# 200M 大约能存两三周，够排障用。
SystemMaxUse=200M
SystemMaxFileSize=20M
MaxRetentionSec=3week
EOF
  echo "已写入上限到 $CONF（下次开机生效，原文件备份为 $CONF.orig）"
fi

echo
echo "=== 立即收缩到 200M ==="
journalctl --vacuum-size=200M 2>&1 | tail -3
echo
echo "=== 收缩后 ==="
journalctl --disk-usage
df -h /var | tail -1
