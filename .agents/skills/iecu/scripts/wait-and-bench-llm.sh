#!/bin/sh
# 等 llm-server 真正加载完（/health 返回 200），然后实测生成速度。
# 判据纪律：端口在听不算数，/health 200 才算；生成速度看 /metrics 的实际计数，不看感觉。
set -u
D=/var/lib/llm
NODE=$D/bin/node

echo "############ 1. 等 /health 变 200（18.2G mmap，基线板 78~95 秒）############"
T0=$(date +%s)
i=0
while [ $i -lt 120 ]; do
  code=$("$NODE" -e '
const http=require("http");
http.get({host:"127.0.0.1",port:8080,path:"/health",timeout:5000},r=>{console.log(r.statusCode);r.resume();process.exit(0)})
 .on("error",()=>{console.log("ERR");process.exit(0)})
 .on("timeout",function(){this.destroy();console.log("TO");process.exit(0)});' 2>/dev/null)
  if [ "$code" = "200" ]; then break; fi
  sleep 3
  i=$((i + 1))
done
T1=$(date +%s)
echo "  /health 200 用时 $((T1 - T0)) 秒（含本脚本启动前已经过的时间，实际加载更长）"
echo "  最后状态码: $code"

echo
echo "############ 2. 加载日志里的关键行 ############"
journalctl -u llm-server --no-pager 2>/dev/null | grep -iE 'load_model|loaded|MTP|draft|n_ctx|flash|offload|mmproj|error' | tail -18 | sed 's/.*run-server\.sh\[[0-9]*\]: //' | sed 's/^/  /'

echo
echo "############ 3. /props：确认模型名、上下文、别名 ############"
"$NODE" - <<'JS'
const http = require('http');
http.get({host:'127.0.0.1', port:8080, path:'/props', timeout:20000}, r => {
  let b=''; r.on('data',d=>b+=d); r.on('end',()=>{
    try {
      const j = JSON.parse(b);
      console.log('  model_alias :', j.model_alias);
      console.log('  model_path  :', (j.model_path||'').split('/').pop());
      console.log('  n_ctx       :', j.default_generation_settings?.n_ctx ?? j.n_ctx);
      console.log('  build       :', j.build_info || '-');
      const s = j.default_generation_settings || {};
      console.log('  采样默认    : temp', s.temperature, 'top_p', s.top_p, 'top_k', s.top_k, 'presence', s.presence_penalty);
    } catch(e) { console.log('  解析失败:', b.slice(0,300)); }
  });
}).on('error', e => console.log('  失败', e.message));
JS

echo
echo "############ 4. 实测生成速度（不思考档，最干净）############"
"$NODE" - <<'JS'
const http = require('http');
const body = JSON.stringify({
  model: 'qwen3.6-35b-a3b',
  messages: [{ role: 'user', content: '用一句话说明什么是边缘计算。' }],
  max_tokens: 160,
  stream: false,
  chat_template_kwargs: { enable_thinking: false },
});
const t0 = Date.now();
const req = http.request({
  host: '127.0.0.1', port: 8080, path: '/v1/chat/completions', method: 'POST',
  headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
  timeout: 180000,
}, r => {
  let b = ''; r.on('data', d => b += d);
  r.on('end', () => {
    const dt = (Date.now() - t0) / 1000;
    try {
      const j = JSON.parse(b);
      const u = j.usage || {};
      console.log('  HTTP', r.statusCode, '| 墙钟', dt.toFixed(1), '秒');
      console.log('  prompt_tokens', u.prompt_tokens, '| completion_tokens', u.completion_tokens);
      if (u.completion_tokens) console.log('  生成速度 ≈', (u.completion_tokens / dt).toFixed(1), 'tok/s（含首字延迟，实际解码更快）');
      console.log('  finish_reason:', j.choices?.[0]?.finish_reason);
      console.log('  正文:', (j.choices?.[0]?.message?.content || '').replace(/\n/g, ' ').slice(0, 160));
    } catch (e) { console.log('  解析失败:', b.slice(0, 400)); }
  });
});
req.on('error', e => console.log('  失败', e.message));
req.on('timeout', () => { req.destroy(); console.log('  超时'); });
req.write(body); req.end();
JS

echo
echo "############ 5. /metrics 的权威计数（速度以它为准）############"
"$NODE" - <<'JS'
const http=require('http');
http.get({host:'127.0.0.1',port:8080,path:'/metrics',timeout:15000},r=>{
  let b='';r.on('data',d=>b+=d);r.on('end',()=>{
    const want=['prompt_tokens_total','prompt_seconds_total','tokens_predicted_total','tokens_predicted_seconds_total','n_decode_total','kv_cache_usage_ratio','requests_processing'];
    const m={};
    for (const line of b.split('\n')) {
      if (line.startsWith('#')) continue;
      const [k,v]=line.split(' ');
      if (!k) continue;
      const key=k.replace('llamacpp:','');
      if (want.includes(key)) m[key]=parseFloat(v);
    }
    for (const k of want) if (k in m) console.log('  '+k.padEnd(32), m[k]);
    if (m.tokens_predicted_total && m.tokens_predicted_seconds_total)
      console.log('  → 解码速度', (m.tokens_predicted_total/m.tokens_predicted_seconds_total).toFixed(1), 'tok/s');
    if (m.prompt_tokens_total && m.prompt_seconds_total)
      console.log('  → prefill  ', (m.prompt_tokens_total/m.prompt_seconds_total).toFixed(1), 'tok/s');
  });
}).on('error',e=>console.log('  失败',e.message));
JS

echo
echo "############ 6. 内存归因（nvmap + RssAnon 才是真实占用）############"
free -m | head -2
echo "--- nvmap ---"
cat /sys/kernel/debug/nvmap/iovmm/clients 2>/dev/null | tail -5
echo "--- llama-server 的 RssAnon ---"
for p in $(pgrep -f 'llama-server' 2>/dev/null); do
  printf "  pid %s  RssAnon %s  cmd %s\n" "$p" \
    "$(awk '/RssAnon/{print $2" "$3}' /proc/$p/status 2>/dev/null)" \
    "$(tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null | grep -oE '\-\-model [^ ]+' | head -1)"
done

echo
echo "############ 7. 面板聚合的 /v1/models ############"
"$NODE" - <<'JS'
const http=require('http');
http.get({host:'127.0.0.1',port:9000,path:'/v1/models',timeout:15000},r=>{
  let b='';r.on('data',d=>b+=d);r.on('end',()=>{
    try{ const j=JSON.parse(b); console.log('  HTTP',r.statusCode); for(const m of (j.data||[])) console.log('   -',m.id); }
    catch(e){ console.log('  ',b.slice(0,300)); }
  });
}).on('error',e=>console.log('  失败',e.message));
JS
