#!/bin/sh
# 只读 rootfs 下持久化改静态 IP：临时 remount rw 改配置文件，备份+回读校验后锁回 ro。
# 适用前提：mount | grep ' / ' 显示 ro，且 remount rw 试探成功（secure_boot=0 多半可以）。
# 用法（先按 SKILL.md 阶段7的方法找到"谁在配地址"的文件，再改这个脚本里的变量后执行）：
#   NETF=<配地址的.network或其他配置文件> ETHF=<开机脚本里硬编码旧IP的文件，可选>
#   OLDIP=<旧IP> NEWIP=<新IP> sh persist-static-ip.sh
NETF="${NETF:?配地址的文件路径，如 /usr/lib/systemd/network/xx.network}"
ETHF="${ETHF:-}"
OLDIP="${OLDIP:?旧IP}"
NEWIP="${NEWIP:?新IP}"

mount -o remount,rw / || { echo "REMOUNT_RW_FAIL：这条路走不通，改用软钩子或找厂商配置分区"; exit 1; }

[ -f "${NETF}.orig-bak" ] || cp -a "$NETF" "${NETF}.orig-bak"
sed -i "s#${OLDIP}#${NEWIP}#g" "$NETF"

if [ -n "$ETHF" ] && [ -f "$ETHF" ]; then
  [ -f "${ETHF}.orig-bak" ] || cp -a "$ETHF" "${ETHF}.orig-bak"
  sed -i "s#${OLDIP}#${NEWIP}#g" "$ETHF"
fi
sync
mount -o remount,ro /

echo "===== 回读校验 ====="
echo "--- $NETF ---"; grep -H "$NEWIP" "$NETF"
[ -n "$ETHF" ] && [ -f "$ETHF" ] && { echo "--- $ETHF ---"; grep -Hn "$NEWIP" "$ETHF"; }
echo "--- 备份文件（回滚用：cp 备份覆盖回去再 remount rw/ro）---"
ls -la "${NETF}.orig-bak" "${ETHF}.orig-bak" 2>/dev/null
echo "--- 根分区状态（应为 ro）---"
mount | grep ' / '
echo "--- 残留旧地址检查（应无输出）---"
grep -H "$OLDIP" "$NETF" || echo "  已无残留 OK"
echo
echo "★ 改文件 ≠ 重启生效，必须重启整机验证。重启前确认失联兜底（口令已知/物理可达/备份可回滚）。"
