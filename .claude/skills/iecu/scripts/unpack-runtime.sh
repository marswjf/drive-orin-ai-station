#!/bin/sh
# 阶段 3：解包运行时基座。先校验再解，先探层级再解。
# ★ 实体放 /opt/update 不是 /opt/m0 —— 这块板的 /opt/m0 与 /opt/other 同一设备
#   （/opt/other/overlay/upper 是 /var 的可写层宿主），放 6G 会直接吃掉 /var 的空间。
set -u
STAGE=/opt/update/stage
ROOT=/opt/update

echo "############ 1. 校验 tar 包（传输损坏是真实风险）############"
cd "$STAGE" || exit 1
for f in py313.tar.gz cuda-runtime-libs.tar.gz comfyui313-env.tar.gz; do
  [ -f "$f" ] || { echo "  ★ 缺 $f"; exit 1; }
  want=$(grep -E "(^|/)$f\$" archive-manifest.sha256 2>/dev/null | awk '{print $1}' | head -1)
  got=$(sha256sum "$f" | awk '{print $1}')
  if [ -n "$want" ]; then
    [ "$want" = "$got" ] && echo "  ✓ $f 校验一致" || { echo "  ★ $f 校验不符"; echo "    期望 $want"; echo "    实得 $got"; exit 1; }
  else
    echo "  ? $f 清单里没有对应条目，只记录: $got"
  fi
done

echo
echo "############ 2. 探清各包的顶层结构（决定解到哪一层）############"
for f in py313.tar.gz cuda-runtime-libs.tar.gz comfyui313-env.tar.gz; do
  echo "--- $f 前 4 个条目 ---"
  tar -tzf "$f" 2>/dev/null | head -4 | sed 's/^/    /'
done

echo
echo "############ 3. 解 py313 → /var/lib/llm ############"
echo "  （路径必须一模一样，wheel 里的 rpath 才有效）"
tar -C /var/lib/llm -xzf "$STAGE/py313.tar.gz"
if [ -x /var/lib/llm/py313/bin/python3.13 ]; then
  echo "  ✓ 解包完成"
  /var/lib/llm/py313/bin/python3.13 -VV 2>&1 | sed 's/^/    /'
else
  echo "  ★ /var/lib/llm/py313/bin/python3.13 不存在或不可执行"
  ls -la /var/lib/llm/py313/bin/ 2>/dev/null | head -5
fi

echo
echo "############ 4. 解 CUDA 运行时 → $ROOT/cuda122 ############"
mkdir -p "$ROOT/cuda122"
tar -C "$ROOT/cuda122" -xzf "$STAGE/cuda-runtime-libs.tar.gz"
echo "  文件数: $(find "$ROOT/cuda122" -type f | wc -l)（期望约 52）"
echo "  体积: $(du -shx "$ROOT/cuda122" 2>/dev/null | cut -f1)（期望约 2.4G）"
echo "  --- 关键库在不在 ---"
for lib in libcudart.so.12 libcublas.so.12 libcudnn.so.9 libopenblas.so.0 libstdc++.so.6; do
  found=$(find "$ROOT/cuda122" -name "$lib*" -print -quit 2>/dev/null)
  [ -n "$found" ] && echo "    ✓ $lib" || echo "    ★ 缺 $lib"
done
echo "  🔴 --- 绝不能出现的（驱动的一部分，必须用板子自己的）---"
BAD=$(find "$ROOT/cuda122" \( -name 'libcuda.so*' -o -name 'libnvrm*' -o -name 'libnvos*' \) 2>/dev/null)
if [ -n "$BAD" ]; then echo "    ★★★ 发现禁止分发的驱动库："; echo "$BAD" | sed 's/^/      /'; else echo "    ✓ 干净"; fi

echo
echo "############ 5. 解 ComfyUI 环境 → $ROOT/comfyui313 ############"
tar -C "$ROOT" -xzf "$STAGE/comfyui313-env.tar.gz"
if [ -d "$ROOT/comfyui313" ]; then
  echo "  ✓ 解包完成"
  echo "  文件数: $(find "$ROOT/comfyui313" -type f | wc -l)（期望约 49260）"
  echo "  体积: $(du -shx "$ROOT/comfyui313" 2>/dev/null | cut -f1)"
  echo "  --- 关键路径 ---"
  for p in venv/bin/python main.py run.sh custom_nodes; do
    [ -e "$ROOT/comfyui313/$p" ] && echo "    ✓ $p" || echo "    ★ 缺 $p"
  done
  echo "  --- 节点包 ---"
  ls -1 "$ROOT/comfyui313/custom_nodes" 2>/dev/null | sed 's/^/    /'
else
  echo "  ★ $ROOT/comfyui313 不存在，检查包内层级"
  ls -la "$ROOT" | head -10
fi

echo
echo "############ 6. 空间现状 ############"
df -h /opt/update /opt/m /var | grep -vE '^Filesystem'
echo
echo "############ 完成（下一步：mount-stack313.sh + torch 验证）############"
