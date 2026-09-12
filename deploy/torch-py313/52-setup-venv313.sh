#!/bin/bash
# 宿主上执行：给 py3.13 建构建用 venv（/build/venv313），装 torch 的构建期依赖
# 关键：cmake 必须 >= 3.27（focal 自带 3.16 过不了 torch 2.12+ 的 cmake_minimum_required），
#       所以 cmake/ninja 都从 pip 装，不用系统包。
set -e
ROOT=/var/lib/llm/chroot-focal
if ! mount | grep -q "$ROOT/proc"; then sh /var/lib/llm/chroot-focal-mount.sh >/dev/null; fi

cat > "$ROOT/root/venv313-inner.sh" <<'INNER'
#!/bin/bash
set -e
export LC_ALL=C
PY=/var/lib/llm/py313/bin/python3.13
[ -x "$PY" ] || { echo "ABORT: py313 未就绪"; exit 3; }

echo "###### 建 venv ######"
rm -rf /build/venv313
"$PY" -m venv /build/venv313
. /build/venv313/bin/activate
python -VV

echo "###### 升级 pip 并装构建依赖 ######"
pip install -q --upgrade pip setuptools wheel
pip install -q "cmake>=3.31" ninja pyyaml typing_extensions requests \
               filelock jinja2 networkx sympy fsspec packaging six
# numpy：torch 编译期要它的头文件；用 2.x（cp313 有 aarch64 轮子，实测确认）
pip install -q numpy

echo "###### 版本核对 ######"
python -c "import sys;print('python', sys.version.split()[0])"
cmake --version | head -1
ninja --version
python -c "import numpy;print('numpy', numpy.__version__)"
echo "-- 轮子来源确认（应为 manylinux aarch64，不是源码编译）:"
pip list --format=freeze | head -25
echo VENV313-OK
INNER
chmod +x "$ROOT/root/venv313-inner.sh"
chroot "$ROOT" /bin/bash /root/venv313-inner.sh
