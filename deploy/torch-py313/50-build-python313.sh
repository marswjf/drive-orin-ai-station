#!/bin/bash
# 宿主上执行：源码构建 CPython 3.13.15 → /var/lib/llm/py313
# 日志: /opt/m0/torchbuild/py313.log
#
# 为什么要离开 Python 3.10（2026-08-15 实测的硬数据，不是偏好）：
#   numpy 2.5.2 / scipy 1.18.0 / av 18.1.0 都**已经不再提供 cp310 的 aarch64 轮子**，
#   而 ComfyUI 的 requirements 明写 av>=16.0.0。留在 3.10 等于每装一个新包都要源码编译。
#   cp312 / cp313 / cp314 的轮子覆盖实测完全一致，所以取 3.13：
#   与 3.14 在包生态上零差距，但成熟一档（torchvision 的 python_requires 里
#   明确写着 !=3.14.1，说明 3.14 系出过兼容事故），EOL 2029-10。
#
# 为什么 prefix 是 /var/lib/llm/py313：该路径经 bind 挂载在 chroot 内外完全一致，
# --enable-shared 写进 ELF 的 rpath 在宿主上直接生效，不需要重定位（沿用 py310 的做法）。
# 用默认 gcc-9 编解释器（C 代码，不引入新 libstdc++ 依赖）；gcc-13 只用于编 torch。
set -e
ROOT=/var/lib/llm/chroot-focal
LOG=/opt/m0/torchbuild/py313.log
PYVER=3.13.15

if ! mount | grep -q "$ROOT/var/lib/llm/py313"; then
  echo "[mount] py313 尚未 bind，先跑挂载脚本"
  sh /var/lib/llm/chroot-focal-mount.sh >/dev/null
fi

cat > "$ROOT/root/py313-inner.sh" <<INNER
#!/bin/bash
set -e
export LC_ALL=C
PREFIX=/var/lib/llm/py313
PYVER=$PYVER
echo "###### \$(date -Is) CPython \$PYVER 构建开始 ######"
mkdir -p /build/dl && cd /build/dl
[ -f "Python-\$PYVER.tgz" ] || curl -fL -O "https://www.python.org/ftp/python/\$PYVER/Python-\$PYVER.tgz"
ls -la "Python-\$PYVER.tgz"
cd /build
rm -rf "Python-\$PYVER"
tar -xzf "dl/Python-\$PYVER.tgz"
cd "Python-\$PYVER"
./configure \
  --prefix="\$PREFIX" \
  --enable-shared \
  --with-ensurepip=install \
  --enable-loadable-sqlite-extensions \
  --with-system-ffi \
  LDFLAGS="-Wl,-rpath,\$PREFIX/lib"
make -j11
make install
echo "###### 安装完成，自检 ######"
"\$PREFIX/bin/python3.13" -VV
"\$PREFIX/bin/python3.13" -c "import ssl,sqlite3,lzma,bz2,ctypes,zlib,readline;print('stdlib 关键模块 OK', ssl.OPENSSL_VERSION)"
"\$PREFIX/bin/python3.13" -m pip --version
echo "###### 体积 ######"
du -sh "\$PREFIX"
echo "###### \$(date -Is) PY313-DONE ######"
INNER
chmod +x "$ROOT/root/py313-inner.sh"

rm -f "$LOG"
setsid nohup chroot "$ROOT" /bin/bash /root/py313-inner.sh > "$LOG" 2>&1 < /dev/null &
echo "launched pid=$!  log=$LOG"
sleep 3
head -5 "$LOG" 2>/dev/null
