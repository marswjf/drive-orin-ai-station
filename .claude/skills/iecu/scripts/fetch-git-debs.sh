#!/bin/sh
# 取 git 需要的 deb。板子能出网，直接用 apt-get download（比手工拼 pool URL 可靠）。
# 注意不是 apt install —— 根分区只读，装不进 /usr；只下 deb，之后 dpkg-deb -x 解到 /var/lib/llm/gitroot。
set -u
DL=/var/lib/llm/dl/git
mkdir -p "$DL"

echo "############ 0. 先看 ComfyUI-Manager 到底为什么失败 ############"
echo "--- PRESTARTUP 段 ---"
journalctl -u comfyui --no-pager 2>/dev/null | grep -B2 -A15 'PRESTARTUP FAILED' | head -25
echo "--- 含 Manager 的错误行 ---"
journalctl -u comfyui --no-pager 2>/dev/null | grep -iE 'manager.*(error|fail)|ModuleNotFoundError|No such file' | head -10
echo "--- git 现状 ---"
if [ -x /var/lib/llm/bin/git ]; then echo "  包装器在"; else echo "  /var/lib/llm/bin/git 不存在"; fi
command -v git >/dev/null 2>&1 && echo "  PATH 里有 git" || echo "  PATH 里没有 git"

echo
echo "############ 1. apt 源可用性 ############"
grep -hE '^deb ' /etc/apt/sources.list /etc/apt/sources.list.d/*.list 2>/dev/null | head -5
echo "--- apt-get update ---"
apt-get update 2>&1 | tail -6

echo
echo "############ 2. 下载 focal 源里的四个包 ############"
cd "$DL" || exit 1
for p in git libcurl3-gnutls libldap-2.4-2 libssh-4; do
  echo "--- $p ---"
  apt-get download "$p" 2>&1 | tail -2
done

echo
echo "############ 3. nettle 3.7 要从 jammy 取（focal 只到 .so.7/.so.5）############"
echo "  原因：板上的 gnutls 比 focal 新，需要 libnettle.so.8 / libhogweed.so.6"
POOL=http://ports.ubuntu.com/ubuntu-ports/pool/main/n/nettle
for f in libnettle8_3.7.3-1build2_arm64.deb libhogweed6_3.7.3-1build2_arm64.deb; do
  if [ -f "$f" ]; then echo "  已有 $f"; continue; fi
  /var/lib/llm/bin/node /var/lib/llm/tmp/dl.js "$POOL/$f" "$DL/$f" 2>&1 | tail -2
done

echo
echo "############ 4. 下载结果 ############"
ls -l "$DL"
echo "  合计 $(ls -1 "$DL"/*.deb 2>/dev/null | wc -l) 个 deb"
