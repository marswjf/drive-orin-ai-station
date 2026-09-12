#!/usr/bin/env node
/* IECU 3.1 运维面板 —— 零外部依赖，只用 Node 内置模块。
 * 部署位置: /var/lib/llm/panel/server.js   由 iecu-panel.service 拉起
 * 默认端口 9000。局域网直连免登录；经反向代理来自公网的请求必须登录，
 * 且 /v1 与 /embed 这两条数据面路径在公网侧一律拒绝（详见「鉴权与访问平面」）。
 *
 * 设计约束（都来自板子实测，见 skill 的 llm-deploy.md）：
 *  - 板上没有 python3，Node 20 是唯一可用的脚本运行时
 *  - 板上装不了 npm 包，鉴权只能用 node 内置的 crypto（scrypt）
 *  - 只允许操作白名单里的 systemd unit，杜绝任意命令执行
 *  - 绝不触碰 /app/shutdown_service.sh（会触发 Hypervisor 整机关机）
 *  - 板子 RTC 不准（无时间同步），面板显示时会标出偏差
 */
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { execFile, spawn } = require('child_process');

const PORT = parseInt(process.env.PANEL_PORT || '9000', 10);
const ROOT = __dirname;
const CONFIG_PATH = '/var/lib/llm/config.json';
const CONFIG_BAK = '/var/lib/llm/config.json.bak';
/* 双模型布局（2026-08-12）：/opt/m 放默认态 MTP（读 541MB/s，启动 78s），
 * /opt/m0 放多模态模型（读 201MB/s，切换加载 213s）。两个目录都是合法模型位置。 */
/* ★ 必须包含 /opt/update/llm（2026-08-19 补）：Qwen3.8-27B 就放在那里，
 * 而这个列表原来只有前两个目录，后果是——「模型与参数」页的模型下拉里
 * **没有当前正在跑的模型**，于是 select 落到列表第一项，界面显示
 * 「Qwen3.6-35B-A3B-MTP…」而右侧实际运行值写着 qwen3.8-27b，自相矛盾；
 * 更糟的是这时点「保存」会把 config 的模型悄悄改成下拉里显示的那个。
 * 另外 saveConfig 会拒收不在本列表目录下的模型路径，等于 27B 根本没法从这一页设置。 */
const MODEL_DIRS = ['/opt/m/llm', '/opt/m0/llm', '/opt/update/llm'];
/* 草稿模型（投机解码用）与视觉投影模块不是能独立对话的模型，不能出现在"对话模型"的选择里。
 * 选中它们服务起不来。判据用文件名——这些模型的命名都带着方案名。 */
const isDrafterFile = (n) => /(dflash|dspark|eagle3?|[-_]draft|[-_]mtp[-_]?head)/i.test(n);
const isMmprojFile = (n) => /mmproj/i.test(n);
/* 向量模型同样不能当对话模型选——它由 llm-embedding 单独加载，走 embeddingModel 配置项 */
const isEmbedFile = (n) => /embedding/i.test(n);
const inModelDirs = (p) => MODEL_DIRS.some((d) => p.startsWith(d + path.sep));

/* 只有这几个 unit 可被面板操作。application_start 是厂商智驾栈，
 * 停它用 systemctl stop（走 cgroup 杀进程），不会调用 shutdown_service.sh。 */
const UNIT_WHITELIST = {
  'llm-server': { label: 'LLM 主模型', desc: 'llama-server，OpenAI 兼容 API + 内置聊天界面' },
  'llm-embedding': { label: 'Embedding', desc: 'Qwen3-Embedding-0.6B，向量检索用' },
  'comfyui': { label: '生图服务', desc: 'ComfyUI，图像与视频生成；与对话模型争内存，二者不可同时运行' },
  'application_start': { label: '智驾栈', desc: '厂商自动驾驶软件栈，与 LLM 争内存，二者不可同时运行' },
};

/* 生图服务的端口。ComfyUI 自己没有鉴权，所以它只监听给面板反代用，
 * 公网访问一律先过面板这道登录。 */
const COMFY_PORT = 8188;

// ---------------------------------------------------------------- 工具

const run = (cmd, args, timeout = 15000) => new Promise((res) => {
  execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, so, se) => {
    res({ code: err ? (err.code === undefined ? -1 : err.code) : 0, stdout: so || '', stderr: se || '' });
  });
});
const readFileSafe = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } };
const readIntSafe = (p) => { const v = parseInt(readFileSafe(p).trim(), 10); return Number.isFinite(v) ? v : null; };

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (e) {
    return { model: '', mmproj: '', ctx: 32768, ngl: 99, port: 8080, threads: 10, extraArgs: [] };
  }
}
/* 存配置前先留一份上一版。改坏参数会让 llm-server 起不来，而公网场景下
 * 没法 SSH 进来救——/api/config/rollback 是唯一的自救出口。 */
function saveConfig(c) {
  try { if (fs.existsSync(CONFIG_PATH)) fs.copyFileSync(CONFIG_PATH, CONFIG_BAK); } catch (e) {}
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2), 'utf8');
}

/* ── 累计用量的跨重启保留 ──────────────────────────────────
 * llama.cpp 的 /metrics 计数器在服务重启后归零，面板自己的编码统计在面板重启后归零，
 * 于是界面上的"累计"只能反映最近一次启动以来的量。这里把两者都落到一个文件：
 * 读到的计数器比上次小就认定服务重启过，把上一段的量并入基数。
 * 只存累计标量；趋势图的时点序列仍留在内存环形缓冲里，板子重启即归零。 */
const STATS_PATH = '/var/lib/llm/panel-stats.json';
const LIFE = {
  llm: {
    basePromptTokens: 0, baseGenTokens: 0, basePromptSec: 0, baseGenSec: 0, baseDecodeCalls: 0,
    lastPromptTokens: 0, lastGenTokens: 0, lastPromptSec: 0, lastGenSec: 0, lastDecodeCalls: 0,
    maxSeenTokens: 0, restarts: 0,
    // 中断次数必须自己累计：/metrics 没有这个计数器，而 REQLOG 只有 120 条内存记录，
    // 面板一重启就归零。放进 LIFE 才能跟"累计用量"里其它数字同一口径。
    aborted: 0,
    /* 单次对话平均要花多久读入，得用"累计 Prefill 秒数 ÷ 对话次数"。
     * 分子来自 llama-server 的计数器、分母只有面板数得清（/metrics 没有请求总数），
     * 两个来源的起点不同——服务已经跑了几百次之后才加的这个统计，历史耗时会全摊到
     * 新请求头上。所以开始计数的那一刻把当时的累计秒数记成基准，此后只算增量。 */
    requests: 0,
    avgBasePromptSec: null,
  },
  embed: { tokens: 0, ms: 0, count: 0, failed: 0, maxTokens: 0, since: 0 },
  /* 峰值也要跨重启保留。只从 HIST 环形缓冲里算的话，面板一重启峰值就归零——
   * "最高生成速度""最长会话"这类指标只剩当前这一段，失去参考价值。
   * HIST 负责发现新峰值，这里负责记住。
   * ★ 这里只放**机器级**峰值（温度、CPU、内存水位），它们与跑哪个模型无关。 */
  peak: { tj: 0, cpu: 0, availKBMin: null },
  /* ★ 模型级峰值按模型文件分桶（2026-08-19 加）。原来生成速度/Prefill/上下文
   * 也放在全局 peak 里，换模型之后旧峰值一直挂着：板上从 Qwen3.6-35B-A3B 换成
   * Qwen3.8-27B 后，界面上"生成峰值 44.0 tokens/s"依然是 3.6 的数，
   * 而 27B 实测只有 10~12，等于把另一个模型的成绩安在当前模型头上。
   * 键取模型文件名（不是 alias）：mtp 与 mm 两档 alias 相同但模型文件不同、速度也不同。
   * 桶里同时放**该模型的用量**（promptTokens/genTokens/promptSec/genSec）。
   * 为什么用量也要分模型：概览区「生成速度」在空闲时回退显示终身平均，
   * 而终身平均是跨模型的——板上跑 27B（实测 10~12 tok/s）时那里显示 36.5，
   * 那是 Qwen3.6 时代攒下的数。比"没有数值"更糟，因为它看起来是对的。 */
  byModel: {},
  since: 0,
};
/* 模型文件名 → 分桶键。取不到就归到 unknown，不要静默并进别的模型。 */
const modelKeyOf = (p) => (p ? String(p).split('/').pop() : '') || 'unknown';
(function loadStats() {
  try {
    const j = JSON.parse(fs.readFileSync(STATS_PATH, 'utf8'));
    if (j && j.llm) Object.assign(LIFE.llm, j.llm);
    if (j && j.embed) Object.assign(LIFE.embed, j.embed);
    if (j && j.peak) Object.assign(LIFE.peak, j.peak);
    if (j && j.byModel) Object.assign(LIFE.byModel, j.byModel);
    if (j && j.since) LIFE.since = j.since;
    /* 旧文件里 genTps/promptTps/ctx 混在全局 peak 里，且无法追溯当时跑的是哪个模型。
     * 不能把它们并进任何一个模型的桶（那就是伪造数据），直接丢弃：
     * 各模型的峰值从升级后重新累积。 */
    delete LIFE.peak.genTps; delete LIFE.peak.promptTps; delete LIFE.peak.ctx;
  } catch (e) { /* 首次运行没有这个文件 */ }
  if (!LIFE.since) LIFE.since = Date.now();
  if (!LIFE.embed.since) LIFE.embed.since = LIFE.since;
})();
let statsDirty = false;
function saveStats() {
  if (!statsDirty) return;
  try {
    const tmp = STATS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ llm: LIFE.llm, embed: LIFE.embed, peak: LIFE.peak, byModel: LIFE.byModel, since: LIFE.since, savedAt: Date.now() }), 'utf8');
    fs.renameSync(tmp, STATS_PATH);   // 原子替换：断电时不会留下写了一半的文件
    statsDirty = false;
  } catch (e) { /* 写不进去不影响服务运行 */ }
}
function llmTotals() {
  const L = LIFE.llm;
  return {
    promptTokens: L.basePromptTokens + L.lastPromptTokens,
    genTokens: L.baseGenTokens + L.lastGenTokens,
    promptSeconds: L.basePromptSec + L.lastPromptSec,
    genSeconds: L.baseGenSec + L.lastGenSec,
    decodeCalls: L.baseDecodeCalls + L.lastDecodeCalls,
    maxSeenTokens: L.maxSeenTokens,
    serviceRestarts: L.restarts,
    aborted: L.aborted,
    requests: L.requests,
    avgPromptSec: L.requests > 0 && Number.isFinite(L.avgBasePromptSec)
      ? Math.max(0, (L.basePromptSec + L.lastPromptSec) - L.avgBasePromptSec) / L.requests
      : null,
  };
}
/* 把 /metrics 当前读数并进终身累计。幂等：同一份读数调用多次不会重复计入。 */
function accumulateLLM(m, modelKey) {
  const L = LIFE.llm;
  // ★ 没有有效读数（服务未响应、/metrics 超时）时直接返回，不更新 last。
  //   把"取不到"当成"计数器归零"会让下一次成功读数重复计入基数。
  if (!m || m['llamacpp:prompt_tokens_total'] === undefined) return llmTotals();
  const cur = {
    pt: m['llamacpp:prompt_tokens_total'] || 0,
    gt: m['llamacpp:tokens_predicted_total'] || 0,
    ps: m['llamacpp:prompt_seconds_total'] || 0,
    gs: m['llamacpp:tokens_predicted_seconds_total'] || 0,
    dc: m['llamacpp:n_decode_total'] || 0,
  };
  // 计数器回退 = llm-server 重启过，把上一段并入基数
  const restarted = cur.pt < L.lastPromptTokens || cur.gt < L.lastGenTokens || cur.dc < L.lastDecodeCalls;
  if (restarted) {
    L.basePromptTokens += L.lastPromptTokens;
    L.baseGenTokens += L.lastGenTokens;
    L.basePromptSec += L.lastPromptSec;
    L.baseGenSec += L.lastGenSec;
    L.baseDecodeCalls += L.lastDecodeCalls;
    L.restarts += 1;
  }
  /* 同一份增量并进「当前模型」的桶。重启后计数器从 0 起，增量就是 cur 本身。
   * 只加正增量：负数只可能来自没识别到的重启，加进去会污染该模型的均值。 */
  if (modelKey) {
    const M = (LIFE.byModel[modelKey] ||= { genTps: 0, promptTps: 0, ctx: 0, since: Date.now() });
    const d = (c, last) => (restarted ? c : c - last);
    const dPt = d(cur.pt, L.lastPromptTokens), dGt = d(cur.gt, L.lastGenTokens);
    const dPs = d(cur.ps, L.lastPromptSec), dGs = d(cur.gs, L.lastGenSec);
    if (dPt > 0) M.promptTokens = (M.promptTokens || 0) + dPt;
    if (dGt > 0) M.genTokens = (M.genTokens || 0) + dGt;
    if (dPs > 0) M.promptSec = (M.promptSec || 0) + dPs;
    if (dGs > 0) M.genSec = (M.genSec || 0) + dGs;
  }
  L.lastPromptTokens = cur.pt; L.lastGenTokens = cur.gt;
  L.lastPromptSec = cur.ps; L.lastGenSec = cur.gs; L.lastDecodeCalls = cur.dc;
  // 第一次拿到有效读数时定下平均耗时的起算点，见 LIFE 里的说明
  if (L.avgBasePromptSec === null || L.avgBasePromptSec === undefined) {
    L.avgBasePromptSec = L.basePromptSec + cur.ps;
  }
  const mx = m['llamacpp:n_tokens_max'] || 0;
  if (mx > L.maxSeenTokens) L.maxSeenTokens = mx;
  statsDirty = true;
  return llmTotals();
}

// ---------------------------------------------------------------- 鉴权与访问平面
/* 平面划分（这是公网暴露后最容易搞错的地方）：
 *
 *   数据面  /v1/*  /embed/*   仅局域网可达，不要求登录
 *                             —— NewAPI、WeKnora 这些调用方在局域网里直连，
 *                                加了登录它们立刻全挂。公网侧一律 403。
 *   控制面  /api/*            改配置、启停服务、切模式，公网必须登录
 *   调试面  /llm/*  静态页     聊天界面与面板本身，公网必须登录
 *
 * "是否来自公网"的判据不是 socket 地址——经反向代理进来时源地址是代理机的
 * 内网 IP，看 socket 会误判成局域网，这正是把模型一起暴露出去的那个陷阱。
 * 判据用 X-Forwarded-For 是否存在：反代一定会带，局域网直连一定不带。
 */
const AUTH_PATH = '/var/lib/llm/panel-auth.json';
const SESSIONS = new Map();          // sid -> { exp, ip }
const LOGIN_FAILS = new Map();       // ip  -> { n, until }
const SESSION_TTL_MS = 12 * 3600 * 1000;
const MAX_FAILS = 6;
const LOCK_MS = 15 * 60 * 1000;

function loadAuth() { try { return JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8')); } catch (e) { return null; } }

function verifyPassword(pw) {
  const a = loadAuth();
  if (!a || typeof pw !== 'string' || !pw) return false;
  const want = Buffer.from(a.hash, 'hex');
  const got = crypto.scryptSync(pw, Buffer.from(a.salt, 'hex'), want.length, { N: a.N || 16384, r: a.r || 8, p: a.p || 1 });
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

function isFromInternet(req) {
  if (req.headers['x-forwarded-for'] || req.headers['x-real-ip']) return true;
  const raw = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (raw === '127.0.0.1' || raw === '::1') return false;
  return !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(raw);
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function currentSession(req) {
  const sid = parseCookies(req).iecu_sid;
  if (!sid) return null;
  const s = SESSIONS.get(sid);
  if (!s) return null;
  if (Date.now() > s.exp) { SESSIONS.delete(sid); return null; }
  return { sid, ...s };
}

function issueSession(req, res) {
  for (const [k, v] of SESSIONS) if (Date.now() > v.exp) SESSIONS.delete(k);
  const sid = crypto.randomBytes(32).toString('base64url');
  SESSIONS.set(sid, { exp: Date.now() + SESSION_TTL_MS, ip: req.socket.remoteAddress });
  // Secure 只在确实走了 HTTPS 时加——局域网是明文 HTTP，加了 Cookie 直接不生效
  const https = String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
  res.setHeader('Set-Cookie', 'iecu_sid=' + sid + '; HttpOnly; SameSite=Strict; Path=/; Max-Age='
    + Math.floor(SESSION_TTL_MS / 1000) + (https ? '; Secure' : ''));
  return sid;
}

function clientKey(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim();
}

// ---------------------------------------------------------------- tegrastats 常驻解析

const tegra = { ts: 0, raw: '', ram: null, cpu: [], emc: null, gr3d: null, temps: {}, dla: [], pva: null };
function startTegrastats() {
  let p;
  const boot = () => {
    try { p = spawn('/usr/bin/tegrastats', ['--interval', '2000'], { stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch (e) { setTimeout(boot, 10000); return; }
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { parseTegra(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    p.on('close', () => setTimeout(boot, 5000));
    p.on('error', () => setTimeout(boot, 10000));
  };
  boot();
  process.on('exit', () => { try { p && p.kill(); } catch (e) {} });
}
function parseTegra(line) {
  if (!line.includes('RAM')) return;
  tegra.raw = line; tegra.ts = Date.now();
  let m;
  if ((m = line.match(/RAM (\d+)\/(\d+)MB/))) tegra.ram = { usedMB: +m[1], totalMB: +m[2] };
  if ((m = line.match(/CPU \[([^\]]+)\]/))) {
    tegra.cpu = m[1].split(',').map((c) => {
      const mm = c.match(/(\d+)%@(\d+)/);
      return mm ? { pct: +mm[1], mhz: +mm[2] } : { pct: null, mhz: null, off: true };
    });
  }
  /* 内存带宽：这块板子的 tegrastats 始终输出 "EMC_FREQ @0"，既没有百分比也没有频率
   * （GPU 跑到 99% 的满载采样里同样如此，44 次采样无一例外）。解析保留着，
   * 万一将来固件补上就能直接用；界面上不显示它，避免出现一个永远是 — 的格子。 */
  if ((m = line.match(/EMC_FREQ (\d+)%?@?(\d+)?/))) tegra.emc = { pct: +m[1], mhz: m[2] ? +m[2] : null };
  else if ((m = line.match(/EMC_FREQ @(\d+)/))) tegra.emc = { pct: null, mhz: +m[1] };
  if ((m = line.match(/GR3D_FREQ (\d+)%?@?(\d+)?/))) tegra.gr3d = { pct: +m[1], mhz: m[2] ? +m[2] : null };
  const t = {};
  const re = /([A-Za-z0-9_\-]+)@([\d.]+)C/g;
  let x; while ((x = re.exec(line))) t[x[1]] = parseFloat(x[2]);
  if (Object.keys(t).length) tegra.temps = t;
  const dla = []; const dre = /NVDLA(\d)\s+(\d+)%@(\d+)/g;
  while ((x = dre.exec(line))) dla.push({ id: +x[1], pct: +x[2], mhz: +x[3] });
  if (dla.length) tegra.dla = dla;
  if ((m = line.match(/PVA0_FREQ @(\d+)/))) tegra.pva = { mhz: +m[1] };
}

// ---------------------------------------------------------------- 状态采集

function memInfo() {
  const mi = readFileSafe('/proc/meminfo');
  const g = (k) => { const m = mi.match(new RegExp('^' + k + ':\\s+(\\d+) kB', 'm')); return m ? +m[1] : 0; };
  const total = g('MemTotal'), free = g('MemFree'), avail = g('MemAvailable');
  return {
    totalKB: total, freeKB: free, availKB: avail,
    buffersKB: g('Buffers'), cachedKB: g('Cached'),
    usedKB: total - avail,
    swapTotalKB: g('SwapTotal'), swapFreeKB: g('SwapFree'),
  };
}
/* Orin 是统一内存架构：没有独立显存，GPU 和 CPU 共用同一块物理内存。
 * nvmap 的 "Max allocatable IOVMM memory" 表示 GPU 此刻还能一次分配多少。
 * 注意：这个值是【动态的】，随系统空闲内存浮动——实测同一台板子上，
 * 系统 used=4.1 GiB 时报 23.77 GiB，used=1.3 GiB 时报 27.44 GiB。
 * 所以它不是固定硬顶，而是"当前可分配量"。面板仍要单独显示它，
 * 因为 llama.cpp 走 CUDA 时权重经 cudaMalloc 受它约束，
 * 与 MemAvailable 是两条不同的线，混为一谈会误判模型装不装得下。 */
function gpuMem() {
  const raw = readFileSafe('/sys/kernel/debug/nvmap/iovmm/free_size');
  const m = raw.match(/(\d+)\s*bytes/);
  const carve = {};
  for (const name of ['generic-0', 'fsi']) {
    const s = readFileSafe(`/sys/kernel/debug/nvmap/${name}/size`).trim();
    const f = readFileSafe(`/sys/kernel/debug/nvmap/${name}/free_size`).trim();
    if (s) carve[name] = { sizeB: parseInt(s, 16) || 0, freeB: parseInt(f, 16) || 0 };
  }
  let clients = 0;
  const cl = readFileSafe('/sys/kernel/debug/nvmap/iovmm/clients');
  const tm = cl.match(/^total\s+(\d+)K/m);
  if (tm) clients = parseInt(tm[1], 10) * 1024;
  return {
    iovmmMaxAllocB: m ? parseInt(m[1], 10) : null,   // GPU 单次可分配上限（硬顶）
    iovmmInUseB: clients,                            // 当前 nvmap 客户端占用
    carveouts: carve,
    unified: true,
    note: '统一内存架构，无独立显存；此值是 GPU 侧 nvmap IOVMM 的可分配上限',
  };
}
function loadAvg() {
  const p = readFileSafe('/proc/loadavg').trim().split(/\s+/);
  return { m1: parseFloat(p[0]) || 0, m5: parseFloat(p[1]) || 0, m15: parseFloat(p[2]) || 0, procs: p[3] || '' };
}
function thermals() {
  /* sysfs 里 zone type 带 -therm 后缀（CPU-therm / GPU-therm / tj-therm），
   * 而 tegrastats 输出的是不带后缀的 CPU@ / GPU@ / tj@。统一去掉后缀，
   * 前端和两个数据源就对得上了。 */
  const out = {};
  let i = 0;
  while (fs.existsSync(`/sys/class/thermal/thermal_zone${i}`)) {
    const type = readFileSafe(`/sys/class/thermal/thermal_zone${i}/type`).trim();
    const temp = readIntSafe(`/sys/class/thermal/thermal_zone${i}/temp`);
    if (type && temp !== null) out[type.replace(/-therm$/, '')] = +(temp / 1000).toFixed(1);
    i++;
    if (i > 40) break;
  }
  return out;
}
async function disks() {
  const r = await run('df', ['-B1', '--output=source,target,size,used,avail,pcent']);
  const keep = ['/', '/opt/m', '/opt/m0', '/opt/other', '/opt/update', '/var', '/app', '/persistent'];
  return r.stdout.split('\n').slice(1).map((l) => l.trim().split(/\s+/))
    .filter((c) => c.length >= 6 && keep.includes(c[1]))
    .map((c) => ({ src: c[0], mount: c[1], sizeB: +c[2], usedB: +c[3], availB: +c[4], pct: c[5] }));
}
async function unitState(u) {
  const [a, e, s] = await Promise.all([
    run('systemctl', ['is-active', u + '.service']),
    run('systemctl', ['is-enabled', u + '.service']),
    run('systemctl', ['show', u + '.service', '-p', 'ActiveEnterTimestamp', '-p', 'MainPID', '-p', 'MemoryCurrent']),
  ]);
  const kv = {};
  s.stdout.split('\n').forEach((l) => { const i = l.indexOf('='); if (i > 0) kv[l.slice(0, i)] = l.slice(i + 1); });
  return {
    active: a.stdout.trim(), enabled: e.stdout.trim(),
    since: kv.ActiveEnterTimestamp || '', mainPid: +(kv.MainPID || 0),
    memoryB: kv.MemoryCurrent && kv.MemoryCurrent !== '[not set]' ? +kv.MemoryCurrent : null,
  };
}
function models() {
  const out = [];
  for (const dir of MODEL_DIRS) {
    try {
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.gguf'))) {
        const st = fs.statSync(path.join(dir, f));
        /* kind 让前端不必再各写一套正则去猜（原来只在前端按 /mmproj/i 过滤，
           草稿模型是后来才有的，会漏进"对话模型"的下拉里）。 */
        const kind = isMmprojFile(f) ? 'mmproj' : isDrafterFile(f) ? 'draft'
          : isEmbedFile(f) ? 'embed' : 'chat';
        out.push({ name: f, path: path.join(dir, f), sizeB: st.size, kind });
      }
    } catch (e) { /* 目录不存在就跳过 */ }
  }
  return out.sort((a, b) => b.sizeB - a.sizeB);
}
function netInfo() {
  const out = [];
  try {
    for (const ifn of fs.readdirSync('/sys/class/net')) {
      if (ifn === 'lo') continue;
      const oper = readFileSafe(`/sys/class/net/${ifn}/operstate`).trim();
      const rx = readIntSafe(`/sys/class/net/${ifn}/statistics/rx_bytes`);
      const tx = readIntSafe(`/sys/class/net/${ifn}/statistics/tx_bytes`);
      const mtu = readIntSafe(`/sys/class/net/${ifn}/mtu`);
      out.push({ name: ifn, oper, rxB: rx, txB: tx, mtu });
    }
  } catch (e) {}
  return out;
}
async function ipAddrs() {
  const r = await run('ip', ['-br', '-4', 'addr']);
  return r.stdout.split('\n').filter(Boolean).map((l) => {
    const p = l.trim().split(/\s+/);
    return { iface: p[0], state: p[1], addrs: p.slice(2) };
  }).filter((x) => x.addrs.length);
}

/* 每个服务真实占了多少内存。
 * systemd 的 MemoryCurrent 在这里是假数据——模型权重通过 nvmap 映射到 GPU 侧，
 * 根本不计入进程的 cgroup。实测：推理服务 cgroup 只报 2.5 GB，而 nvmap 里是 19.7 GB。
 * 所以真实占用 = nvmap 分配（权重 + KV 缓存 + 计算缓冲）+ 进程匿名页。 */
function nvmapByPid() {
  const out = {};
  const txt = readFileSafe('/sys/kernel/debug/nvmap/iovmm/clients');
  for (const line of txt.split('\n')) {
    // 形如： user   llama-server   26970   20634276K
    const m = line.match(/^\s*\S+\s+(\S+)\s+(\d+)\s+(\d+)K\s*$/);
    if (m) out[m[2]] = { comm: m[1], bytes: parseInt(m[3], 10) * 1024 };
  }
  return out;
}
function procMem(pid) {
  const s = readFileSafe('/proc/' + pid + '/status');
  const g = (k) => { const m = s.match(new RegExp('^' + k + ':\\s+(\\d+) kB', 'm')); return m ? parseInt(m[1], 10) * 1024 : 0; };
  return { rssB: g('VmRSS'), anonB: g('RssAnon') };
}

/* systemd 说 active，不等于这个服务已经能接请求。
 * ComfyUI 尤其明显：systemctl restart 立刻返回 active，而它要几十秒才开始监听 8188
 * （--highvram 下还要先把权重全部载入）。此前面板拿 active 当"可用"，
 * 于是「打开生图界面」链接提前出现，用户点进去必然撞 502——
 * 而错误页还写着"请切换到生图模式"，用户明明已经切了，陷入死循环。
 * → 判断"能不能用"一律探端口，不看 systemd。 */
function probePort(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs);
    s.on('connect', () => done(true));
    s.on('timeout', () => done(false));
    s.on('error', () => done(false));
  });
}

/* 服务 key -> 它对外监听的端口。用于把 active 细化成 active/ready 两个状态。 */
const UNIT_PORT = { 'comfyui': COMFY_PORT, 'llm-server': 8080, 'llm-embedding': 8081 };

/* 生图统计：顶部那几张卡在生图模式下不能还摆着对话模型的指标（生成速度、上下文、
 * 累计 token），那些数在生图模式下恒为 0，看着像坏了。这里把 ComfyUI 自己的
 * /queue 与 /history 拉过来，换算成"实际在调用什么"。
 *
 * ⚠ history 在 ComfyUI 重启后清空，所以这里的"累计"只是**本次服务运行以来**的，
 *   界面必须写明口径，不能让人误以为是历史总量。
 * ⚠ 只在 ready 时拉：服务没起来时请求会一直等到超时，白白拖慢整个 /api/status。*/
/* 当前 ComfyUI 跑在哪一档（生图 / 生视频）。
 * 判据是**实际生效的 ExecStart**（systemctl cat 会把 drop-in 合并进来，取最后一行），
 * 不是去读 drop-in 文件——drop-in 可能存在但被手工删过、或 daemon-reload 还没执行。
 * 之所以要显示它：两档跑的是同一个服务、同一个端口、同一个 is-active，
 * 用错档不报错只是慢 14~38%（或长视频跑到 8 分钟才被杀），界面上看不出来就永远不会发现。 */
async function comfyProfile() {
  const r = await run('systemctl', ['cat', 'comfyui'], 8000).catch(() => null);
  if (!r || r.code !== 0) return null;
  const lines = String(r.stdout || '').split('\n').filter(l => l.startsWith('ExecStart='));
  const last = lines.length ? lines[lines.length - 1] : '';
  if (!last) return null;
  if (last.includes('--highvram')) return 'image';
  if (last.includes('--disable-pinned-memory')) return 'video';
  return 'unknown';
}

async function comfyStats(ready) {
  if (!ready) return null;
  const [q, h] = await Promise.all([
    httpGetJSON(COMFY_PORT, '/queue', 3000).catch(() => null),
    httpGetJSON(COMFY_PORT, '/history?max_items=60', 5000).catch(() => null),
  ]);
  const out = {
    running: q && Array.isArray(q.queue_running) ? q.queue_running.length : null,
    pending: q && Array.isArray(q.queue_pending) ? q.queue_pending.length : null,
    jobs: 0, images: 0, totalSec: 0, lastSec: null, lastAt: null,
    lastModel: null, lastNodes: null, failed: 0,
  };
  /* 当前正在跑的那一单，把模型名捞出来——这就是"实际的调用" */
  if (q && q.queue_running && q.queue_running.length) {
    const pr = q.queue_running[0];
    const dict = pr && pr[2];
    if (dict && typeof dict === 'object') {
      out.runningModel = pickModelName(dict);
      out.runningNodes = Object.keys(dict).length;
    }
  }
  if (h && typeof h === 'object') {
    const recs = Object.values(h);
    for (const r of recs) {
      if (!r || !r.status) continue;
      out.jobs++;
      if (r.status.status_str === 'error') { out.failed++; continue; }
      let t0 = null, t1 = null;
      for (const m of (r.status.messages || [])) {
        if (!Array.isArray(m)) continue;
        if (m[0] === 'execution_start' && m[1] && m[1].timestamp) t0 = m[1].timestamp;
        if ((m[0] === 'execution_success' || m[0] === 'execution_error') && m[1] && m[1].timestamp) t1 = m[1].timestamp;
      }
      let n = 0;
      for (const o of Object.values(r.outputs || {})) n += (o.images || []).length;
      out.images += n;
      if (t0 && t1 && t1 > t0) {
        const sec = (t1 - t0) / 1000;
        out.totalSec += sec;
        // history 的顺序不保证，取时间戳最大的那单作为"最近一次"
        if (out.lastAt === null || t1 > out.lastAt) {
          out.lastAt = t1; out.lastSec = sec;
          const dict = Array.isArray(r.prompt) ? r.prompt[2] : null;
          if (dict && typeof dict === 'object') {
            out.lastModel = pickModelName(dict);
            out.lastNodes = Object.keys(dict).length;
          }
        }
      }
    }
  }
  out.avgSec = out.jobs > out.failed && out.totalSec > 0 ? out.totalSec / (out.jobs - out.failed) : null;
  out.lastAtISO = out.lastAt ? new Date(out.lastAt).toISOString() : null;
  return out;
}

/* 从 API 格式的工作流里挑出"主模型"的名字。按优先级找，找到即返回——
 * 界面上只需要一个能让人认出"这次跑的是什么"的标识，不必列全。 */
function pickModelName(dict) {
  const PREF = ['unet_name', 'ckpt_name', 'model', 'model_name'];
  for (const key of PREF) {
    for (const node of Object.values(dict)) {
      if (!node || !node.inputs) continue;
      const v = node.inputs[key];
      if (typeof v === 'string' && /\.(safetensors|gguf|ckpt|pth|sft)$/i.test(v)) {
        return v.replace(/\.(safetensors|gguf|ckpt|pth|sft)$/i, '');
      }
    }
  }
  return null;
}

async function buildStatus() {
  const units = {};
  const nvmap = nvmapByPid();
  await Promise.all(Object.keys(UNIT_WHITELIST).map(async (u) => {
    units[u] = Object.assign({ key: u }, UNIT_WHITELIST[u], await unitState(u));
    /* active 只说明 systemd 起了进程；ready 才说明它已经能接请求。
     * 界面上凡是"能不能点/能不能打开"，判据一律用 ready。 */
    if (UNIT_PORT[u]) {
      units[u].ready = units[u].active === 'active' ? await probePort(UNIT_PORT[u]) : false;
    }
    const pidR = await run('systemctl', ['show', '-p', 'MainPID', '--value', u + '.service'], 8000);
    const pid = parseInt((pidR.stdout || '').trim(), 10);
    if (Number.isFinite(pid) && pid > 0) {
      const pm = procMem(pid);
      const gpu = nvmap[String(pid)] ? nvmap[String(pid)].bytes : 0;
      units[u].pid = pid;
      units[u].gpuB = gpu;                 // nvmap：模型权重 + KV 缓存 + 计算缓冲
      units[u].hostB = pm.anonB;           // 进程自己的匿名页
      units[u].realB = gpu + pm.anonB;     // 界面上显示这个
    }
  }));
  /* 生图统计跟着服务状态走：没 ready 就不去拉，避免拖慢整个 status */
  const comfy = await comfyStats(units['comfyui'] && units['comfyui'].ready);
  /* 档位与服务状态无关：服务停着也要能看出下次会用哪套参数 */
  const comfyProf = await comfyProfile().catch(() => null);

  return {
    now: new Date().toISOString(),
    comfy,
    comfyProfile: comfyProf,
    uptimeSec: Math.floor(parseFloat(readFileSafe('/proc/uptime').split(' ')[0]) || 0),
    kernel: readFileSafe('/proc/sys/kernel/osrelease').trim(),
    mem: memInfo(),
    gpuMem: gpuMem(),
    load: loadAvg(),
    thermal: thermals(),
    tegra: { ts: tegra.ts, ageMs: tegra.ts ? Date.now() - tegra.ts : null, ram: tegra.ram, cpu: tegra.cpu, emc: tegra.emc, gr3d: tegra.gr3d, dla: tegra.dla, pva: tegra.pva },
    disks: await disks(),
    net: netInfo(),
    ips: await ipAddrs(),
    units,
    models: models(),
    config: loadConfig(),
    guard: {
      enabled: GUARD.enabled, softGiB: GUARD.softGiB, hardGiB: GUARD.hardGiB,
      restarts: GUARD.restarts, lastReason: GUARD.lastReason,
      lastRestart: GUARD.lastRestart ? new Date(GUARD.lastRestart).toISOString() : null,
    },
  };
}

// ---------------------------------------------------------------- HTTP

const sendJSON = (res, code, obj) => {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
  res.end(b);
};
const readBody = (req) => new Promise((res) => {
  let b = ''; req.on('data', (d) => { b += d; if (b.length > 1e6) req.destroy(); }); req.on('end', () => res(b));
});

async function handleAuth(req, res, url, external) {
  const act = url.pathname.replace('/api/auth/', '');

  if (act === 'state') {
    const a = loadAuth();
    return sendJSON(res, 200, {
      configured: !!a,
      external,
      loggedIn: !!currentSession(req),
      lanFree: !external && loadConfig().requireLoginOnLan !== true,
    });
  }

  if (act === 'login' && req.method === 'POST') {
    const key = clientKey(req);
    const f = LOGIN_FAILS.get(key);
    if (f && f.until > Date.now()) {
      return sendJSON(res, 429, { error: '尝试次数过多，请 ' + Math.ceil((f.until - Date.now()) / 60000) + ' 分钟后再试' });
    }
    let pw = '';
    try { pw = (JSON.parse(await readBody(req)) || {}).password || ''; } catch (e) {}
    if (!loadAuth()) return sendJSON(res, 503, { error: '本面板尚未设置密码，需先在设备上执行 set-panel-password.sh 完成设置' });
    if (!verifyPassword(pw)) {
      const n = (f && f.until > Date.now() - LOCK_MS ? f.n : 0) + 1;
      LOGIN_FAILS.set(key, { n, until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
      console.log('[auth] 登录失败 from ' + key + '（第 ' + n + ' 次）');
      // 固定延迟，避免用响应时间区分"密码错"和"账号不存在"
      await new Promise((r) => setTimeout(r, 600));
      return sendJSON(res, 401, { error: '密码错误', remaining: Math.max(0, MAX_FAILS - n) });
    }
    LOGIN_FAILS.delete(key);
    issueSession(req, res);
    console.log('[auth] 登录成功 from ' + key);
    return sendJSON(res, 200, { ok: true });
  }

  if (act === 'logout' && req.method === 'POST') {
    const s = currentSession(req);
    if (s) SESSIONS.delete(s.sid);
    res.setHeader('Set-Cookie', 'iecu_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return sendJSON(res, 200, { ok: true });
  }

  return sendJSON(res, 404, { error: 'no such auth endpoint' });
}

/* 读 llama-server 的内置端点。面板要能显示「配置写的是什么」与「实际跑的是什么」
 * 两栏对照——只显示 config.json 的话，改完根本不知道有没有生效。 */
function httpGetJSON(port, path_, timeout = 4000) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, path: path_, method: 'GET', timeout }, (pr) => {
      let b = '';
      pr.on('data', (c) => { b += c; });
      pr.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } });
    });
    r.on('error', () => resolve(null));
    r.on('timeout', () => { r.destroy(); resolve(null); });
    r.end();
  });
}
function httpGetText(port, path_, timeout = 4000) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, path: path_, method: 'GET', timeout }, (pr) => {
      let b = '';
      pr.on('data', (c) => { b += c; });
      pr.on('end', () => resolve(b));
    });
    r.on('error', () => resolve(''));
    r.on('timeout', () => { r.destroy(); resolve(''); });
    r.end();
  });
}

/* llama.cpp 的 Prometheus 指标全是累计量，直接显示没有意义。
 * 存一份上次的读数做差分，才能得到"刚才这段时间的速度"。
 * 实测指标名前缀是 llamacpp:（不是网上文章里写的 llama_），共 14 个。 */
const METRICS_PREV = { llm: { at: 0, v: {} }, embed: { at: 0, v: {} } };
function parseMetrics(text) {
  const v = {};
  for (const line of text.split('\n')) {
    if (!line || line[0] === '#') continue;
    const sp = line.lastIndexOf(' ');
    if (sp < 0) continue;
    const n = parseFloat(line.slice(sp + 1));
    if (Number.isFinite(n)) v[line.slice(0, sp).trim()] = n;
  }
  return v;
}
function metricsDelta(v, who) {
  const slot = METRICS_PREV[who] || (METRICS_PREV[who] = { at: 0, v: {} });
  const now = Date.now();
  const p = slot.v, dtS = (now - slot.at) / 1000;
  const d = (k) => (p[k] !== undefined && v[k] !== undefined ? v[k] - p[k] : 0);
  const out = { windowSec: slot.at ? Math.round(dtS) : 0 };
  if (slot.at && dtS > 0.5) {
    const pt = d('llamacpp:prompt_tokens_total'), ps = d('llamacpp:prompt_seconds_total');
    const gt = d('llamacpp:tokens_predicted_total'), gs = d('llamacpp:tokens_predicted_seconds_total');
    out.promptTokens = pt;
    out.genTokens = gt;
    out.promptTps = ps > 0.01 ? pt / ps : null;
    out.genTps = gs > 0.01 ? gt / gs : null;
    out.busyRatio = Math.min(1, (ps + gs) / dtS);
  }
  slot.at = now; slot.v = v;
  return out;
}
/* 累计口径跨服务重启保留（见 accumulateLLM）；processing / deferred 是当前时点值，
 * 取本次读数即可。 */
function lifetimeOf(m) {
  const a = accumulateLLM(m);
  return {
    promptTokens: a.promptTokens,
    genTokens: a.genTokens,
    maxSeenTokens: a.maxSeenTokens,
    promptTps: a.promptSeconds > 0.01 ? a.promptTokens / a.promptSeconds : null,
    genTps: a.genSeconds > 0.01 ? a.genTokens / a.genSeconds : null,
    promptSeconds: a.promptSeconds, genSeconds: a.genSeconds,
    decodeCalls: a.decodeCalls,
    serviceRestarts: a.serviceRestarts,
    requests: a.requests,
    avgPromptSec: a.avgPromptSec,
    since: LIFE.since,
    busySlotsPerDecode: m['llamacpp:n_busy_slots_per_decode'] || 0,
    processing: m['llamacpp:requests_processing'] || 0,
    deferred: m['llamacpp:requests_deferred'] || 0,
  };
}

/* ── 历史采样 ───────────────────────────────────────────────
 * 面板要画趋势图。放在服务端做环形缓冲，刷新页面不丢数据；
 * 板子重启才归零（本来也没有持久化的地方，/tmp 是内存盘）。
 * 10 秒一个点 × 2160 个点 = 6 小时，内存开销约 150 KB。 */
const HIST = { cap: 2160, buf: [], stepMs: 10000, lastAt: 0 };
async function sampleHistory() {
  const cfg = loadConfig();
  const [mText, eText, slots] = await Promise.all([
    httpGetText(cfg.port || 8080, '/metrics', 3000),
    httpGetText(cfg.embeddingPort || 8081, '/metrics', 3000),
    httpGetJSON(cfg.port || 8080, '/slots', 3000),
  ]);
  const m = mText ? parseMetrics(mText) : {};
  const e = eText ? parseMetrics(eText) : {};
  // 累计量在这里推进，不依赖前端是否在轮询 /api/status——没人开面板时也要记账
  accumulateLLM(m, modelKeyOf(cfg.model));
  const mem = memInfo();
  const th = thermals();
  const s = Array.isArray(slots) && slots[0] ? slots[0] : null;
  const rec = {
    t: Date.now(),
    tj: th.tj ?? th.GPU ?? null,
    availKB: mem.availKB,
    gr3d: tegra.gr3d ? tegra.gr3d.pct : null,
    // 内存带宽不入库：这块板子的 tegrastats 只输出 EMC_FREQ @0，满载采样 44 次
    // 也没有过百分比，存进来就是一整条 null。
    // 累计量原样存，前端做差分算速率——存速率会因为采样错位失真
    pTok: m['llamacpp:prompt_tokens_total'] || 0,
    pSec: m['llamacpp:prompt_seconds_total'] || 0,
    gTok: m['llamacpp:tokens_predicted_total'] || 0,
    gSec: m['llamacpp:tokens_predicted_seconds_total'] || 0,
    // 编码用量取自代理层累计（服务端计数器在 embedding 模式下不动）
    ePTok: EMBSTAT.tokens,
    ePSec: EMBSTAT.ms / 1000,
    /* ★ 上下文占用只取 n_prompt_tokens，不能再加 n_decoded（2026-08-21 修，陷阱 68）。
     * 原来写的是两者相加，但 b10498 里 n_prompt_tokens 的语义是
     * **slot 上下文的当前总量，已经含了生成出来的部分**，相加等于把生成量数两遍。
     * 实测 60 秒采样：n_prompt_tokens 4422→6871、n_decoded 476→2922，增量 2449 与 2446
     * 同步增长；4422-476=3946 正是调用方的原始 prompt 长度。
     * 这个 bug 让面板报出 162K、峰值甚至 258035，而 n_ctx 只有 131072——
     * 用户据此判断"上下文被撑爆"，调用方据此改了重试逻辑，两边都白查一轮。
     * 再按 n_ctx 封顶：llama.cpp 拒绝超长请求之前会先把 n_prompt_tokens 填上，
     * 采样正好命中那一瞬就会读到一个物理上装不下的数（KV 池是启动时按 n_ctx 预分配死的）。 */
    ctx: s ? Math.min(s.n_prompt_tokens || 0, s.n_ctx || Infinity) : 0,
    q: m['llamacpp:requests_deferred'] || 0,
    // 12 个核心里的最高占用。存进来才能让 CPU 峰值跨页面刷新保留
    cpu: Array.isArray(tegra.cpu) && tegra.cpu.length
      ? Math.max(...tegra.cpu.map((c) => c.pct || 0)) : null,
  };
  HIST.buf.push(rec);
  if (HIST.buf.length > HIST.cap) HIST.buf.splice(0, HIST.buf.length - HIST.cap);
  /* 峰值按当前模型分桶。用 config 里的模型路径而不是 /props——这里不发 /props 请求，
   * 而 config 与实际运行的模型在正常情况下一致（不一致时下一次重启就对上了）。 */
  updatePeaks(modelKeyOf(cfg.model));
}

/* 峰值遍历历史缓冲得出，不靠前端在内存里累积。
 * 前端那份 useRef 刷新页面就归零，而且只覆盖"面板正开着"的时段——
 * 会话跑完再打开面板，峰值永远是空的。这里扫 6 小时的采样点，
 * 刷新浏览器、换台设备看都还在。
 * 速率类峰值用相邻两点的累计量差分算，不用瞬时值：计数器回退说明服务重启过，
 * 那一段差分没有意义，跳过。 */
/* 一个 token 存进 prompt 缓存池要占的字节数。实测得来，推导过程见 buildRuntime 里
 * promptStateBytesPerToken 的注释。改模型或改投机方案后必须重算。 */
const PROMPT_STATE_B_PER_TOKEN = 34 * 1024;

/* 每采到一个新点就地更新峰值。在 sampleHistory 末尾调用，所以没人开面板时也在记，
 * 也不会像"每次 API 调用全扫 2160 个点"那样白费 CPU。
 * 速率类峰值取相邻两点累计量的差分：计数器回退说明 llama-server 重启过，差分为负，
 * 自然被 >0 的条件挡掉。 */
function updatePeaks(modelKey) {
  const b = HIST.buf;
  if (!b.length) return;
  const P = LIFE.peak;                                   // 机器级
  const M = (LIFE.byModel[modelKey] ||= { genTps: 0, promptTps: 0, ctx: 0, since: Date.now() }); // 模型级
  const r = b[b.length - 1];
  const bump = (o, k, v) => {
    if (Number.isFinite(v) && v > (o[k] || 0)) { o[k] = v; statsDirty = true; }
  };
  bump(M, 'ctx', r.ctx);
  bump(P, 'tj', r.tj);
  bump(P, 'cpu', r.cpu);
  if (Number.isFinite(r.availKB) && (P.availKBMin == null || r.availKB < P.availKBMin)) {
    P.availKBMin = r.availKB; statsDirty = true;
  }
  if (b.length < 2) return;
  const p = b[b.length - 2];
  const dGT = r.gTok - p.gTok, dGS = r.gSec - p.gSec;
  if (dGT > 0 && dGS > 0.1) bump(M, 'genTps', dGT / dGS);
  const dPT = r.pTok - p.pTok, dPS = r.pSec - p.pSec;
  if (dPT > 0 && dPS > 0.1) bump(M, 'promptTps', dPT / dPS);
}

/* 当前模型自己的用量与均速。与 lifetime（跨模型终身累计）并列返回，
 * 界面上凡是"这个模型跑多快"的位置都该用这一份，不要用 lifetime。 */
function modelUsageOf(modelKey) {
  const M = LIFE.byModel[modelKey];
  if (!M) return null;
  return {
    key: modelKey,
    promptTokens: M.promptTokens || 0,
    genTokens: M.genTokens || 0,
    promptSec: M.promptSec || 0,
    genSec: M.genSec || 0,
    promptTps: M.promptSec > 0.01 ? M.promptTokens / M.promptSec : null,
    genTps: M.genSec > 0.01 ? M.genTokens / M.genSec : null,
    since: M.since || null,
  };
}

function peaksOf(modelKey) {
  const b = HIST.buf;
  const P = LIFE.peak;
  const M = LIFE.byModel[modelKey] || {};
  return {
    /* 模型级三项：没有该模型的记录就返回 null，界面显示"—"。
     * 宁可空着，也不要把别的模型的峰值安在当前模型头上。 */
    genTps: M.genTps || null,
    promptTps: M.promptTps || null,
    ctx: M.ctx || 0,
    modelKey,
    modelPeakSince: M.since || null,
    /* 机器级三项与模型无关，照旧全局 */
    tj: P.tj || null,
    cpu: P.cpu || null,
    availKBMin: P.availKBMin,
    since: LIFE.since,
    windowSec: b.length ? Math.round((b[b.length - 1].t - b[0].t) / 1000) : 0,
    points: b.length,
  };
}

async function handleAPI(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]

  if (seg[1] === 'status') return sendJSON(res, 200, await buildStatus());

  /* 清理文件缓存。
   * 说明口径（界面上也要这么写）：这不是"内存泄漏需要清"，Linux 的文件缓存在内存
   * 不足时内核会自动回收，面板显示的"剩余可分配"里**已经把它算进去了**。
   * 提供这个按钮只为一种场景：切模式或加载大模型前，想让内存回到干净状态再开始。
   * 代价是下次读模型要重新走磁盘，加载会慢一些。 */
  if (seg[1] === 'drop-caches' && req.method === 'POST') {
    const before = memInfo();
    await run('sync', [], 20000);
    const r = await run('sh', ['-c', 'echo 3 > /proc/sys/vm/drop_caches'], 20000);
    await new Promise((s) => setTimeout(s, 400));
    const after = memInfo();
    return sendJSON(res, 200, {
      ok: r.code === 0,
      code: r.code, stderr: (r.stderr || '').trim().slice(0, 300),
      before: { cachedKB: before.cachedKB, availKB: before.availKB },
      after: { cachedKB: after.cachedKB, availKB: after.availKB },
      freedKB: Math.max(0, (before.cachedKB || 0) - (after.cachedKB || 0)),
    });
  }

  if (seg[1] === 'logs') {
    const unit = seg[2];
    // 可以看日志的范围比可以启停的范围宽：面板自身与网络相关的几个 unit 也要能查，
    // 但它们不在 UNIT_WHITELIST 里（那张表管的是"允许被启停"）。
    const LOG_OK = { 'iecu-panel': 1, 'iecu-frpc': 1, 'iecu-egress': 1, 'iecu-lan-ip': 1 };
    if (!UNIT_WHITELIST[unit] && !LOG_OK[unit]) return sendJSON(res, 400, { error: 'unit not allowed' });
    const n = Math.min(parseInt(url.searchParams.get('n') || '200', 10) || 200, 2000);
    const r = await run('journalctl', ['-u', unit + '.service', '--no-pager', '-n', String(n)], 20000);
    return sendJSON(res, 200, { unit, text: r.stdout || r.stderr });
  }

  if (seg[1] === 'service' && req.method === 'POST') {
    const unit = seg[2], action = seg[3];
    if (!UNIT_WHITELIST[unit]) return sendJSON(res, 400, { error: 'unit not allowed' });
    if (!['start', 'stop', 'restart'].includes(action)) return sendJSON(res, 400, { error: 'bad action' });
    const r = await run('systemctl', [action, unit + '.service'], 120000);
    return sendJSON(res, 200, { unit, action, code: r.code, stdout: r.stdout, stderr: r.stderr });
  }

  /* 模式切换：三种模式互斥，因为它们都要独占大块内存——
   * 智驾栈 11 GB、对话模型 20.4 GB(GPU 映射)+3.2 GB、生图模型按模型大小算。
   * disable/enable 落在 /etc（overlay，upperdir 在 /persistent 分区）→ 跨重启持久。
   *
   * 向量服务不参与互斥：它走 CPU 档只占约 1.3 GB，对话和生图都容得下，
   * 而多数场景要它常驻。要腾这 1.3 GB 时用 /api/service 单独停，不由模式切换代劳。
   * 只有切回车机模式才会停它——那时整个 LLM 栈都要让位。
   *
   * 开机自启只在「推理」「车机」之间切换。生图模式是临时态，切过去不改自启项，
   * 断电重启后回到推理模式——用户要的就是"平时不占资源"。 */
  if (seg[1] === 'mode' && req.method === 'POST') {
    const mode = seg[2];
    const steps = [];
    const doStep = async (label, cmd, args, timeoutMs) => {
      /* 切档脚本自带"重启 + 探端口"，最长要 180 秒（陷阱 51：不能只看 is-active），
       * 再加重启本身的开销，给它 240 秒；其余步骤维持 180 秒。 */
      const r = await run(cmd, args, timeoutMs || 180000);
      steps.push({ label, cmd: cmd + ' ' + args.join(' '), code: r.code, out: (r.stdout + r.stderr).trim().slice(0, 500) });
    };
    if (mode === 'llm') {
      await doStep('停生图服务', 'systemctl', ['stop', 'comfyui.service']);
      await doStep('停智驾栈', 'systemctl', ['stop', 'application_start.service']);
      await doStep('禁止智驾栈开机自启', 'systemctl', ['disable', 'application_start.service']);
      await doStep('允许 LLM 开机自启', 'systemctl', ['enable', 'llm-server.service']);
      await doStep('启动 LLM', 'systemctl', ['restart', 'llm-server.service']);
    } else if (mode === 'image' || mode === 'video') {
      /* 生图与生视频是同一个 ComfyUI 服务的两组启动参数，不是两个服务。
       * ★ 必须走 comfy-profile.sh，不能只 `systemctl restart comfyui`——
       *   若上次切过 video 档，drop-in 还在，重启仍沿用 DynamicVRAM 参数，
       *   而那套参数下生图**慢 14~38% 且不报任何错**（2026-09-02 四份 bench 实测：
       *   30.2→35.2s / 15.5→21.4s / 33.3→38.1s / 15.5→19.0s）。
       *   反过来用生图档跑长视频则会在 8 分钟处被 OOM 杀掉。
       *   脚本自己会 daemon-reload、重启、并探端口到真能应答为止。
       * ⚠ 切 video 前脚本会检查 sitecustomize.py 在不在，缺了就拒绝并退出 1——
       *   没有它，去掉 --highvram 会因 static TLS 耗尽而起不来（与内存无关）。*/
      await doStep('停对话模型', 'systemctl', ['stop', 'llm-server.service']);
      await doStep('停智驾栈', 'systemctl', ['stop', 'application_start.service']);
      await doStep(mode === 'image' ? '切到生图档并启动' : '切到生视频档并启动',
        '/var/lib/llm/comfy-profile.sh', [mode], 240000);
      /* 故意不动开机自启：生图/生视频都是临时态，断电重启回到推理模式 */
    } else if (mode === 'car') {
      await doStep('停 LLM', 'systemctl', ['stop', 'llm-server.service']);
      await doStep('停生图服务', 'systemctl', ['stop', 'comfyui.service']);
      await doStep('停 Embedding', 'systemctl', ['stop', 'llm-embedding.service']);
      await doStep('禁止 LLM 开机自启', 'systemctl', ['disable', 'llm-server.service']);
      await doStep('恢复智驾栈开机自启', 'systemctl', ['enable', 'application_start.service']);
      await doStep('启动智驾栈', 'systemctl', ['start', 'application_start.service']);
    } else return sendJSON(res, 400, { error: 'mode must be llm, image, video or car' });
    /* ok 让前端一眼看出成败：切档脚本缺 sitecustomize 会退出 1、探端口超时也退出 1，
     * 那时服务可能根本没起来，界面不该显示成"已切换"。 */
    const ok = steps.every(s => s.code === 0);
    return sendJSON(res, 200, { mode, steps, ok });
  }

  /* 推理模式预设（2026-08-12 双模型布局，2026-08-17 加入第三档）：
   *   mtp / mm  —— 同一个 Qwen3.6-35B-A3B 的两种加载方式
   *   q38       —— 另一个模型 Qwen3.8-27B，与前两档互斥（共用 8080 的 llm-server）
   * 预设文件 /var/lib/llm/config-preset-{mtp,mm,q38}.json 由部署时写好，
   * 切换 = 整份覆盖 config.json 后重启 llm-server。判断当前态看 config 的 model 路径。 */
  if (seg[1] === 'preset') {
    const PRESETS = {
      mtp: { label: 'MTP 加速', desc: '32K 以上上下文生成快 28%~50%；图像走 CPU，1024×1024 约 28 秒。加载约 1.5 分钟' },
      mm: { label: '多模态加速', desc: '图像走 GPU，1024×1024 约 4 秒；生成速度为基准值。加载约 4 分钟' },
      q38: { label: 'Qwen3.8-27B', desc: '27B 密集模型，生成 11.9 tok/s、预填充 244 tok/s，上下文 64K，不支持图像。加载约 75 秒' },
    };
    /* 预设只负责推理服务那几项。这些字段属于别的子系统，整份覆盖会把它们清掉
     * （2026-08-12 漏掉 embeddingModel 差点让向量服务静默退回 F16）。 */
    const PRESET_KEEP = [
      'embeddingModel', 'embeddingBackend', 'embeddingPort', 'embeddingParallel',
      'embeddingCtxSlot', 'embeddingCacheRam', 'sites', 'bindHost', 'requireLoginOnLan',
      'generalEgress',   // 全局出网开关（site-egress.sh 读，缺省视为 true）
    ];
    const presetPath = (n) => '/var/lib/llm/config-preset-' + n + '.json';
    const readPreset = (n) => JSON.parse(fs.readFileSync(presetPath(n), 'utf8'));
    /* 就绪不能只看文件存在——传输中的半截模型也"存在"。预设里记录期望字节数
     * （modelSizeB），达标才算就绪；没记录时退化为存在性检查。 */
    const modelReady = (p) => {
      try {
        const st = fs.statSync(p.model);
        return !p.modelSizeB || st.size === p.modelSizeB;
      } catch (e) { return false; }
    };
    if (req.method === 'GET') {
      const cur = loadConfig();
      const out = {};
      for (const n of Object.keys(PRESETS)) {
        try {
          const p = readPreset(n);
          out[n] = {
            label: PRESETS[n].label, desc: PRESETS[n].desc, model: p.model,
            modelReady: modelReady(p), active: p.model === cur.model,
          };
        } catch (e) { out[n] = { label: PRESETS[n].label, desc: PRESETS[n].desc, missing: true }; }
      }
      return sendJSON(res, 200, { presets: out });
    }
    if (req.method === 'POST') {
      const name = seg[2];
      if (!PRESETS[name]) return sendJSON(res, 400, { error: 'preset must be one of: ' + Object.keys(PRESETS).join(', ') });
      /* 切预设 = 重启 llm-server。生图模式下这等于把模式偷偷切回推理，
       * 且生图正在用的那 14 GB 会和对话模型的 20 GB 撞在一起。
       * 前端已按模式禁用了按钮，这里是兜底——接口不能依赖界面的自觉。 */
      {
        const cs = await unitState('comfyui');
        if (cs.active === 'active') {
          return sendJSON(res, 409, {
            error: '当前是生图模式，切换对话模型会同时启动两套模型、超出内存。'
              + '请先在「运行模式」切换到推理模式。',
          });
        }
      }
      let p;
      try { p = readPreset(name); } catch (e) { return sendJSON(res, 400, { error: '预设文件缺失或损坏：' + presetPath(name) }); }
      if (!p.model || !modelReady(p)) return sendJSON(res, 400, { error: '预设指向的模型文件缺失或不完整：' + (p.model || '(空)') });
      if (p.mmproj && !fs.existsSync(p.mmproj)) return sendJSON(res, 400, { error: '多模态投影文件不存在：' + p.mmproj });
      const cur = loadConfig();
      const next = Object.assign({}, p);
      delete next.modelSizeB;   // 校验元数据不进 config.json
      delete next.presetNote;   // 同上：给维护者看的说明，不是运行参数
      for (const k of PRESET_KEEP) {
        if (cur[k] !== undefined) next[k] = cur[k];   // 保住不归预设管的字段
      }
      saveConfig(next);
      const r = await run('systemctl', ['restart', 'llm-server.service'], 120000);
      return sendJSON(res, 200, { applied: name, restartCode: r.code });
    }
  }

  /* 板上有哪些生图模型。生图模式下面板要能回答"我现在能画什么"，
   * 否则那张卡片在生图模式下是空的——用户只能去生图界面里翻下拉框。
   * 只读列目录，不做任何加载；具体用哪个仍在生图界面的工作流里选。 */
  if (seg[1] === 'sd-models' && req.method === 'GET') {
    const ROOTS = ['/opt/m0/sd-models', '/opt/m/sd-models', '/opt/update/sd-models'];
    /* checkpoint 是单文件、选中即可出图；diffusion 要另配文本编码器与 VAE，
     * 界面上必须区分，否则用户会以为选了就能用。 */
    const KINDS = [
      { dir: 'checkpoints', kind: 'checkpoint' },
      { dir: 'diffusion_models', kind: 'diffusion' },
      { dir: 'unet', kind: 'diffusion' },
    ];
    /* 单文件 checkpoint 自带编码器；diffusion 类要额外驮上文本编码器与 VAE，
     * 判断"装不装得下"必须算总量——Z-Image 的 DiT 只有 11.46 GB，
     * 加上 7.49 GB 的文本编码器就是 19.3 GB，直接超预算。 */
    /* ⚠ 2026-08-15 修：这里原本是把目录里**所有**文件求和，那是错的——
     * 一次出图只会加载**一个**文本编码器和**一个** VAE，不会把目录里的全载进去。
     * 目录里同时放着 fp16(7.7G) 与 Q8_0(4.1G) 两个编码器之后，求和得 11.8G，
     * 于是把明明正在正常出图的 Z-Image Q8_0 判成了"内存不足"——用户看到的
     * 是一条与事实相反的告警。
     * 现在取每类里**最小的那个**做估算：量化档就是拿来用的，按最小档估才贴近实际用法。 */
    const minInDir = (sub) => {
      let min = 0;
      for (const root of ROOTS) {
        const d = path.join(root, sub);
        let names = [];
        try { names = fs.readdirSync(d); } catch (e) { continue; }
        for (const n of names) {
          if (!/\.(safetensors|ckpt|gguf|sft|pt|pth)$/i.test(n)) continue;
          try {
            const s = fs.statSync(path.join(d, n)).size;
            if (s > 0 && (min === 0 || s < min)) min = s;
          } catch (e) { /* 跳过读不到的 */ }
        }
      }
      return min;
    };
    const companionB = minInDir('text_encoders') + minInDir('vae');
    /* 生图模式全常驻不做 offload，能装多大有两个实测锚点，中间那段没测过，
     * 所以分三档讲，不把内插值说成确定结论：
     *   14.53 GB（Z-Image Q8_0 全套）— 实测连出三张稳定，出图后仍余 5.3 GB
     *   19.27 GB（Z-Image bf16 全套）— 实测加载阶段即被内核 OOM 杀
     * 依据见 evidence-levels 的 A-116 / A-124。 */
    const FIT_OK_B = 15 * 1073741824;    // 有实测支撑
    const FIT_OVER_B = 18 * 1073741824;  // 超过这里必挂
    const fitOf = (b) => (b <= FIT_OK_B ? 'ok' : b >= FIT_OVER_B ? 'over' : 'tight');
    const out = [];
    for (const root of ROOTS) {
      for (const { dir, kind } of KINDS) {
        const d = path.join(root, dir);
        let names = [];
        try { names = fs.readdirSync(d); } catch (e) { continue; }
        for (const n of names) {
          if (!/\.(safetensors|ckpt|gguf|sft)$/i.test(n)) continue;
          let sizeB = 0;
          try { sizeB = fs.statSync(path.join(d, n)).size; } catch (e) { continue; }
          const totalB = kind === 'diffusion' ? sizeB + companionB : sizeB;
          out.push({
            name: n, sizeB, kind, totalB,
            quantized: /\.gguf$/i.test(n),
            fit: fitOf(totalB),
          });
        }
      }
    }
    out.sort((a, b) => b.sizeB - a.sizeB);
    return sendJSON(res, 200, { models: out, companionB, fitOkB: FIT_OK_B, fitOverB: FIT_OVER_B });
  }

  /* 向量服务的计算后端。GPU 档占 GPU 映射内存约 2.2 GB；CPU 档不占，改用 11 个 CPU 核。
   * 两档算出的向量不是同一组数值（实测余弦相似度 0.9997），换档后知识库要重建索引。 */
  if (seg[1] === 'embedding-backend') {
    const cur = loadConfig();
    const now = cur.embeddingBackend === 'cpu' ? 'cpu' : 'cuda';
    if (req.method === 'GET') {
      return sendJSON(res, 200, {
        active: now,
        options: {
          cuda: { label: 'GPU', desc: '单条 12 ms；占用 GPU 映射内存约 2.2 GB' },
          cpu: { label: 'CPU', desc: '单条 23 ms；不占 GPU 映射内存，使用 11 个 CPU 核' },
        },
      });
    }
    if (req.method === 'POST') {
      const want = seg[2];
      if (want !== 'cpu' && want !== 'cuda') return sendJSON(res, 400, { error: 'backend must be cpu or cuda' });
      if (want === now) return sendJSON(res, 200, { applied: want, restartCode: 0, unchanged: true });
      const next = Object.assign({}, cur, { embeddingBackend: want });
      saveConfig(next);
      const r = await run('systemctl', ['restart', 'llm-embedding.service'], 120000);
      return sendJSON(res, 200, { applied: want, restartCode: r.code });
    }
  }

  if (seg[1] === 'config' && req.method === 'POST') {
    const body = await readBody(req);
    let incoming;
    try { incoming = JSON.parse(body); } catch (e) { return sendJSON(res, 400, { error: 'bad json' }); }
    const cur = loadConfig();
    /* 白名单字段，且模型路径必须落在 MODEL_DIR 内 */
    const next = Object.assign({}, cur);
    if (typeof incoming.model === 'string') {
      const rp = path.resolve(incoming.model);
      if (!inModelDirs(rp)) return sendJSON(res, 400, { error: 'model must be under ' + MODEL_DIRS.join(' 或 ') });
      if (!fs.existsSync(rp)) return sendJSON(res, 400, { error: 'model file not found' });
      next.model = rp;
    }
    if (typeof incoming.mmproj === 'string') {
      if (incoming.mmproj === '') next.mmproj = '';
      else {
        const rp = path.resolve(incoming.mmproj);
        if (!inModelDirs(rp) || !fs.existsSync(rp)) return sendJSON(res, 400, { error: 'bad mmproj' });
        next.mmproj = rp;
      }
    }
    for (const k of ['ctx', 'ngl', 'port', 'threads', 'parallel', 'cacheRamMiB', 'batchSize', 'ubatchSize',
      'embeddingPort', 'embeddingParallel', 'embeddingCtxSlot', 'embeddingCacheRam']) {
      if (incoming[k] !== undefined) { const v = parseInt(incoming[k], 10); if (Number.isFinite(v) && v >= 0) next[k] = v; }
    }
    // 监听地址只允许这两个值：全网卡，或收进本机只走面板反代
    if (incoming.bindHost === '0.0.0.0' || incoming.bindHost === '127.0.0.1') next.bindHost = incoming.bindHost;
    // 思考内容的返回格式。客户端看不到思考链时改这个
    if (typeof incoming.reasoningFormat === 'string'
      && /^(|none|auto|deepseek|deepseek-legacy)$/.test(incoming.reasoningFormat)) next.reasoningFormat = incoming.reasoningFormat;
    // 局域网是否也要求登录。默认 false——打开前想清楚，改错了本地也进不来
    if (typeof incoming.requireLoginOnLan === 'boolean') next.requireLoginOnLan = incoming.requireLoginOnLan;
    // 后端切换：cpu / cuda 两套二进制并存。run-server.sh 里若目标不存在会自动回退到 cpu。
    if (incoming.backend === 'cpu' || incoming.backend === 'cuda') next.backend = incoming.backend;
    // 绑核串：实测 taskset -c 0-4,6-11 (避开被 isolcpus 隔离的 CPU5) 是 CPU 后端最优，
    // 用上 CPU5 反而崩到 1.67 t/s。只接受数字、逗号、连字符，杜绝命令注入。
    if (typeof incoming.cpuList === 'string' && /^[0-9,\-]*$/.test(incoming.cpuList)) next.cpuList = incoming.cpuList;
    for (const k of ['cacheTypeK', 'cacheTypeV']) {
      if (typeof incoming[k] === 'string' && /^(|f32|f16|bf16|q8_0|q5_1|q5_0|q4_1|q4_0)$/.test(incoming[k])) next[k] = incoming[k];
    }
    if (incoming.flashAttn === 'on' || incoming.flashAttn === '') next.flashAttn = incoming.flashAttn;
    // 聊天模板参数，目前只用来关思考：{"enable_thinking":false}。
    // 空串 = 不传该参数，走模型默认（思考开）。必须是扁平 JSON 对象，长度设上限。
    if (typeof incoming.chatTemplateKwargs === 'string') {
      const s = incoming.chatTemplateKwargs.trim();
      if (s === '') next.chatTemplateKwargs = '';
      else if (s.length <= 200) {
        try {
          const o = JSON.parse(s);
          const flat = o && typeof o === 'object' && !Array.isArray(o)
            && Object.values(o).every((v) => ['boolean', 'number', 'string'].includes(typeof v));
          if (flat) next.chatTemplateKwargs = JSON.stringify(o);
        } catch (e) { /* 非法 JSON 直接忽略，保留原值 */ }
      }
    }
    if (Array.isArray(incoming.extraArgs)) next.extraArgs = incoming.extraArgs.filter((a) => typeof a === 'string').slice(0, 40);
    saveConfig(next);
    return sendJSON(res, 200, { saved: next, hint: '改动在下次 restart llm-server 后生效' });
  }

  if (seg[1] === 'tegra') return sendJSON(res, 200, { raw: tegra.raw, ts: tegra.ts });

  /* 推理服务的运行时真相：实际生效的参数、当前 slot 在干什么、这段时间的吞吐。
   * 这三样是面板此前完全没有的——之前只显示硬件，看不到 AI 服务本身。 */
  /* 历史曲线。前端传 minutes，这里按需抽稀，避免一次吐几千个点。 */
  if (seg[1] === 'history') {
    const minutes = Math.min(360, Math.max(5, parseInt(url.searchParams.get('minutes') || '60', 10) || 60));
    const since = Date.now() - minutes * 60000;
    const rows = HIST.buf.filter((r) => r.t >= since);
    const maxPts = 180;
    const step = Math.max(1, Math.ceil(rows.length / maxPts));
    const out = step === 1 ? rows : rows.filter((_, i) => i % step === 0);
    return sendJSON(res, 200, { stepMs: HIST.stepMs * step, points: out, spanMin: minutes });
  }

  if (seg[1] === 'runtime') {
    const cfg = loadConfig();
    const port = cfg.port || 8080;
    const ePort = cfg.embeddingPort || 8081;
    const [props, slots, mtext, etext, eprops] = await Promise.all([
      httpGetJSON(port, '/props'),
      httpGetJSON(port, '/slots'),
      httpGetText(port, '/metrics'),
      httpGetText(ePort, '/metrics'),
      httpGetJSON(ePort, '/props'),
    ]);
    const metrics = mtext ? parseMetrics(mtext) : {};
    const eMetrics = etext ? parseMetrics(etext) : {};
    const slotList = Array.isArray(slots) ? slots : [];
    /* KV 占用：llama.cpp 不给现成的使用率，用 slot 上的词元数除以 n_ctx 自己算。
     * n_prompt_tokens_cache 是这次请求里命中前缀缓存、不需要重算的部分——
     * 接 RAG 时这个数字直接决定首字延迟，值得显示出来。 */
    const kv = slotList.map((s) => {
      const nt = (s.next_token && s.next_token[0]) || {};
      const decoded = nt.n_decoded || 0;
      const nCtx = s.n_ctx || cfg.ctx || 0;
      /* 同上（陷阱 68）：n_prompt_tokens 已含生成部分，不能再加 decoded，
       * 否则 KV 占用率会算成接近两倍、"剩余可容纳"提前归零。
       * decoded 仍单独往下传，那是"这次生成了多少"的独立信息，有展示价值。 */
      const used = Math.min(s.n_prompt_tokens || 0, nCtx || Infinity);
      return {
        id: s.id, nCtx, used, remain: Math.max(0, nCtx - used),
        busy: !!s.is_processing, taskId: s.id_task,
        promptTokens: s.n_prompt_tokens || 0,
        cachedTokens: s.n_prompt_tokens_cache || 0,
        processedTokens: s.n_prompt_tokens_processed || 0,
        decoded,
      };
    });
    // 终身平均：累计词元 ÷ 累计耗时。和窗口速率互补——窗口看当下，终身看整体
    const lifetime = lifetimeOf(metrics);
    /* 上下文缓存每 token 的字节开销，用来把 token 数换算成 GB。
     * ★ 这个数**按模型不同**（2026-08-19 修）：原来写死 18 KiB，那是对
     * Qwen3.6-35B-A3B 实测的（把日志里 "release: n_tokens = N" 与紧随的
     * "prompt state size X MiB" 配对，六组样本落在 16.2~21.6 KB，中位数 17.9）。
     * 换成 Qwen3.8-27B 之后这个数不再成立：它是 SSM 与全注意力混合架构
     * （full_attention_interval=4，65 层里只有约 16 层有 KV），KV 结构完全不同。
     * 继续套用只会让「KV 已占」「剩余可容纳」给出错的数字。
     * → 改为按模型查表 + 允许 config 覆盖；查不到就返回 null，界面显示"—"。
     *   宁可空着，也不要显示一个替别的模型算出来的数。
     * 重测方法：journalctl -u llm-server | grep 'prompt state size'，与紧邻的
     * "release: ... n_tokens = N" 配对相除（⚠ 板上 dd1ea52 这个 build 不打印该行，
     * 要么换用 ctx 差分实测 nvmap，要么在能打印的 build 上测）。 */
    /* 表里的数由**模型自己的 GGUF 元数据**算出（2026-08-19），不是拿另一个模型的经验值套：
     *   每 token 字节 = 有 KV 的层数 × head_count_kv × (key_length + value_length) × 每元素字节
     *   有 KV 的层数  = floor(block_count / full_attention_interval)  ← 这两族都是 SSM/注意力混合
     *   q8_0 每元素   = 34 B / 32 元素 = 1.0625 B
     * · Qwen3.8-27B (qwen35)      : 65/4 → 16 层，kv_head 4，k=v=256 → 16×4×512×1.0625 = 34816 B
     * · Qwen3.6-35B-A3B(qwen35moe): 41/4 → 10 层，kv_head 2，k=v=256 → 10×2×512×1.0625 = 10880 B
     * 27B 这个 34 KiB 与 A-163 记的「约 32 KiB/token、128K 约 4 GiB」相符，公式可信。
     * ⚠ Qwen3.6 那一族原来写的 18 KiB 与公式对不上——追溯发现那个数是拿
     *   "prompt state size ÷ n_tokens" 量的，而整份会话状态还含 SSM 状态与投机上下文，
     *   与裸 KV 不是同一件事。这里**保留 18 KiB 不动**：没有新的实测支撑，不去改一个
     *   正在用的数（陷阱 52 的教训——凭推算改判据，会把本来对的东西判错）。
     *   要定论就拿 ctx 差分实测 nvmap，别再用推算互相印证。
     * 文件名要与板上实际一致，写错就退化成 null（界面显示"—"），不会显示错的数。 */
    const KV_B_PER_TOKEN = {
      'Qwen3.8-27B-IQ4_XS.gguf': 34816,                 // 由该模型元数据算出
      'Qwen3.6-35B-A3B-MTP-UD-IQ4_XS.gguf': 18 * 1024,  // 沿用既有口径，见上
      'Qwen3.6-35B-A3B-UD-IQ4_XS.gguf': 18 * 1024,
    };
    const kvBase = Number.isFinite(cfg.kvBytesPerToken) ? cfg.kvBytesPerToken
      : KV_B_PER_TOKEN[modelKeyOf(cfg.model)];
    const kvBytesPerToken = kvBase ? kvBase * (cfg.cacheTypeK === 'q8_0' ? 1 : 2) : null;
    const p = props || {};
    const gp = (p.default_generation_settings || {});
    return sendJSON(res, 200, {
      up: !!props,
      // 运行值（llama-server 自己报的，不是 config.json 里写的）
      running: props ? {
        modelPath: p.model_path, modelAlias: p.model_alias, ftype: p.model_ftype,
        nCtx: gp.n_ctx, totalSlots: p.total_slots,
        modalities: p.modalities, buildInfo: p.build_info,
        endpoints: { slots: p.endpoint_slots, metrics: p.endpoint_metrics, props: p.endpoint_props },
        sampling: gp.params ? {
          temperature: gp.params.temperature, topK: gp.params.top_k, topP: gp.params.top_p,
          minP: gp.params.min_p, repeatPenalty: gp.params.repeat_penalty,
          reasoningFormat: gp.params.reasoning_format, chatFormat: gp.params.chat_format,
        } : null,
      } : null,
      kv,
      kvBytesPerToken,
      promptCacheMiB: cfg.cacheRamMiB ?? 1024,
      /* 缓存池能装下多长的会话，不能拿 kvBytesPerToken 去除。
       * 存进池子的是整份 prompt state，比裸 KV 大得多：2026-08-13 实测
       * 122046 token 的会话，日志报 "prompt state size 3999.763 MiB"，
       * 折合 33.55 KiB/token —— 是 KV 那 18 KiB 的 1.86 倍（MTP 的 draft
       * context 也要存一份）。⚠ 换模型、改投机方案、改 KV 量化后这个系数会变，
       * 重算方法：journalctl -u llm-server | grep 'prompt state size'，
       * 与紧邻的 "release: ... n_tokens = N" 配对相除。 */
      /* 同样按模型走：34 KiB 是 Qwen3.6-35B-A3B + MTP 的实测值，
       * 换模型或换投机方案都会变。config 可覆盖，查不到就 null。 */
      promptStateBytesPerToken: Number.isFinite(cfg.promptStateBytesPerToken)
        ? cfg.promptStateBytesPerToken
        : (modelKeyOf(cfg.model).startsWith('Qwen3.6-35B-A3B') ? PROMPT_STATE_B_PER_TOKEN : null),
      peaks: peaksOf(modelKeyOf(cfg.model)),
      /* 当前模型自己的用量与均速。lifetime 是跨模型的终身累计，
         凡是"这个模型跑多快"的展示位一律用这一份。 */
      model: modelUsageOf(modelKeyOf(cfg.model)),
      queue: {
        processing: metrics['llamacpp:requests_processing'] || 0,
        deferred: metrics['llamacpp:requests_deferred'] || 0,
      },
      totals: {
        promptTokens: metrics['llamacpp:prompt_tokens_total'] || 0,
        genTokens: metrics['llamacpp:tokens_predicted_total'] || 0,
        maxSeenTokens: metrics['llamacpp:n_tokens_max'] || 0,
        draftTokens: metrics['llamacpp:spec_decode_num_draft_tokens_total'] || 0,
        acceptedTokens: metrics['llamacpp:spec_decode_num_accepted_tokens_total'] || 0,
      },
      lifetime,
      rate: metricsDelta(metrics, 'llm'),
      /* 首 Token 延迟只对流式请求成立：非流式要等整段生成完才回第一个字节，
       * 那个数字等于总耗时。而 NewAPI / WeKnora 这类调用方默认走非流式，
       * 只报 TTFT 会让界面长期空着，所以总耗时的分位数另算一组，两组都给。 */
      requests: (() => {
        const recent = REQLOG.buf.slice(-60);
        const t = recent.filter((r) => r.ttftMs != null).map((r) => r.ttftMs);
        const done = recent.filter((r) => r.status >= 200 && r.status < 400 && r.totalMs != null);
        const tot = done.map((r) => r.totalMs);
        return {
          count: recent.length,
          streamCount: recent.filter((r) => r.stream).length,
          ttftP50: pct(t, 0.5), ttftP95: pct(t, 0.95), ttftLast: t.length ? t[t.length - 1] : null,
          totalP50: pct(tot, 0.5), totalP95: pct(tot, 0.95),
          totalLast: tot.length ? tot[tot.length - 1] : null,
          aborted: recent.filter((r) => r.status === 499).length,
          abortedTotal: LIFE.llm.aborted,   // 跨面板重启累计，与"累计用量"同口径
          failed: recent.filter((r) => r.status >= 500).length,
          last: recent.slice(-8).reverse().map((r) => ({
            at: r.at, model: r.model, stream: r.stream, status: r.status,
            ttftMs: r.ttftMs, totalMs: r.totalMs,
          })),
        };
      })(),
      // 向量服务单独一套：它只有编码没有生成，指标含义和对话服务不同。
      // 用量来自代理层的 EMBSTAT（llama-server 在 embedding 模式下不累加 token 计数器）。
      embedding: {
        up: !!eprops,
        model: eprops ? eprops.model_alias : null,
        nCtx: eprops && eprops.default_generation_settings ? eprops.default_generation_settings.n_ctx : null,
        totalSlots: eprops ? eprops.total_slots : null,
        promptCacheMiB: cfg.embeddingCacheRam ?? 0,
        usage: {
          since: EMBSTAT.since,
          count: EMBSTAT.count,
          failed: EMBSTAT.failed,
          tokens: EMBSTAT.tokens,
          seconds: EMBSTAT.ms / 1000,
          tps: EMBSTAT.ms > 0 ? (EMBSTAT.tokens / EMBSTAT.ms) * 1000 : null,
          avgMs: EMBSTAT.count > EMBSTAT.failed
            ? Math.round(EMBSTAT.ms / (EMBSTAT.count - EMBSTAT.failed)) : null,
          maxTokens: EMBSTAT.maxTokens,
        },
        rate: embedRate(),
        // 服务侧还能拿到的两个真实计数（其余在 embedding 模式下恒为 0）
        decodeCalls: eMetrics['llamacpp:n_decode_total'] || 0,
        processing: eMetrics['llamacpp:requests_processing'] || 0,
        deferred: eMetrics['llamacpp:requests_deferred'] || 0,
      },
    });
  }

  /* 配置回滚：参数改坏导致服务起不来时的唯一自救出口 */
  if (seg[1] === 'config' && seg[2] === 'rollback' && req.method === 'POST') {
    if (!fs.existsSync(CONFIG_BAK)) return sendJSON(res, 404, { error: '没有可回滚的上一版配置' });
    const prev = fs.readFileSync(CONFIG_BAK, 'utf8');
    try { JSON.parse(prev); } catch (e) { return sendJSON(res, 500, { error: '备份文件已损坏，无法回滚' }); }
    fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + '.rejected');
    fs.writeFileSync(CONFIG_PATH, prev, 'utf8');
    const r = await run('systemctl', ['restart', 'llm-server.service'], 120000);
    return sendJSON(res, 200, { rolledBack: true, restartCode: r.code, config: JSON.parse(prev) });
  }

  return sendJSON(res, 404, { error: 'no such api' });
}

/* Embedding 保持常驻。
 * 曾实现过按需加载+空闲卸载（能省 4 GiB），但冷启动首个请求要等 10~20 秒，
 * 影响服务响应，用户明确否决。这里只保留 /embed/* 的纯转发，不做任何启停。 */
const embedCfg = () => ({ port: loadConfig().embeddingPort || 8081 });

/* 把 llama-server 的内置 Web UI 和 API 从 /llm/ 前缀代理出去，
 * 这样只暴露面板一个端口就够用。 */
function proxyToLlama(req, res, url) {
  GUARD.lastProxyAt = Date.now();
  const cfg = loadConfig();
  const target = cfg.port || 8080;
  const rest = url.pathname.replace(/^\/llm/, '') || '/';
  const opts = {
    host: '127.0.0.1', port: target, method: req.method,
    path: rest + (url.search || ''),
    headers: Object.assign({}, req.headers, { host: '127.0.0.1:' + target }),
  };

  /* 聊天界面的 HTML 文档要注入中文覆盖层。llama.cpp 那个界面是打包好的
   * SvelteKit 单包，没有 i18n，改包内字符串风险太大（标识符和文案混在一起），
   * 所以在这里塞一个脚本进去，运行时按字典替换 DOM 文本。
   * 只处理 HTML 文档本身（几 KB），其余请求仍然是零拷贝管道转发。 */
  // 只有"看起来是 HTML 文档"的请求才走缓冲改写。带扩展名的静态资源照常
  // 管道转发——那个 bundle 有 8.8 MB，为了注入脚本而关掉它的压缩不划算。
  const bare = rest.split('?')[0];
  const looksLikeDoc = !/\.[a-z0-9]{2,6}$/i.test(bare);
  const wantZh = loadConfig().chatUiChinese !== false && req.method === 'GET' && looksLikeDoc;

  if (wantZh) {
    /* ⚠ 千万不要删 accept-encoding。llama.cpp 把 Web 界面以预压缩的 gzip 形式
     * 编进二进制，客户端不声明支持 gzip 它就直接回 415
     * "Error: gzip is not supported by this browser"（实测踩过，页面整个打不开）。
     * 所以这里反过来强制要 gzip，拿到之后自己解压、注入、明文发回去。 */
    opts.headers['accept-encoding'] = 'gzip';
    const p = http.request(opts);
    p.on('error', (e) => proxyError(res, target, e.message));
    p.on('response', (pr) => {
      const isHtml = /text\/html/i.test(pr.headers['content-type'] || '');
      if (!isHtml) { res.writeHead(pr.statusCode || 502, pr.headers); pr.pipe(res); return; }
      const chunks = [];
      pr.on('data', (c) => chunks.push(c));
      pr.on('end', () => {
        const raw = Buffer.concat(chunks);
        let html;
        try {
          html = (pr.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(raw) : raw).toString('utf8');
        } catch (e) {
          // 解压失败就原样放行：宁可不汉化，也不能给出乱码页面
          console.log('[chat-zh] 解压失败，放弃注入：' + e.message);
          res.writeHead(pr.statusCode || 200, pr.headers);
          return res.end(raw);
        }
        // 脚本名不能以 /llm 开头，否则会被上面那条 /llm 代理规则接走（踩过）
        const tag = '<script src="/chat-zh.js" defer></script>';
        html = html.includes('</head>') ? html.replace('</head>', tag + '</head>') : html + tag;
        const body = Buffer.from(html, 'utf8');
        const h = Object.assign({}, pr.headers, { 'content-length': String(body.length) });
        delete h['content-encoding'];   // 已经解压成明文了
        delete h['transfer-encoding'];
        res.writeHead(pr.statusCode || 200, h);
        res.end(body);
      });
    });
    res.on('close', () => { if (!p.destroyed) p.destroy(); });
    req.pipe(p);
    return;
  }

  const p = http.request(opts);
  bindUpstream(req, res, p, target);
  req.pipe(p);
}

/* ── OpenAI 兼容聚合入口 /v1/* ──────────────────────────────────
 * 为什么需要：Dify / Cherry Studio / OneAPI / LobeChat 这类客户端只允许填
 * 一个 base_url，并且默认 chat 和 embeddings 在同一地址下。板上是两个独立的
 * llama-server 进程（8080 对话 / 8081 向量），所以在这里按路径分发，对外
 * 表现成一个标准的 OpenAI 端点。原有的 /llm/* 和 /embed/* 保留不动——
 * 面板前端在用，也方便明确指定后端。 */
const EMBED_PATHS = /^\/v1\/(embeddings|rerank|reranking)$/;

/* /v1/models 要把两个后端的模型列表合起来，否则客户端只能看见一半。
 * llama.cpp 同时返回 ollama 风格的 models 和 OpenAI 风格的 data，两个都拼。 */
function fetchModels(port) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/v1/models', method: 'GET', timeout: 5000 }, (pr) => {
      let b = '';
      pr.on('data', (c) => { b += c; });
      pr.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } });
    });
    r.on('error', () => resolve(null));
    r.on('timeout', () => { r.destroy(); resolve(null); });
    r.end();
  });
}

async function mergedModels(res) {
  const cfg = loadConfig();
  const [a, b] = await Promise.all([
    fetchModels(cfg.port || 8080),
    fetchModels(cfg.embeddingPort || 8081),
  ]);
  // 任一服务没起来时不报错，返回活着的那部分，客户端至少能用一半
  const pick = (o, k) => (o && Array.isArray(o[k]) ? o[k] : []);
  // 给对话模型追加一个 -nothink 变体，客户端在模型下拉里就能选到，
  // 不需要额外的 base_url，也不需要它会传 chat_template_kwargs。
  const variant = (item, idKey) => {
    const c = JSON.parse(JSON.stringify(item));
    c[idKey] = item[idKey] + NOTHINK;
    if (c.aliases) c.aliases = [c[idKey]];
    if (c.model) c.model = c[idKey];
    return c;
  };
  const chatData = pick(a, 'data');
  const chatModels = pick(a, 'models');
  sendJSON(res, 200, {
    object: 'list',
    data: [...chatData, ...chatData.map((m) => variant(m, 'id')), ...pick(b, 'data')],
    models: [...chatModels, ...chatModels.map((m) => variant(m, 'name')), ...pick(b, 'models')],
  });
}

/* 后端不可达时必须返回 OpenAI 格式的 JSON 错误，不能返回纯文本。
 * 实测代价：llm-server 因权限问题挂掉的那几分钟，NewAPI 渠道测试只显示
 * "Invalid JSON response"——因为它拿到的是纯文本 502。真正的原因（后端没起来）
 * 完全看不出来，白查一轮。上游网关只认 JSON，错误也得是 JSON。 */
/* ★ 把"客户端断开"传播到上游，否则推理会白跑到底。
 * 实测：直连 8080 时客户端一断，llama.cpp 立刻释放 slot；经面板转发时却一直忙——
 * 因为代理到上游的那条连接还开着，llama.cpp 根本不知道下游走了。
 * parallel=1 只有一个 slot，一个白跑的任务会把后续请求全部堵死
 * （WeKnora 超时断开后板子仍 99% 满载、新请求排队卡住，就是这个原因）。 */
function bindUpstream(req, res, p, port) {
  let finished = false;
  p.on('response', (pr) => {
    res.writeHead(pr.statusCode || 502, pr.headers);
    pr.on('end', () => { finished = true; });
    pr.pipe(res);
  });
  p.on('error', (e) => proxyError(res, port, e.message));
  const cancel = () => {
    if (!finished && !p.destroyed) {
      p.destroy();
      console.log('[proxy] 客户端断开，已取消上游推理请求，释放 slot');
    }
  };
  res.on('close', cancel);
  req.on('aborted', cancel);
}

/* 生图界面反代。ComfyUI 是个 SPA，前端资源全走绝对路径，所以这里
 * 把 /comfy 前缀剥掉后原样转发，让它在子路径下也能取到 /assets、/api 等。
 * 进度推送走 WebSocket（/ws），单独在 upgrade 事件里处理。 */
/* 生图界面打不开时给操作者看的页面。
 * 两种情形文案不同，且都给出下一步动作——不写"请稍后重试"这种没有出路的话。
 * 正在启动时页面自己每 5 秒重载，用户不用手动刷。 */
function comfyUnavailablePage(starting) {
  const title = starting ? '生图界面正在启动' : '生图服务未启动';
  const desc = starting
    ? '模型正在载入内存，通常需要 30 秒到 1 分钟。载入完成后本页会自动打开生图界面。'
    : '当前不在生图模式。回到面板，在「运行模式」里选择生图模式，启动完成后再打开本页。';
  const action = starting
    ? '<p class="hint">这个页面每 5 秒自己重试一次，不用手动刷新。</p>'
    : '<p><a class="btn" href="/">回到面板</a></p>';
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + (starting ? '<meta http-equiv="refresh" content="5">' : '')
    + '<title>' + title + '</title><style>'
    + ':root{color-scheme:light dark;--fg:#1a1d21;--fg2:#5b6472;--bg:#f6f7f9;--card:#fff;--line:#e3e6ea;--accent:#2563eb}'
    + '@media (prefers-color-scheme:dark){:root{--fg:#e8eaed;--fg2:#9aa3af;--bg:#16181c;--card:#1e2126;--line:#2c3038;--accent:#60a5fa}}'
    + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
    + 'background:var(--bg);color:var(--fg);font:15px/1.7 system-ui,-apple-system,"Microsoft YaHei",sans-serif}'
    + '.box{max-width:30rem;padding:2rem 2.2rem;background:var(--card);border:1px solid var(--line);border-radius:12px}'
    + 'h1{margin:0 0 .6rem;font-size:1.15rem;font-weight:600}'
    + 'p{margin:.5rem 0;color:var(--fg2)}'
    + '.hint{font-size:13px}'
    + '.btn{display:inline-block;margin-top:.6rem;padding:.5rem 1.1rem;background:var(--accent);'
    + 'color:#fff;text-decoration:none;border-radius:7px;font-size:14px}'
    + '</style></head><body><div class="box">'
    + '<h1>' + title + '</h1><p>' + desc + '</p>' + action
    + '</div></body></html>';
}

/* 转发给 ComfyUI 时要重写的请求头。
 * ★ Origin 必须跟着 Host 一起改，否则 ComfyUI 判定跨站直接把连接挂死。
 *   现象极具迷惑性：HTTP 的 GET 全部 200（浏览器同源 GET 不带 Origin），
 *   唯独 WebSocket 超时——而浏览器发 WS 必带 Origin，于是真实访问 100% 卡在
 *   启动动画，用命令行怎么测都是通的（2026-08-14 实测定位，见 A-129）。
 *   POST /api/prompt 同理，浏览器也会带 Origin，不改连提交工作流都会失败。 */
function comfyHeaders(req) {
  const h = Object.assign({}, req.headers, { host: '127.0.0.1:' + COMFY_PORT });
  if (h.origin) h.origin = 'http://127.0.0.1:' + COMFY_PORT;
  if (h.referer) h.referer = h.referer.replace(/^https?:\/\/[^/]+\/comfy/, 'http://127.0.0.1:' + COMFY_PORT);
  return h;
}

function proxyToComfy(req, res, url) {
  const rest = url.pathname.replace(/^\/comfy/, '') || '/';
  const path_ = rest + (url.search || '');
  const p = http.request({
    host: '127.0.0.1', port: COMFY_PORT, method: req.method, path: path_,
    headers: comfyHeaders(req),
  });
  p.on('response', (pr) => {
    const h = Object.assign({}, pr.headers);
    /* 让浏览器把相对跳转也留在 /comfy 下 */
    if (h.location && h.location.startsWith('/') && !h.location.startsWith('/comfy')) {
      h.location = '/comfy' + h.location;
    }
    res.writeHead(pr.statusCode || 502, h);
    pr.pipe(res);
  });
  /* 错误页按真实状态分支。
   * 旧版一律说"请切换到生图模式"，而最常见的情形恰恰是用户已经切了、只是还在加载——
   * 那句话会让人反复去点已经点过的按钮。原始错误（connect ECONNREFUSED 127.0.0.1:8188）
   * 也不该给用户看：内部地址与端口对操作者没有任何用处。 */
  p.on('error', async () => {
    if (res.headersSent) return res.end();
    let starting = false;
    try {
      const st = await unitState('comfyui');
      starting = st.active === 'active';       // 进程在，只是还没监听端口
    } catch (e) { /* 查不到就按"未启动"讲 */ }
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '10' });
    res.end(comfyUnavailablePage(starting));
  });
  const cancel = () => { if (!p.destroyed) p.destroy(); };
  res.on('close', cancel);
  req.on('aborted', cancel);
  req.pipe(p);
}

function proxyError(res, port, msg) {
  const body = JSON.stringify({
    error: {
      /* message 会被网关原样显示给最终用户，所以只讲发生了什么、该做什么。
       * 内部端口与运维命令挪到 upstream 字段——排查的人看得到，用的人不必看。 */
      message: (port === 8081 ? '向量服务当前不可用' : '对话模型当前不可用')
        + '：服务可能正在加载，或设备已切换到生图/车机模式。请在设备面板确认运行模式后重试。',
      type: 'upstream_unavailable',
      code: 'upstream_unavailable',
      param: null,
      upstream: { port, reason: msg },
    },
  });
  if (!res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  }
  res.end(body);
}

/* 「不思考」变体走模型名后缀，而不是另开一条路径。
 * 客户端只认模型名：base_url 还是那一个，/v1/models 里多出一个 -nothink 条目，
 * NewAPI 同步模型列表时自动带上，WeKnora 这类调用方在下拉里选中即可。
 *
 * 为什么需要它：RAG / ReAct 每一步都思考会把延迟成倍放大（实测 13.2s vs 1.5s，
 * WeKnora 因此 context deadline exceeded），而同一台板子上 Cherry Studio 又要思考链。
 * 服务端设全局默认会让客户端的思考开关彻底失效，所以做成两个模型让调用方自己选。 */
const NOTHINK = '-nothink';

/* 最近若干次对话请求的时延。首 Token 延迟只能在这一层量：
 * llama.cpp 的 /metrics 里没有 TTFT，而这里正好握着"请求发出去"和
 * "第一个字节回来"两个时刻。只对流式请求有意义——非流式要等生成完才回第一个字节，
 * 那个数字等于总耗时，当 TTFT 看会误导。 */
const REQLOG = { cap: 120, buf: [] };

/* ★★ 对话请求的三道闸（2026-08-21 加，事故复盘的直接产物）
 *
 * 此前这一层一道拦截都没有：无并发上限、无请求超时、无请求体大小上限，
 * 全靠调用方自律。2026-08-21 傍晚因此打出一次拥塞崩溃，过程记在陷阱 68。
 *
 * 一、并发上限。板子是 --parallel 1，单 slot 串行；llama.cpp 对超出 slot 的请求
 *   既不返回 429 也不拒绝，而是**无限期排队**。事故当天的铁证：NewAPI 日志里
 *   9 条请求的发起时间横跨 18:52~19:27 共 35 分钟，一条都没被处理，直到板子重启
 *   才一起返回 502；同期成功的请求 use_time 到了 1860 秒（31 分钟）。
 *   队列深度 N 的队尾最坏等待 =（N-1）× 单条服务时间（实测中位数 158 秒）。
 *   取 3 → 队尾最坏等 316 秒，调用方超时配到 420 秒以上就能覆盖。
 *   超出直接 429 + Retry-After，让调用方退避重试——**快速失败优于长时间等待**，
 *   这是这次最贵的一条教训：排队会让调用方超时，而超时不关连接的话请求还在队里，
 *   于是重试又往队里加，队列只增不减。
 *
 * 二、请求超时。用 socket 空闲超时实现：非流式请求整个生成期间 socket 是静默的，
 *   所以空闲超时等于总时长；流式每个 token 都有数据，不会被误伤。
 *   900 秒是按下面这条算出来的——服务端 --predict 16384，最长输出
 *   16384 ÷ 25 t/s = 655 秒，加最坏 prefill（128K ÷ 700 tok/s = 187 秒）= 842 秒。
 *   ⚠ 改 --predict 就要重算这个数，两者是配套的。不设 --predict 时理论最长
 *   是 131000 ÷ 25 ≈ 87 分钟，那样超时就形同虚设了。
 *
 * 三、请求体大小。纯文本吃满 128K 上下文也只有约 0.6 MB
 *   （实测 3900 token 对应 5639 个中文字，约 4.3 字节/token）。
 *   60 MB 这个数是**给多模态留的**：一张 1024² 图 base64 后约 1.4 MB，
 *   板子挂着 mmproj，多图请求是真实场景。按文本算它是 100 倍虚高，按图片算才合理。
 *   最坏内存 3 × 60 MB = 180 MB（Buffer.concat 期间峰值翻倍到 360 MB），
 *   板子可用内存 2.7 GB 量级，扛得住。 */
const CHAT_GATE = { max: 3, cur: 0 };
const CHAT_TIMEOUT_MS = 900 * 1000;
const MAX_BODY_BYTES = 60 * 1024 * 1024;

function recordRequest(rec) {
  REQLOG.buf.push(rec);
  if (REQLOG.buf.length > REQLOG.cap) REQLOG.buf.splice(0, REQLOG.buf.length - REQLOG.cap);
  /* 分母口径：所有转发出去的对话请求都算，含被中断的。
   * 因为分子（llama-server 的累计 Prefill 秒数）同样包含中断请求已经消耗掉的时间，
   * 只数成功的会让平均值虚高。 */
  LIFE.llm.requests += 1;
  if (rec.status === 499) LIFE.llm.aborted += 1;
  statsDirty = true;
}
function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
}

/* Embedding 的用量只能在这一层统计。
 * 实测：即使 llama-server 带了 --metrics，embedding 模式下
 * llamacpp:prompt_tokens_total 与 prompt_seconds_total 恒为 0——那两个计数器只在
 * 生成路径累加，编码请求不经过。/metrics 上唯一会动的是 n_decode_total 和 n_tokens_max。
 * 而 OpenAI 兼容响应体开头就带 "usage":{"prompt_tokens":N}（实测在第 48 字节），
 * 于是在转发时嗅探响应的前 512 字节把它取出来，自己累加。 */
/* 累计量从 panel-stats.json 恢复，面板重启后接着往上加；recent 只在内存里（算近期速度用）。 */
const EMBSTAT = {
  since: LIFE.embed.since,
  tokens: LIFE.embed.tokens, ms: LIFE.embed.ms,
  count: LIFE.embed.count, failed: LIFE.embed.failed, maxTokens: LIFE.embed.maxTokens,
  cap: 60, recent: [],   // 最近若干次 { at, tokens, ms }
};
function syncEmbedStats() {
  LIFE.embed.tokens = EMBSTAT.tokens;
  LIFE.embed.ms = EMBSTAT.ms;
  LIFE.embed.count = EMBSTAT.count;
  LIFE.embed.failed = EMBSTAT.failed;
  LIFE.embed.maxTokens = EMBSTAT.maxTokens;
  LIFE.embed.since = EMBSTAT.since;
  statsDirty = true;
}
function recordEmbed(rec) {
  EMBSTAT.count += 1;
  if (rec.failed) { EMBSTAT.failed += 1; syncEmbedStats(); return; }
  EMBSTAT.tokens += rec.tokens;
  EMBSTAT.ms += rec.ms;
  if (rec.tokens > EMBSTAT.maxTokens) EMBSTAT.maxTokens = rec.tokens;
  EMBSTAT.recent.push(rec);
  if (EMBSTAT.recent.length > EMBSTAT.cap) EMBSTAT.recent.splice(0, EMBSTAT.recent.length - EMBSTAT.cap);
  syncEmbedStats();
}
/* 最近 windowMs 内的编码速度。样本不足就退回终身平均，避免界面长时间空着 */
function embedRate(windowMs = 120000) {
  const now = Date.now();
  const w = EMBSTAT.recent.filter((r) => now - r.at <= windowMs);
  const sum = (a, k) => a.reduce((x, y) => x + y[k], 0);
  const tok = sum(w, 'tokens'), ms = sum(w, 'ms');
  return {
    windowSec: Math.round(windowMs / 1000),
    count: w.length,
    tokens: tok,
    tps: ms > 0 ? (tok / ms) * 1000 : null,
    avgMs: w.length ? Math.round(ms / w.length) : null,
    lastAt: EMBSTAT.recent.length ? EMBSTAT.recent[EMBSTAT.recent.length - 1].at : null,
  };
}

function proxyWithBody(req, res, port, path_) {
  GUARD.lastProxyAt = Date.now();

  /* 闸一：并发。满了立刻回 429，不排队。
   * Retry-After 按队尾最坏等待给，调用方照着退避就不会再撞上。 */
  if (CHAT_GATE.cur >= CHAT_GATE.max) {
    const body = JSON.stringify({
      error: {
        message: `IECU 面板：推理请求并发已达上限 ${CHAT_GATE.max}，请稍后重试。`
          + '板子是单槽串行，继续排队只会让所有请求一起变慢。',
        type: 'rate_limit_exceeded', code: 'rate_limit_exceeded', param: null,
      },
    });
    res.writeHead(429, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Retry-After': '160',
    });
    recordRequest({ at: Date.now(), path: path_.split('?')[0], model: '', stream: false, status: 429, ttftMs: null, totalMs: 0 });
    return res.end(body);
  }
  CHAT_GATE.cur += 1;
  let released = false;
  const release = () => { if (!released) { released = true; CHAT_GATE.cur -= 1; } };
  res.on('close', release);   // 无论正常结束还是断开，名额都要还回去

  /* 闸三：请求体大小。边收边计，超了立刻断，不等收完——
   * 否则"限制大小"这件事本身就要先把超大的body整个吃进内存。 */
  const chunks = [];
  let bodyBytes = 0, oversized = false;
  req.on('data', (c) => {
    if (oversized) return;
    bodyBytes += c.length;
    if (bodyBytes > MAX_BODY_BYTES) {
      oversized = true;
      const body = JSON.stringify({
        error: {
          message: `IECU 面板：请求体超过 ${Math.round(MAX_BODY_BYTES / 1048576)} MB 上限。`,
          type: 'invalid_request_error', code: 'payload_too_large', param: null,
        },
      });
      /* Connection: close 不能省。这里必须 destroy 掉请求（否则"限制大小"这件事
       * 本身还是要先把超大 body 读完），而直接 destroy 会让复用同一条 keep-alive
       * 连接的下一个请求收到 ECONNRESET——实测就是这样，413 之后紧接着的
       * /api/runtime 直接 reset。声明关闭连接，调用方就知道要另起一条。 */
      res.writeHead(413, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        Connection: 'close',
      });
      res.end(body);
      release();
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (oversized) return;
    let body = Buffer.concat(chunks);
    let stream = false, model = '';
    try {
      const o = JSON.parse(body.toString('utf8'));
      if (o && typeof o === 'object') {
        stream = o.stream === true;
        model = typeof o.model === 'string' ? o.model : '';
        if (typeof o.model === 'string' && o.model.endsWith(NOTHINK)) {
          o.model = o.model.slice(0, -NOTHINK.length);   // 还原成 llama-server 认识的真名
          o.chat_template_kwargs = Object.assign({}, o.chat_template_kwargs, { enable_thinking: false });
          // 官方推荐采样按模式分档：服务端默认值是思考档（temp 1.0/top_p 0.95），
          // 非思考档是 temp 0.7/top_p 0.8。客户端显式传了就尊重客户端。
          if (o.temperature === undefined) o.temperature = 0.7;
          if (o.top_p === undefined) o.top_p = 0.8;
          body = Buffer.from(JSON.stringify(o), 'utf8');
        }
      }
    } catch (e) { /* 不是 JSON 就原样转发 */ }
    const headers = Object.assign({}, req.headers, {
      host: '127.0.0.1:' + port,
      'content-length': String(body.length),
    });
    delete headers['transfer-encoding'];
    const p = http.request({ host: '127.0.0.1', port, method: req.method, path: path_, headers });

    /* 闸二：超时。setTimeout 是 socket 空闲超时，不是总时长——
     * 非流式整个生成期间 socket 静默，空闲超时正好等于总时长；
     * 流式每个 token 都有数据流动，不会被误伤。这个语义差别是选它的原因。 */
    p.setTimeout(CHAT_TIMEOUT_MS, () => {
      console.log(`[proxy] 上游 ${CHAT_TIMEOUT_MS / 1000} 秒无响应，主动断开并释放 slot`);
      p.destroy(new Error(`上游超过 ${CHAT_TIMEOUT_MS / 1000} 秒无响应`));
    });

    const t0 = Date.now();
    let ttft = null;
    /* 每个请求只记一笔。此前用 "ttft === null" 当作"还没开始回数据"的判据，
     * 结果流式请求一旦吐出第一个字节 ttft 就非空，之后客户端断开便不再记 499——
     * 长 prompt 被客户端超时掐断（llama-server 日志里的 "cancel task"）在面板上
     * 完全看不到。判据改成"这一笔记过没有 + 响应是否正常结束"。 */
    let logged = false;
    const logOnce = (rec) => { if (!logged) { logged = true; recordRequest(rec); } };
    p.on('response', (pr) => {
      pr.once('data', () => { ttft = Date.now() - t0; });
      pr.on('end', () => logOnce({
        at: t0, path: path_.split('?')[0], model, stream,
        status: pr.statusCode, ttftMs: stream ? ttft : null, totalMs: Date.now() - t0,
      }));
    });
    // 客户端中途断开也要记一笔，否则统计里看不到"白跑的请求"
    res.on('close', () => {
      if (!res.writableEnded) {
        logOnce({
          at: t0, path: path_.split('?')[0], model, stream, status: 499,
          ttftMs: stream ? ttft : null, totalMs: Date.now() - t0,
        });
      }
    });

    bindUpstream(req, res, p, port);
    p.end(body);
  });
  req.on('error', () => proxyError(res, port, '读取请求体失败'));
}

function proxyTo(req, res, port, path_) {
  GUARD.lastProxyAt = Date.now();   // 供内存守护判断"是否有任务在进行"
  const p = http.request({
    host: '127.0.0.1', port, method: req.method, path: path_,
    headers: Object.assign({}, req.headers, { host: '127.0.0.1:' + port }),
  });
  bindUpstream(req, res, p, port);
  req.pipe(p);
}

/* 编码请求：转发的同时嗅探响应头部，取出 usage.prompt_tokens。
 * 只留前 512 字节——一条 1024 维向量的响应体有 20 KB 以上，整段缓存没必要。 */
function proxyEmbed(req, res, port, path_) {
  GUARD.lastProxyAt = Date.now();
  const t0 = Date.now();
  const p = http.request({
    host: '127.0.0.1', port, method: req.method, path: path_,
    headers: Object.assign({}, req.headers, { host: '127.0.0.1:' + port }),
  });
  p.on('response', (pr) => {
    let head = '', done = false;
    pr.on('data', (d) => { if (head.length < 512) head += d.toString('utf8', 0, Math.min(d.length, 512)); });
    pr.on('end', () => {
      if (done) return;
      done = true;
      const ok = pr.statusCode >= 200 && pr.statusCode < 300;
      const m = head.match(/"prompt_tokens"\s*:\s*(\d+)/);
      recordEmbed({ at: t0, ms: Date.now() - t0, tokens: m ? +m[1] : 0, failed: !ok || !m });
    });
  });
  bindUpstream(req, res, p, port);
  req.pipe(p);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    const external = isFromInternet(req);
    const dataPlane = url.pathname.startsWith('/v1/') || url.pathname.startsWith('/embed');

    /* 数据面：公网侧直接拒绝，连登录都不给试。
     * 这样即使反代配错、把 /v1 也转发进来了，模型仍然不会对公网开放。 */
    if (dataPlane && external) {
      const body = JSON.stringify({
        error: {
          message: 'IECU 面板：模型接口 /v1 与 /embed 仅在局域网内开放。公网调用请通过 NewAPI 网关。',
          type: 'lan_only', code: 'lan_only', param: null,
        },
      });
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
      return res.end(body);
    }

    /* 控制面与调试面：公网必须登录。局域网保持免登录——现有的使用习惯不变，
     * 也避免 requireLoginOnLan 默认打开后自己被关在外面。 */
    if (!dataPlane) {
      const cfg = loadConfig();
      const needAuth = external || cfg.requireLoginOnLan === true;
      const open = url.pathname === '/login.html' || url.pathname === '/api/auth/login'
        || url.pathname === '/api/auth/state';
      if (needAuth && !open && !currentSession(req)) {
        if (url.pathname.startsWith('/api/')) return sendJSON(res, 401, { error: 'unauthorized', login: '/login.html' });
        res.writeHead(302, { Location: '/login.html', 'Cache-Control': 'no-store' });
        return res.end();
      }
      /* 写操作要求自定义头，浏览器跨站表单无法伪造（SameSite=Strict 之外的第二道） */
      if (req.method !== 'GET' && req.method !== 'HEAD'
        && url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/auth/')
        && req.headers['x-panel-request'] !== '1') {
        return sendJSON(res, 400, { error: 'missing X-Panel-Request header' });
      }
    }

    if (url.pathname.startsWith('/api/auth/')) return await handleAuth(req, res, url, external);

    // 聚合入口：一个 base_url 同时提供对话与向量
    if (url.pathname.startsWith('/v1/')) {
      if (url.pathname === '/v1/models') return await mergedModels(res);
      const cfg = loadConfig();
      const isEmbed = EMBED_PATHS.test(url.pathname);
      const port = isEmbed ? (cfg.embeddingPort || 8081) : (cfg.port || 8080);
      const path_ = url.pathname + (url.search || '');
      // 对话类请求要看 model 名决定是否关思考，得先读请求体；向量类只嗅探响应头部取用量
      return isEmbed ? proxyEmbed(req, res, port, path_) : proxyWithBody(req, res, port, path_);
    }
    /* 生图界面：ComfyUI 自己没有任何鉴权，绝不能直接对外暴露 8188。
     * 统一从面板 9000 进来，走完上面那道登录判断后才转发到本机 8188。
     * 前端资源引用的是相对路径（./assets/...），子路径下能正常取到。
     *
     * ★ 尾斜杠不能少，少了整个界面会卡在启动动画（2026-08-14 实测定位）。
     * ComfyUI 前端这样推导 API 基址：
     *     api_base = location.pathname.split('/').slice(0,-1).join('/')
     *   /comfy/  → ['','comfy','']  → 去掉末项 → '/comfy'   ✓ 请求 /comfy/api/...
     *   /comfy   → ['','comfy']     → 去掉末项 → ''         ✗ 请求 /api/...
     * 后者会打到面板自己的控制面上，全部 404，前端一直等接口、界面永远不出来。
     * 所以这里必须 301 到带斜杠的地址，不能图省事直接转发。 */
    if (url.pathname === '/comfy') {
      res.writeHead(301, { Location: '/comfy/' + (url.search || '') });
      return res.end();
    }
    if (url.pathname.startsWith('/comfy/')) {
      return proxyToComfy(req, res, url);
    }
    if (url.pathname.startsWith('/llm')) return proxyToLlama(req, res, url);
    // Embedding 统一入口：http://<ip>:9000/embed/v1/embeddings（服务常驻，纯转发）
    if (url.pathname.startsWith('/embed')) {
      GUARD.lastProxyAt = Date.now();   // RAG 场景先查向量再调 LLM，这也算任务进行中
      const { port } = embedCfg();
      const rest = url.pathname.replace(/^\/embed/, '') || '/';
      const path_ = rest + (url.search || '');
      // 这条老路径同样计入用量，否则统计会因为调用方选了哪个入口而漂移
      if (EMBED_PATHS.test(rest)) return proxyEmbed(req, res, port, path_);
      const p = http.request({
        host: '127.0.0.1', port, method: req.method, path: path_,
        headers: Object.assign({}, req.headers, { host: '127.0.0.1:' + port }),
      });
      bindUpstream(req, res, p, port);
      return req.pipe(p);
    }
    if (url.pathname.startsWith('/api/')) return await handleAPI(req, res, url);

    const file = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
    const fp = path.join(ROOT, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
    if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404');
    }
    const ext = path.extname(fp);
    const ct = {
      '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png',
      '.woff2': 'font/woff2', '.map': 'application/json; charset=utf-8',
    }[ext] || 'application/octet-stream';
    const b = fs.readFileSync(fp);
    // 构建产物带内容哈希，可以长缓存；HTML 必须每次取新的
    const cache = /^\/assets\//.test(url.pathname) ? 'public, max-age=31536000, immutable' : 'no-store';
    res.writeHead(200, { 'Content-Type': ct, 'Content-Length': b.length, 'Cache-Control': cache });
    res.end(b);
  } catch (e) {
    if (!res.headersSent) sendJSON(res, 500, { error: String(e && e.message || e) });
    else try { res.end(); } catch (x) {}
  }
});

/* ── 内存水位守护 ──────────────────────────────────────────────
 * 历史更正：曾判定 llama-server "每请求泄漏 123 MB"，做了四组对照实验都无果，
 * 最后查 --help 才发现是 --cache-ram 默认 8192 MiB 的 prompt cache 池在正常
 * 填充，不是泄漏。config.json 已设 cacheRamMiB=512，内存不会再无限涨。
 * 这个守护因此降级为纯兜底，不是主要防线——别再按"修泄漏"的思路改它。
 *
 * 策略：available 低于阈值时重启 llm-server。但要避开正在生成的请求——
 * 通过 /slots 判断是否 idle，忙则推迟，直到降到硬阈值才强制重启。
 */
const GUARD = {
  enabled: true,
  // 阈值一路下调的历史，每次都是它自己造成故障：
  //   4.0 GiB → embedding 启动的正常波动就误触发，还污染了一次内存测量
  //   1.8 GiB → WeKnora 的 RAG+ReAct 跑到一半被重启，任务超时失败
  // 现在内存有确定上界（KV 按 ctx 启动时预分配、cacheRamMiB 封顶 1024，
  // 实测撑满后可用内存稳定在 1.5~1.6 GiB），
  // 「无限增长」这个前提根本不存在，守护只该防真正的 OOM 死机。
  // 板子没有远程上电手段，系统真卡死只能物理断电，所以保留一道很低的底线。
  softGiB: 0.35,
  hardGiB: 0.2,
  minIntervalMs: 10 * 60 * 1000,
  // 服务刚起来时内存尚在铺开（模型加载、KV 预分配），此窗口内不干预
  graceAfterStartMs: 5 * 60 * 1000,
  // 必须连续 N 次采样都低于阈值才动手，避免瞬时抖动误触发
  consecutiveNeeded: 3,
  // ★ /slots 显示空闲 ≠ 任务结束。ReAct / RAG 是多轮调用，轮次之间必然有间隙，
  //   那一刻 slot 就是 idle 的——按它重启会把整条链打断（实测发生过）。
  //   所以再加一条：距离最后一次经面板的推理请求不足这个时间，一律不动。
  quietAfterRequestMs: 5 * 60 * 1000,
  lastProxyAt: 0,
  lowStreak: 0,
  lastRestart: 0,
  restarts: 0,
  lastReason: '',
};
async function serverIdle() {
  return new Promise((res) => {
    const cfg = loadConfig();
    const req = http.request({ host: '127.0.0.1', port: cfg.port || 8080, path: '/slots', method: 'GET', timeout: 5000 }, (r) => {
      let b = ''; r.on('data', (c) => b += c);
      r.on('end', () => {
        try { const j = JSON.parse(b); res(Array.isArray(j) && j.every((s) => !s.is_processing)); }
        catch (e) { res(false); }
      });
    });
    req.on('error', () => res(false));
    req.on('timeout', () => { req.destroy(); res(false); });
    req.end();
  });
}
async function memoryGuard() {
  if (!GUARD.enabled) return;
  const st = await unitState('llm-server');
  if (st.active !== 'active') { GUARD.lowStreak = 0; return; }

  const m = memInfo();
  const availGiB = m.availKB / 1048576;
  if (availGiB >= GUARD.softGiB) { GUARD.lowStreak = 0; return; }

  // 刚启动的宽限期：模型加载 + KV 预分配期间内存本来就会探底
  const startedAt = st.since ? Date.parse(st.since) : 0;
  if (startedAt && Date.now() - startedAt < GUARD.graceAfterStartMs) {
    GUARD.lowStreak = 0;
    return;
  }
  if (Date.now() - GUARD.lastRestart < GUARD.minIntervalMs) return;

  GUARD.lowStreak++;
  const hard = availGiB < GUARD.hardGiB;
  if (!hard && GUARD.lowStreak < GUARD.consecutiveNeeded) return;   // 需连续多次确认

  const idle = await serverIdle();
  if (!hard && !idle) return;   // 软阈值下正在生成 → 等它做完

  // 多轮任务（ReAct/RAG）在轮次间隙看起来是空闲的。最近有过请求就绝不重启，
  // 哪怕此刻 slot 空着——宁可让内存贴着底线跑，也不要把用户的链路打断。
  const sinceReq = Date.now() - GUARD.lastProxyAt;
  if (!hard && GUARD.lastProxyAt && sinceReq < GUARD.quietAfterRequestMs) {
    console.log(`[memory-guard] available 低但 ${Math.round(sinceReq / 1000)}s 前还有请求，判定任务进行中，不重启`);
    return;
  }

  GUARD.lastRestart = Date.now();
  GUARD.restarts++;
  GUARD.lowStreak = 0;
  GUARD.lastReason = `available ${availGiB.toFixed(2)} GiB < ${hard ? 'hard' : 'soft'} 阈值，${idle ? '空闲' : '强制'}重启`;
  console.log('[memory-guard] ' + GUARD.lastReason);
  await run('systemctl', ['restart', 'llm-server.service'], 180000);
}
setInterval(() => { memoryGuard().catch((e) => console.log('[memory-guard] ' + e.message)); }, 20000);

startTegrastats();
// 历史采样。第一针延后 5 秒，等 tegrastats 先出数
setTimeout(() => {
  sampleHistory().catch(() => {});
  setInterval(() => { sampleHistory().catch((e) => console.log('[history] ' + e.message)); }, HIST.stepMs);
}, 5000);
/* 累计用量落盘：2 分钟一次 + 正常退出时补一次。面板被 OOM 杀掉（SIGKILL）时
 * 收不到信号，最多丢 2 分钟的量，所以周期写盘不能省。 */
setInterval(saveStats, 120000);
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { saveStats(); process.exit(0); });
}
/* WebSocket 转发。ComfyUI 的执行进度、队列状态、预览图全走 /ws，
 * 没有它界面就只能看到"已提交"然后一直转圈。
 * 这里手工转发 upgrade 握手并对接两个 socket——面板本身零依赖，
 * 不引 ws 库；升级后的连接是纯字节流，双向 pipe 即可。 */
server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://x');
  if (!(u.pathname === '/comfy/ws' || u.pathname.startsWith('/comfy/'))) {
    return socket.destroy();
  }
  /* 与 HTTP 侧同一道门：公网必须先登录，否则连 WebSocket 也不给 */
  const external = !!req.headers['x-forwarded-for'];
  const cfg = loadConfig();
  const needAuth = external || cfg.requireLoginOnLan === true;
  if (needAuth && !currentSession(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }

  const rest = u.pathname.replace(/^\/comfy/, '') || '/';
  const up = http.request({
    host: '127.0.0.1', port: COMFY_PORT, method: req.method,
    path: rest + (u.search || ''),
    headers: comfyHeaders(req),
  });
  /* 上游没升级成 WebSocket 时必须回一句、断掉。
   * 缺这个分支的后果是 socket 永久挂着——浏览器侧表现为"一直在连"，
   * 既没有报错也没有超时，界面停在启动动画上，看不出任何线索。 */
  up.on('response', (ures) => {
    socket.write('HTTP/1.1 ' + (ures.statusCode || 502) + ' Upgrade Failed\r\n\r\n');
    ures.resume();
    socket.destroy();
  });
  up.on('upgrade', (ures, usocket, uhead) => {
    const lines = ['HTTP/1.1 101 Switching Protocols'];
    for (const [k, v] of Object.entries(ures.headers)) lines.push(k + ': ' + v);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (uhead && uhead.length) socket.write(uhead);
    usocket.pipe(socket);
    socket.pipe(usocket);
    const kill = () => { usocket.destroy(); socket.destroy(); };
    usocket.on('error', kill); socket.on('error', kill);
    usocket.on('close', () => socket.destroy());
    socket.on('close', () => usocket.destroy());
  });
  up.on('error', () => socket.destroy());
  up.end(head && head.length ? head : undefined);
});

server.listen(PORT, '0.0.0.0', () => {
  const cfg = loadConfig();
  console.log('[iecu-panel] listening on 0.0.0.0:' + PORT
    + '  局域网=' + (cfg.requireLoginOnLan === true ? '要求登录' : '免登录')
    + '  公网=' + (loadAuth() ? '要求登录' : '密码未设置，公网将无法进入')
    + '  /v1 与 /embed 仅限局域网');
  console.log(`[memory-guard] 已启用：available < ${GUARD.softGiB} GiB 且空闲且 ${GUARD.quietAfterRequestMs / 60000} 分钟内无请求 → 重启；< ${GUARD.hardGiB} GiB → 强制重启（防 OOM 死机的最后底线）`);
});
