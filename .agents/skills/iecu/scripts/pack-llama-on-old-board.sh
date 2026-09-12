#!/bin/sh
# 在上一块板上把 llama.cpp 整套打成 tar.gz，供拉回本机归档进 baseline。
# ★ 必须打包而不是逐文件拉：目录里有 26 个符号链接，
#   libggml-cuda.so → .so.0 → .so.0.19.0 三层都指向同一个 719 MB 文件，
#   逐文件拉如果解引用就变成 2.1 GB，而且丢掉链接结构后 ldd 会找不到库。
# 上一块板只读 + 只在自己的数据分区写一个临时包，不动任何配置与服务。
set -u
SRC=/var/lib/llm/llama
OUT_DIR=/opt/m0
NAME=llama-dd1ea52-cuda-cpu.tar.gz
OUT=$OUT_DIR/$NAME

echo "=== 1. 上一块板空间（找个放得下的地方）==="
df -h /opt/m0 /opt/m /opt/update /var 2>/dev/null | grep -v '^Filesystem'

echo
echo "=== 2. 源目录确认 ==="
echo "  文件数: $(find $SRC -type f | wc -l)"
echo "  符号链接: $(find $SRC -type l | wc -l)"
echo "  真实体积: $(du -sh $SRC 2>/dev/null | cut -f1)   （注意不能用 du -shx，/var 是 overlay，-x 会漏）"

echo
echo "=== 3. 打包（gzip -1 快速压缩，少占上一块板 CPU —— 它正在跑推理服务）==="
if [ -f "$OUT" ]; then
  echo "  已存在，先删旧包"
  rm -f "$OUT"
fi
cd /var/lib/llm || exit 1
# -h 不加：保留符号链接本身；--numeric-owner 避免用户名解析差异
GZIP=-1 tar czf "$OUT" --numeric-owner llama
RC=$?
echo "  tar 退出码 $RC"
ls -l "$OUT" | awk '{printf "  包体积 %.1f MB\n", $5/1048576}'

echo
echo "=== 4. 包内自检：符号链接必须被保留成链接 ==="
echo "  条目总数: $(tar tzf "$OUT" | wc -l)"
echo "  --- 应该看到 'l' 开头的行（符号链接）---"
tar tvzf "$OUT" 2>/dev/null | awk '{print substr($1,1,1)}' | sort | uniq -c | sed 's/^/    /'
echo "  --- 抽查三层链接 ---"
tar tvzf "$OUT" 2>/dev/null | grep -E 'libggml-cuda\.so' | sed 's/^/    /'

echo
echo "=== 5. SHA-256（拉回本机后要核对）==="
sha256sum "$OUT" | tee "$OUT.sha256"

echo
echo "=== 6. 确认没打扰上一块板服务 ==="
for u in llm-server llm-embedding iecu-panel iecu-frpc; do
  printf "  %-16s %s\n" "$u" "$(systemctl is-active $u 2>/dev/null)"
done
ss -lnt 2>/dev/null | grep -cE ':(8080|8081|9000)' | sed 's/^/  在听的服务端口数: /'
