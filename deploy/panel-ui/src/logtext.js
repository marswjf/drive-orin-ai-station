/* 日志翻译：把 journalctl 原文转成能直接读懂的中文。
 *
 * 规则全部按板上实测的真实句式写（2026-08-12 采样 llm-server / llm-embedding /
 * iecu-panel / iecu-frpc 各数百行，按数字抹平后去重得到句式清单）。
 * 别凭印象写 llama.cpp 的日志格式——它和网上文章里的样子不一样，
 * 消息体里还嵌了一层自己的时间戳和级别。
 *
 * 原文一行不丢，界面上「显示原文」随时切回去。没命中规则的行原样显示，
 * 宁可显示原文，也不要猜错意思。
 */

// journald 外层： "May 16 19:00:32 tegra-ubuntu run-server.sh[26970]: 正文"
const OUTER = /^(\w{3}\s+\d+\s+(\d{2}:\d{2}:\d{2}))\s+\S+\s+([\w.@-]+)\[\d+\]:\s?(.*)$/;
// llama.cpp 自己的前缀： "555.03.812.604 I "
const INNER_LLAMA = /^\d+\.\d+\.\d+\.\d+\s+([IWED])\s+/;
// frp 的前缀： "2026-08-12 03:22:45.189 [I] [client/service.go:311] "
const INNER_FRP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+ \[([IWE])\] \[[^\]]+\]\s*/;

const n = (s) => Number(String(s).replace(/[\s,]/g, ''));
const K = (v) => (v >= 1e4 ? Math.round(v / 1e3) + 'K' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : String(Math.round(v)));
const sec = (msv) => (msv >= 1000 ? (msv / 1000).toFixed(1) + ' 秒' : Math.round(msv) + ' ms');

const RULES = [
  // ── 推理过程（llm-server / llm-embedding）──────────────────────
  [/^slot\s+launch_slot_:.*?task (\d+)\s*\|\s*processing task/,
    (m) => ({ t: `开始处理请求 #${m[1]}`, l: 'info' })],

  [/^slot\s+print_timing:.*?task (\d+)\s*\|\s*prompt processing, n_tokens =\s*(\d+), progress = ([\d.]+), t =\s*([\d.]+) s \/ ([\d.]+) tokens per second/,
    (m) => ({
      t: `请求 #${m[1]} 读取输入 ${(parseFloat(m[3]) * 100).toFixed(0)}%（已读 ${K(n(m[2]))} tokens，${Math.round(n(m[5]))} tokens/s）`,
      l: 'dim',
    })],

  /* 字段名在 llama.cpp b10498 起由 n_decoded 改成 n_gen，两种都要认：
     只写一种的话，换 build 之后这一类进度行就整片变成未汉化的原文（陷阱 24 同族）。 */
  [/^slot\s+print_timing:.*?task (\d+)\s*\|\s*(?:n_decoded|n_gen) =\s*(\d+), tg =\s*([\d.]+) t\/s, tg_\d+s =\s*([\d.]+) t\/s/,
    (m) => ({ t: `请求 #${m[1]} 生成中：已出 ${K(n(m[2]))} tokens，${n(m[3]).toFixed(1)} tokens/s（近 3 秒 ${n(m[4]).toFixed(1)}）`, l: 'dim' })],

  [/^slot\s+print_timing:.*?task (\d+)\s*\|\s*prompt eval time =\s*([\d.]+) ms \/\s*(\d+) tokens.*?([\d.]+) tokens per second/,
    (m) => ({ t: `请求 #${m[1]} Prefill 完成：${K(n(m[3]))} tokens 用时 ${sec(n(m[2]))}，${Math.round(n(m[4]))} tokens/s`, l: 'ok' })],

  [/^slot\s+print_timing:.*?task (\d+)\s*\|\s*eval time =\s*([\d.]+) ms \/\s*(\d+) tokens.*?([\d.]+) tokens per second/,
    (m) => ({ t: `请求 #${m[1]} 生成完成：${K(n(m[3]))} tokens 用时 ${sec(n(m[2]))}，${n(m[4]).toFixed(1)} tokens/s`, l: 'ok' })],

  [/^slot\s+print_timing:.*?task (\d+)\s*\|\s*total time =\s*([\d.]+) ms \/\s*(\d+) tokens/,
    (m) => ({ t: `请求 #${m[1]} 合计 ${sec(n(m[2]))}，共 ${K(n(m[3]))} tokens`, l: 'info' })],

  [/^slot\s+release:.*?task (\d+)\s*\|\s*stop processing: n_tokens = (\d+), truncated = (\d+)/,
    (m) => ({
      t: `请求 #${m[1]} 结束，上下文 ${K(n(m[2]))} tokens` + (m[3] !== '0' ? '　⚠ 内容超长已被截断' : ''),
      l: m[3] !== '0' ? 'warn' : 'dim',
    })],

  [/^slot\s+get_availabl:.*?selected slot by LCP similarity, f_sim_best = ([\d.]+)/,
    (m) => ({ t: `复用上一轮的缓存，前缀相似度 ${(parseFloat(m[1]) * 100).toFixed(0)}%`, l: 'dim' })],

  [/^slot\s+get_availabl:.*?selected slot by LRU/, () => ({ t: '分配空闲处理位', l: 'dim' })],

  [/^slot\s+print_timing:.*?graphs reused/, () => ({ t: null })],

  // Prompt 缓存池：这两条直接说明缓存池是不是给小了，很值得看见
  [/^srv\s+alloc:\s*-\s*making room for prompt cache entry, removing oldest entry \(size = ([\d.]+) MiB\)/,
    (m) => ({ t: `Prompt 缓存池已满，淘汰最旧的一条（${Math.round(n(m[1]))} MB）`, l: 'dim' })],

  [/^srv\s+alloc:\s*-\s*prompt state size ([\d.]+) MiB exceeds cache size limit ([\d.]+) MiB, skipping/,
    (m) => ({ t: `本次缓存 ${Math.round(n(m[1]))} MB 超过缓存池上限 ${Math.round(n(m[2]))} MB，未能缓存（下次同样的开头要重算，可考虑调大 Prompt 缓存池）`, l: 'warn' })],

  [/^srv\s+stop: cancel task, id_task = (\d+)/,
    (m) => ({ t: `请求 #${m[1]} 被取消（客户端提前断开）`, l: 'warn' })],

  [/^srv\s+update_slots: all slots are idle/, () => ({ t: '处理位全部空闲', l: 'dim' })],
  [/^srv\s+llama_server: -+$/, () => ({ t: null })],
  [/^srv\s+log_server_r: request:\s+(\w+) (\S+) (\S+) (\d{3})/,
    (m) => {
      const api = {
        '/v1/chat/completions': '对话', '/v1/embeddings': '向量化', '/v1/models': '模型列表',
        '/v1/completions': '补全', '/props': '服务信息', '/slots': '状态查询',
        '/metrics': '指标采集', '/health': '健康检查',
      }[m[2]] || m[2];
      const bad = Number(m[4]) >= 400;
      return { t: `${api}请求 来自 ${m[3]} → ${m[4]}`, l: bad ? 'bad' : 'dim' };
    }],

  // 启动
  [/^启动: (\S+)\s+(.*)$/, (m) => {
    const args = m[2];
    const g = (k) => { const r = new RegExp('--' + k + ' (\\S+)').exec(args); return r ? r[1] : null; };
    const model = (g('model') || '').split('/').pop();
    const ctx = g('ctx-size');
    return {
      t: `启动推理服务：模型 ${model || '?'}，上下文 ${ctx ? Math.round(n(ctx) / 1024) + 'K' : '?'}`
        + (/--flash-attn on/.test(args) ? '，Flash Attention 开' : '')
        + (g('cache-type-k') ? `，KV 缓存 ${g('cache-type-k')}` : ''),
      l: 'ok',
    };
  }],
  [/^后端: (\S+)\s+二进制: (\S+)/, (m) => ({ t: `运算设备：${m[1] === 'cuda' ? 'GPU' : 'CPU'}`, l: 'dim' })],
  [/^main: server is listening on .*?:(\d+)/, (m) => ({ t: `推理服务就绪，监听 ${m[1]} 端口`, l: 'ok' })],
  [/^main: model loaded/, () => ({ t: '模型加载完成', l: 'ok' })],
  [/^(load_tensors|llama_model_loader|print_info|llama_context|init:|common_init|build:|system_info)/, () => ({ t: null })],

  // ── 面板自身（本来就是中文，只做少量归一）────────────────────
  [/^\[proxy\] 客户端断开/, () => ({ t: '客户端提前断开，已通知推理服务停止并释放处理位', l: 'warn' })],
  [/^\[auth\] 登录成功 from (.+)$/, (m) => ({ t: `登录成功（来自 ${m[1]}）`, l: 'ok' })],
  [/^\[auth\] 登录失败 from (\S+)（第 (\d+) 次）/, (m) => ({ t: `登录失败（来自 ${m[1]}，第 ${m[2]} 次）`, l: 'bad' })],
  [/^\[memory-guard\].*available ([\d.]+) GiB/, (m) => ({ t: `内存保护触发：剩余 ${m[1]} GB 低于阈值，重启推理服务`, l: 'bad' })],
  [/^\[memory-guard\] 已启用/, () => ({ t: '内存保护已启用', l: 'dim' })],
  [/^\[iecu-panel\] listening on \S+/, () => ({ t: '运维面板已启动', l: 'ok' })],
  [/^\[history\]/, () => ({ t: null })],
  [/^\[chat-zh\]/, () => ({ t: null })],
  [/^\[site-egress\] (.+)$/, (m) => ({ t: m[1], l: 'dim' })],

  // ── frpc 隧道 ───────────────────────────────────────────────
  [/^start frpc service/, () => ({ t: '隧道客户端启动', l: 'dim' })],
  [/^try to connect to server/, () => ({ t: '正在连接隧道服务端…', l: 'dim' })],
  [/login to server success, get run id \[(\w+)\]/, () => ({ t: '隧道已连上服务端', l: 'ok' })],
  [/login to server failed/, () => ({ t: '连接隧道服务端失败，稍后自动重试', l: 'warn' })],
  [/proxy added: \[(.+)\]/, (m) => ({ t: `注册隧道通道：${m[1]}`, l: 'dim' })],
  [/\[([\w-]+)\] start proxy success/, (m) => ({ t: `隧道通道 ${m[1]} 建立成功`, l: 'ok' })],
  [/\[([\w-]+)\] start error/, (m) => ({ t: `隧道通道 ${m[1]} 建立失败`, l: 'bad' })],
  [/get a user connection/, () => ({ t: null })],

  // ── systemd ─────────────────────────────────────────────────
  [/^Started (.+?)\.?$/, (m) => ({ t: `已启动：${m[1]}`, l: 'ok' })],
  [/^Stopping (.+?)\.\.\.$/, (m) => ({ t: `正在停止：${m[1]}`, l: 'dim' })],
  [/^Stopped (.+?)\.?$/, (m) => ({ t: `已停止：${m[1]}`, l: 'dim' })],
  [/^(.+?): Succeeded\.$/, (m) => ({ t: `${m[1]} 正常退出`, l: 'dim' })],
  [/^(.+?): Failed with result '(.+)'\.$/, (m) => ({ t: `${m[1]} 异常退出（${m[2]}）`, l: 'bad' })],
  [/^(.+?): Main process exited.*?status=(\d+)/, (m) => ({ t: `${m[1]} 进程退出，代码 ${m[2]}`, l: 'bad' })],
  [/^(.+?): Scheduled restart job/, (m) => ({ t: `${m[1]} 将自动重启`, l: 'warn' })],
  [/^-- Logs begin at/, () => ({ t: null })],
];

export function translateLine(raw) {
  const om = OUTER.exec(raw);
  const time = om ? om[2] : '';
  const src = om ? om[3] : '';
  let body = om ? om[4] : raw;

  // 剥掉服务自己打的那层时间戳/级别
  let lvlHint = '';
  const li = INNER_LLAMA.exec(body);
  if (li) { lvlHint = li[1]; body = body.slice(li[0].length); }
  else {
    const fi = INNER_FRP.exec(body);
    if (fi) { lvlHint = fi[1]; body = body.slice(fi[0].length); }
  }
  body = body.trim();
  if (!body) return null;

  for (const [re, fn] of RULES) {
    const m = re.exec(body);
    if (m) {
      const r = fn(m);
      if (r.t === null) return null;              // 明确判定为噪音
      let level = r.l || 'info';
      if (lvlHint === 'W' && level === 'dim') level = 'warn';
      if (lvlHint === 'E') level = 'bad';
      return { time, src, text: r.t, level, raw };
    }
  }
  return { time, src, text: body, level: lvlHint === 'E' ? 'bad' : lvlHint === 'W' ? 'warn' : 'plain', raw };
}

export function translateLog(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    const r = translateLine(line);
    if (r) out.push(r);
  }
  return out;
}
