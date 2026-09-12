#!/bin/sh
# 阶段 3 续：核实解包结构 → bind 挂载 → 确认 torch 已在 venv 里。
set -u
R=/opt/update

echo "############ 1. cuda122 的文件构成（符号链接也算数）############"
echo "  普通文件 $(find $R/cuda122 -type f | wc -l)"
echo "  符号链接 $(find $R/cuda122 -type l | wc -l)"
echo "  合计     $(find $R/cuda122 \( -type f -o -type l \) | wc -l)   （phase-3 文档说约 52）"

echo
echo "############ 2. comfyui313 的实际两层结构 ############"
echo "--- comfyui313/ 顶层 ---"
ls -1 "$R/comfyui313/" | head -12 | sed 's/^/    /'
echo "--- comfyui313/ComfyUI/ ---"
ls -1 "$R/comfyui313/ComfyUI/" 2>/dev/null | head -14 | sed 's/^/    /'
echo "--- 关键路径复查（按真实层级）---"
for p in venv/bin/python run.sh ComfyUI/main.py ComfyUI/custom_nodes ComfyUI/models; do
  if [ -e "$R/comfyui313/$p" ]; then echo "    ✓ $p"; else echo "    ★ 缺 $p"; fi
done
echo "--- 已装的节点包 ---"
ls -1 "$R/comfyui313/ComfyUI/custom_nodes/" 2>/dev/null | sed 's/^/    /'
echo "--- 文件总数（含符号链接）: $(find "$R/comfyui313" \( -type f -o -type l \) | wc -l)  （文档说约 49260）"

echo
echo "############ 3. bind 挂载（去掉 noexec）############"
sh /var/lib/llm/mount-stack313.sh
echo "--- 挂载结果 ---"
grep -E 'cuda122|comfyui313' /proc/mounts | sed 's/^/    /'

echo
echo "############ 4. venv 里的 torch 是否已就位 ############"
VP=/var/lib/llm/comfyui313/venv/bin/python
if [ -x "$VP" ]; then
  echo "  venv python: $($VP -V 2>&1)"
  export LD_LIBRARY_PATH=/var/lib/llm/cuda122/lib64:${LD_LIBRARY_PATH:-}
  "$VP" - <<'PY' 2>&1 | sed 's/^/  /'
try:
    import torch
    print("torch", torch.__version__)
    print("torch 文件:", torch.__file__)
    print("CUDA 编译版本:", torch.version.cuda)
    print("arch list:", torch.cuda.get_arch_list())
except Exception as e:
    print("★ import torch 失败:", type(e).__name__, e)
PY
else
  echo "  ★ venv python 不可执行: $VP"
fi

echo
echo "############ 5. 空间 ############"
df -h /opt/update /opt/m /var | grep -v '^Filesystem'

echo
echo "############ 6. 模型下载进度（后台在跑）############"
grep -E '^(OK|FAIL|SKIP|BEGIN|RESUME)' /var/lib/llm/tmp/models-dl.log 2>/dev/null | tail -8
echo "--- 最新一行 PROGRESS ---"
grep 'PROGRESS' /var/lib/llm/tmp/models-dl.log 2>/dev/null | tail -1
systemctl is-active iecu-model-dl
