set -e
STAGE=/var/tmp/deploy
LLM=/var/lib/llm

echo "=== 1. 目录 ==="
mkdir -p $LLM/panel $LLM/llama/bin $LLM/logs
ls -d $LLM $LLM/panel $LLM/llama/bin

echo "=== 2. 面板与启动脚本就位（顺手去掉可能的 CRLF）==="
tr -d '\r' < $STAGE/server.js        > $LLM/panel/server.js
cp           $STAGE/index.html         $LLM/panel/index.html
tr -d '\r' < $STAGE/run-server.sh    > $LLM/llama/run-server.sh
tr -d '\r' < $STAGE/run-embedding.sh > $LLM/llama/run-embedding.sh
chmod +x $LLM/llama/run-server.sh $LLM/llama/run-embedding.sh
ls -la $LLM/panel/ $LLM/llama/

echo "=== 3. config.json（已存在则保留，不覆盖用户改动）==="
if [ ! -f $LLM/config.json ]; then
cat > $LLM/config.json <<'JSONEOF'
{
  "model": "/opt/m/llm/Qwen3.6-35B-A3B-UD-IQ4_XS.gguf",
  "mmproj": "/opt/m/llm/mmproj-F16.gguf",
  "ctx": 32768,
  "ngl": 99,
  "port": 8080,
  "threads": 10,
  "embeddingPort": 8081,
  "cacheTypeK": "",
  "cacheTypeV": "",
  "flashAttn": "",
  "extraArgs": []
}
JSONEOF
echo "已创建默认 config.json"
else
echo "config.json 已存在，保留"
fi
cat $LLM/config.json

echo "=== 4. systemd unit（/etc 是 overlay，upperdir 在 /persistent，跨重启持久）==="
for u in iecu-panel llm-server llm-embedding; do
  tr -d '\r' < $STAGE/$u.service > /etc/systemd/system/$u.service
  echo "  installed $u.service"
done
systemctl daemon-reload
df -h /persistent | tail -1

echo "=== 5. 启用并启动面板 ==="
systemctl enable iecu-panel.service
systemctl restart iecu-panel.service
sleep 3
systemctl is-active iecu-panel.service
systemctl status iecu-panel.service --no-pager -l 2>&1 | head -14

echo "=== 6. 自测 ==="
wget -qO- --timeout=8 http://127.0.0.1:9000/api/status 2>/dev/null | head -c 400 || echo "(wget 取 status 失败)"
echo
echo "=== 7. 清理暂存 ==="
rm -rf $STAGE
echo "DONE"
