#!/bin/bash
# 给板子装一份可用的 git —— ComfyUI-Manager 装自定义节点全靠它。
#
# 为什么不是 apt install：板子的根分区是只读的，装不进 /usr；而且板子不能
# 直接出网，得先在 LXC 上把 deb 下好再传过来。
#
# 三个坑（都踩过）：
#  1. ports.ubuntu.com 的 pool 目录混着各发行版的包，`sort -V | tail -1` 会
#     取到 24.04 的版本，它们要 glibc 2.33/2.38，板上只有 2.31。必须按 focal
#     的版本号精确匹配。
#  2. 系统里其实已经有大部分依赖（gnutls / krb5 / ssl / idn2 / tasn1 …）。
#     从 deb 里再带一份反而和系统链条打架，只保留系统真正没有的那几个。
#  3. 板上的 gnutls 比 focal 新，要 nettle 3.7（libnettle.so.8 / libhogweed.so.6），
#     而 focal 的 nettle 只到 .so.7 / .so.5。这两个要单独从 jammy 取，
#     与系统的 7 版共存无害。
#
# 用法：先在 LXC 上跑 fetch 段把 deb 备齐，再把 deb 传到板上跑 install 段。

set -u
G=/var/lib/llm/gitroot
D=/var/lib/llm
DEBS=${1:-/var/lib/llm/dl/git}

echo "===== 解包到 $G（不碰只读的 /usr）====="
rm -rf $G && mkdir -p $G
for d in "$DEBS"/*.deb; do dpkg-deb -x "$d" $G 2>/dev/null; done

L=$G/usr/lib/aarch64-linux-gnu
echo "===== 删掉系统已有的库，避免版本打架 ====="
for b in libgnutls libnettle libhogweed libgmp libidn2 libunistring libtasn1 \
         libp11-kit libffi libssl libcrypto libkrb5 libk5crypto libkrb5support \
         libgssapi_krb5 libcom_err liblber libldap_r libsasl2 libassuan \
         librtmp libpsl libnghttp2; do
  for f in $L/${b}.so* $L/${b}-*.so*; do
    [ -e "$f" ] || continue
    base=$(basename "${f%%.so.*}")
    if ldconfig -p 2>/dev/null | grep -qE "/${base}\.so\.[0-9]"; then rm -f "$f"; fi
  done
done

# nettle 3.7 是例外：系统的 gnutls 需要 .so.8/.so.6，而系统只带到 .so.7/.so.5，
# 所以这两个必须留下（上面的循环会误删，这里再解一次）
for d in "$DEBS"/libnettle8_*.deb "$DEBS"/libhogweed6_*.deb; do
  [ -e "$d" ] && dpkg-deb -x "$d" $G 2>/dev/null
done

echo "===== 装 git 包装脚本 ====="
mkdir -p $D/bin
cat > $D/bin/git <<'SH'
#!/bin/bash
# git 装在 /var/lib/llm/gitroot（根分区只读，装不进 /usr）。
G=/var/lib/llm/gitroot
export LD_LIBRARY_PATH=$G/usr/lib/aarch64-linux-gnu:${LD_LIBRARY_PATH:-}
export GIT_EXEC_PATH=$G/usr/lib/git-core
export GIT_TEMPLATE_DIR=$G/usr/share/git-core/templates
# ★ 2026-08-17 补：CA 证书路径必须在这里设，而且**不能指向 /etc/ssl/certs/ca-certificates.crt**。
#   厂商镜像根本没装 ca-certificates（这块板实测：那个文件、/usr/lib/ssl/cert.pem、
#   /usr/share/ca-certificates 全都不存在，/etc/ssl/certs 是空目录，dpkg 状态 `un`）。
#   缺 CA 时 https 报 `CAfile: none`；指向不存在的文件则报
#   `Problem with the SSL CA cert (path? access rights?)` —— 两种都是同一个根因。
#   解法见 fix-ca-certs.sh：从 node 内置的 145 个根证书生成 /var/lib/llm/ca-bundle.crt。
if [ -s /var/lib/llm/ca-bundle.crt ]; then
  CA=/var/lib/llm/ca-bundle.crt
elif [ -s /etc/ssl/certs/ca-certificates.crt ]; then
  CA=/etc/ssl/certs/ca-certificates.crt
else
  CA=""
fi
if [ -n "$CA" ]; then
  export GIT_SSL_CAINFO=${GIT_SSL_CAINFO:-$CA}
  export SSL_CERT_FILE=${SSL_CERT_FILE:-$CA}
fi
export SSL_CERT_DIR=${SSL_CERT_DIR:-/etc/ssl/certs}
exec $G/usr/bin/git "$@"
SH
chmod +x $D/bin/git

echo "===== 自检 ====="
export LD_LIBRARY_PATH=$L
for b in $G/usr/bin/git $G/usr/lib/git-core/git-remote-https; do
  miss=$(ldd "$b" 2>&1 | grep -E 'not found|version .GLIBC' | head -2)
  printf "  %-22s %s\n" "$(basename $b)" "${miss:-依赖全齐}"
done
$D/bin/git --version

# ★ https 真实性判据：必须直接看 git 的退出码，不能把它接进管道。
#   `git ls-remote ... | head -3` 的退出码是 head 的，永远 0 —— 那样写会把
#   证书验证失败读成"通过"（2026-08-17 实际踩过一次）。
echo "===== https 实测（ls-remote 最轻量，不下载内容）====="
if $D/bin/git ls-remote https://github.com/comfyanonymous/ComfyUI.git HEAD >/tmp/.gitls 2>/tmp/.gitls.err; then
  echo "  ✓ https 可用: $(head -1 /tmp/.gitls | cut -c1-50)"
else
  echo "  ★ https 失败:"; head -2 /tmp/.gitls.err | sed 's/^/    /'
fi
rm -f /tmp/.gitls /tmp/.gitls.err

echo ""
echo "clone 实测（要能出网，板上通常经 LXC 代理）："
echo "  export http_proxy=http://__FRPS_LAN_IP__:PORT https_proxy=http://__FRPS_LAN_IP__:PORT"
echo "  $D/bin/git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git /tmp/t"

# ---------------------------------------------------------------------------
# 在 LXC 上备 deb 的那一段（本脚本不自动跑，按需复制）：
#
# POOL=http://ports.ubuntu.com/ubuntu-ports/pool
# get(){ f=$(curl -s "$POOL/$1/" | tr '"' '\n' | grep -E "^$2$" | sort -V | tail -1); \
#        [ -n "$f" ] && curl -sfLO "$POOL/$1/$f"; }
# get main/g/git            'git_2\.25\.1-.*_arm64\.deb'
# get main/c/curl           'libcurl3-gnutls_7\.68\.0-.*_arm64\.deb'
# get main/o/openldap       'libldap-2\.4-2_2\.4\.49.*_arm64\.deb'
# get main/libs/libssh      'libssh-4_0\.9\.3-.*_arm64\.deb'
# get main/n/nettle         'libnettle8_3\.7\.3-1build2_arm64\.deb'
# get main/n/nettle         'libhogweed6_3\.7\.3-1build2_arm64\.deb'
