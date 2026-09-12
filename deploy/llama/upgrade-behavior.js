// 换 llama.cpp 版本前后的**行为**采样。与 api-fingerprint.js（只看字段名）互补：
// 这里看的是"同样的请求，回来的东西还是不是一回事"。
//
// 用法:
//   node upgrade-behavior.js save <out.json>
//   node upgrade-behavior.js diff <base.json>
//
// 全部经面板 :9000 发，走的就是客户端真实路径（陷阱 56：测客户端问题要用客户端的路径）。
const http = require('http');
const fs = require('fs');
const PORT = process.env.PANEL_PORT || 9000;

function post(path, obj, timeoutMs = 180000) {
  return new Promise((res) => {
    const body = JSON.stringify(obj);
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (r) => {
      let d = ''; r.on('data', (c) => d += c);
      r.on('end', () => { try { res({ code: r.statusCode, j: JSON.parse(d) }); } catch (e) { res({ code: r.statusCode, raw: d.slice(0, 300) }); } });
    });
    req.on('error', (e) => res({ code: 0, raw: e.message }));
    req.setTimeout(timeoutMs, () => { req.destroy(); res({ code: 0, raw: 'timeout' }); });
    req.end(body);
  });
}
function get(path) {
  return new Promise((res) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (r) => {
      let d = ''; r.on('data', (c) => d += c);
      r.on('end', () => { try { res({ code: r.statusCode, j: JSON.parse(d) }); } catch (e) { res({ code: r.statusCode, raw: d.slice(0, 200) }); } });
    }).on('error', (e) => res({ code: 0, raw: e.message }));
  });
}

const TOOLS = [{
  type: 'function',
  function: {
    name: 'get_weather',
    description: '查询某个城市的天气',
    parameters: { type: 'object', properties: { city: { type: 'string', description: '城市名' } }, required: ['city'] },
  },
}];

(async () => {
  const [, , mode, file] = process.argv;
  if (!mode || !file) { console.error('用法: upgrade-behavior.js save|diff <文件>'); process.exit(1); }
  const out = {};

  // 1. /v1/models 列表（面板聚合两个后端）
  const m = await get('/v1/models');
  out.models = m.j && m.j.data ? m.j.data.map((x) => x.id).sort() : ['<失败 ' + m.code + '>'];

  // 2. 普通对话：正文非空、正常结束
  const a = await post('/v1/chat/completions', {
    model: 'qwen3.8-27b-nothink',
    messages: [{ role: 'user', content: '用一句话说明什么是域控制器。' }], max_tokens: 80,
  });
  const ac = a.j && a.j.choices && a.j.choices[0];
  out.plain = { code: a.code, finish: ac && ac.finish_reason, hasContent: !!(ac && ac.message && ac.message.content) };

  // 3. -nothink 变体：不应该有思考内容（面板注入 enable_thinking:false）
  out.nothink = { reasoningEmpty: !(ac && ac.message && ac.message.reasoning_content) };

  // 4. 思考档：应当出现 reasoning_content（reasoning-format deepseek-legacy 的表现）
  const b = await post('/v1/chat/completions', {
    model: 'qwen3.8-27b',
    messages: [{ role: 'user', content: '一个域控制器同时跑三个互斥服务，为什么必须互斥？简短回答。' }], max_tokens: 400,
  });
  const bc = b.j && b.j.choices && b.j.choices[0];
  out.thinking = {
    code: b.code, finish: bc && bc.finish_reason,
    hasReasoning: !!(bc && bc.message && bc.message.reasoning_content),
    hasContent: !!(bc && bc.message && bc.message.content),
  };

  // 5. ★ 工具调用：这是历史上最容易在换版本/换模板后崩掉的一项（A-101）
  const c = await post('/v1/chat/completions', {
    model: 'qwen3.8-27b-nothink',
    messages: [{ role: 'user', content: '帮我查一下上海的天气。' }], tools: TOOLS, max_tokens: 300,
  });
  const cc = c.j && c.j.choices && c.j.choices[0];
  const tc = cc && cc.message && cc.message.tool_calls;
  out.tools = {
    code: c.code, finish: cc && cc.finish_reason,
    nCalls: Array.isArray(tc) ? tc.length : 0,
    fnName: Array.isArray(tc) && tc[0] ? tc[0].function && tc[0].function.name : null,
  };

  // 6. 向量端点（面板代理，usage 嗅探依赖响应体开头带 usage）
  const e = await post('/v1/embeddings', { model: 'qwen3-embedding-0.6b', input: '域控制器散热' });
  out.embed = {
    code: e.code,
    dim: e.j && e.j.data && e.j.data[0] ? e.j.data[0].embedding.length : 0,
    hasUsage: !!(e.j && e.j.usage && e.j.usage.prompt_tokens != null),
  };

  if (mode === 'save') {
    fs.writeFileSync(file, JSON.stringify(out, null, 1));
    console.log(JSON.stringify(out, null, 1));
    console.log('SAVED -> ' + file);
    process.exit(0);
  }

  const base = JSON.parse(fs.readFileSync(file, 'utf8'));
  let bad = 0;
  const walk = (p, a2, b2) => {
    if (JSON.stringify(a2) === JSON.stringify(b2)) { console.log('  ✓ ' + p); return; }
    if (a2 && b2 && typeof a2 === 'object' && !Array.isArray(a2)) {
      for (const k of new Set([...Object.keys(a2), ...Object.keys(b2 || {})])) walk(p + '.' + k, a2[k], (b2 || {})[k]);
      return;
    }
    bad++; console.log('  ★ ' + p + '：旧 ' + JSON.stringify(a2) + ' → 新 ' + JSON.stringify(b2));
  };
  for (const k of Object.keys(base)) walk(k, base[k], out[k]);
  console.log(bad === 0 ? 'VERDICT 行为一致' : '★ VERDICT ' + bad + ' 处行为变化，逐条判断是否可接受');
})();
