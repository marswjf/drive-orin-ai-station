#!/bin/sh
# 阶段 4：配置并首次启动 ComfyUI。
# 关键验证不是"服务 active"，而是：① 端口真的在听 ② 零 IMPORT FAILED ③ 启动耗时正常
# （陷阱 51：systemctl 说 active 时 ComfyUI 还要 30~40 秒才开始监听；
#   陷阱 54：一个带 matplotlib 依赖的节点包曾让启动从 31 秒涨到 408 秒）
set -u
D=/var/lib/llm

echo "############ 1. 前置目录（根分区只读，缓存必须落在 /var）############"
mkdir -p "$D/home/.cache/huggingface" "$D/home/.cache/torch"
mkdir -p /var/data/sd-models
ls -ld "$D/home/.cache" /var/data/sd-models

echo
echo "############ 2. 模型搜索根（这块板版：不登记 /opt/m0）############"
if [ -f "$D/comfyui313/ComfyUI/extra_model_paths.yaml" ]; then
  cp "$D/comfyui313/ComfyUI/extra_model_paths.yaml" \
     "$D/comfyui313/ComfyUI/extra_model_paths.yaml.bak-from-archive" 2>/dev/null
  echo "  归档自带的那份已备份为 .bak-from-archive"
fi
cp "$D/tmp/extra_model_paths-audi.yaml" "$D/comfyui313/ComfyUI/extra_model_paths.yaml"
echo "  --- 生效的搜索根 ---"
grep -E '^[a-z_]+:|base_path' "$D/comfyui313/ComfyUI/extra_model_paths.yaml" | sed 's/^/    /'

echo
echo "############ 3. 装 unit ############"
systemctl daemon-reload
systemctl disable comfyui 2>/dev/null
echo "  ⚠ 刻意保持 disabled —— 生图是临时态，断电重启应回到推理模式"
systemctl is-enabled comfyui 2>&1

echo
echo "############ 4. 启动（计时）############"
T0=$(date +%s)
systemctl start comfyui
echo "  systemctl start 返回，但这不代表能用了 —— 探端口才算"
LISTEN=0
i=0
while [ $i -lt 90 ]; do
  if ss -lnt 2>/dev/null | grep -q ':8188'; then LISTEN=1; break; fi
  sleep 2
  i=$((i + 1))
done
T1=$(date +%s)
echo "  8188 开始监听耗时: $((T1 - T0)) 秒（基线板约 31 秒）"
[ "$LISTEN" = "1" ] && echo "  ✓ 端口在听" || echo "  ★ 180 秒内没听到 8188"

echo
echo "############ 5. 判据：IMPORT FAILED 必须为 0 ############"
FAILED=$(journalctl -u comfyui --no-pager 2>/dev/null | grep -c 'IMPORT FAILED')
echo "  IMPORT FAILED: $FAILED 次（必须是 0）"
if [ "$FAILED" != "0" ]; then
  echo "  --- 失败详情 ---"
  journalctl -u comfyui --no-pager 2>/dev/null | grep -B2 -A6 'IMPORT FAILED' | tail -40
fi

echo
echo "############ 6. 节点包加载情况 ############"
journalctl -u comfyui --no-pager 2>/dev/null | grep -E 'Import times|seconds.*custom_nodes|^\s+[0-9.]+ seconds' | tail -20

echo
echo "############ 7. 启动日志关键行 ############"
journalctl -u comfyui -n 40 --no-pager 2>/dev/null | grep -viE 'PROGRESS' | tail -30

echo
echo "############ 8. 服务与端口现状 ############"
systemctl is-active comfyui
ss -lntp 2>/dev/null | grep 8188 || echo "  8188 未监听"

echo
echo "############ 9. 内存（ComfyUI 空载占多少）############"
free -m | head -2
echo "--- nvmap（GPU 映射，不计入 RSS）---"
cat /sys/kernel/debug/nvmap/iovmm/clients 2>/dev/null | tail -6 || echo "  读不到"
