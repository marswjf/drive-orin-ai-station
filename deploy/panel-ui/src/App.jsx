import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from './api';
import {
  Card, CardTitle, Big, Meta, Bar, Status, Tag, StatGrid, KV, Btn, Field, Banner, ConfirmDialog,
  GiB, fromKB, fmt, int, ctxK, tokK, ms, inputCls, inputStyle,
} from './ui';
import { TimeChart, ratesFrom, seriesFrom } from './chart';
import { translateLog } from './logtext';

/* 界面上不出现 systemd 的 unit 名。车机软件不列在服务里——它和推理服务互斥，
   归「运行模式」管；两个地方都能启停会让状态互相打架。 */
const SERVICES = [
  ['llm-server', '推理服务', 'OpenAI 兼容对话接口'],
  ['llm-embedding', 'Embedding 服务', '知识库检索向量接口'],
];

const CHARS_PER_TOKEN = 0.7;

/* 界面上给人看的模型名，不是文件名。文件名放进说明里，需要时才看。
 * 生图卡片的大字位置容不下 "z_image_turbo-Q8_0" 这种长度——原样放上去会把
 * 卡片撑变形（2026-08-15 实际发生过），所以统一走这个函数缩短。 */
const prettyName = (n) => {
  if (!n) return '';
  const base = String(n).replace(/\.(safetensors|ckpt|gguf|sft|pth)$/i, '');
  const zi = base.match(/^z[_-]?image.*?[-_](q\d+[_a-z0-9]*|bf16|fp16|fp8)$/i);
  if (zi) return 'Z-Image ' + zi[1].toUpperCase();
  if (/^z[_-]?image/i.test(base)) return 'Z-Image';
  if (/^qwen[_-]?image/i.test(base)) return 'Qwen-Image';
  if (/^flux/i.test(base)) return 'FLUX';
  if (/^sd_xl_base/i.test(base)) return 'SDXL 1.0';
  if (/^v1-5-pruned/i.test(base)) return 'SD 1.5';
  if (/^seedvr2/i.test(base)) return 'SeedVR2';
  return base.length > 16 ? base.slice(0, 15) + '…' : base;
};

/* ★ 这里原来有个 KV_BYTES_PER_TOKEN 常量（18 KB/token），2026-08-19 删掉了。
   那个数是对 Qwen3.6-35B-A3B 实测的，被当成全局兜底用；换到 Qwen3.8-27B
   （SSM 与全注意力混合，65 层里只有约 16 层有 KV）之后它不再成立，
   而"兜底"这个写法会让错的数字看起来像对的。
   现在一律以服务端 rt.kvBytesPerToken 为准，服务端查不到实测值就返回 null，
   界面显示"—"。缺数据时宁可空着，不要拿另一个模型的系数替它算。 */

/* 术语说明集中放，保证同一个概念在界面各处的解释一致。
 *
 * 写法只有三条，改文案前先看一遍：
 *   1. 只回答"这个数字是什么、按什么口径算的、阈值是多少"。
 *      不写为什么这样设计，不写建议，不写主观评价——那些属于代码注释和文档。
 *   2. 术语按行业写法：tokens / Prefill / TTFT / KV 缓存 / Embedding，不自造中文词。
 *   3. 陈述句，主谓宾完整。不用口语词，不用"多半""通常"这类推测措辞。
 */
const T = {
  prefill: 'Prefill：模型读入输入内容的阶段，先于生成。此处为该阶段每秒处理的 token 数，按累计 token 除以累计耗时计算。图像走 CPU 编码的时间、以及请求被取消前已消耗的时间都计入分母，因此该值低于单次纯文本请求的实测速度。',
  decode: '生成阶段每秒输出的 token 数。',
  ttft: '首 Token 延迟（TTFT）：从请求发出到收到第一个 token 的时间，含排队与 Prefill。仅流式请求可测量。',
  ctx: '上下文：单次会话可容纳的 token 总量。KV 缓存在服务启动时按此上限一次性预分配。',
  kv: 'KV 缓存：已处理 token 的中间状态，占用量与 token 数成正比。',
  cacheHit: '本次输入中无需重新计算、直接复用已有状态的 token 占比。',
  queue: '等待处理的请求数。当前为单处理位，并发请求依次执行。',
  slot: '可同时处理的请求数。上下文容量在各处理位之间平分。',
  unifiedMem: '处理器与 GPU 共用同一份物理内存，无独立显存。',
  realMem: 'GPU 映射内存与进程常驻内存之和。',
  avail: '当前仍可分配给新进程的内存。',
  tj: '结温：芯片内部温度，降频保护阈值 105°C。',
  gpu: 'GPU 处于工作状态的时间占比。等待内存返回数据的时间同样计入，因此高占用不代表算力饱和。',
  guard: '剩余内存低于 0.35 GB 并连续三次确认后，推理服务自动重启。',
  embTps: '每秒编码的 token 数。仅统计经面板转发的请求。',
  embLatency: '单次请求从发出到收到向量的耗时，含排队。',
  totalP95: '最近 60 次请求中 95% 的总耗时低于此值。总耗时含排队、Prefill 与生成。',
};

const levelOfAvail = (g) => (g < 0.5 ? 'bad' : g < 1.5 ? 'warn' : 'ok');
const levelOfTemp = (t) => (t >= 92 ? 'bad' : t >= 80 ? 'warn' : 'ok');
const levelOfPct = (p) => (p >= 92 ? 'bad' : p >= 80 ? 'warn' : 'ok');

export default function App() {
  const [st, setSt] = useState(null);
  const [rt, setRt] = useState(null);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [detail, setDetail] = useState('');
  const [tab, setTab] = useState('charts');     // 日常是看趋势，不是改参数
  const [busy, setBusy] = useState('');
  const [confirm, setConfirm] = useState(null);
  const [presets, setPresets] = useState(null);
  const [embBackend, setEmbBackend] = useState(null);
  /* 生图模型清单只在进入生图模式后拉一次：它是磁盘上的静态信息，
     不该混进 3 秒一轮的状态轮询里去扫盘。 */
  const [sdModels, setSdModels] = useState(null);
  /* 前端这份峰值只补服务端采样的缝隙：服务端 10 秒记一个点，两点之间的瞬时高值
     只有正在轮询的前端看得见。刷新页面即归零，跨刷新的部分由服务端 peaks 提供。 */
  const peak = useRef({ tj: 0, genTps: 0, cpu: 0 });

  const load = useCallback(async () => {
    try {
      const [s, r, p, eb] = await Promise.all([
        api.getStatus(), api.getRuntime().catch(() => null), api.getPresets().catch(() => null),
        api.getEmbeddingBackend().catch(() => null)]);
      setSt(s); if (r) setRt(r); if (p) setPresets(p); if (eb) setEmbBackend(eb);
      setErr('');
      const tj = s.thermal && (s.thermal.tj ?? s.thermal.GPU);
      if (tj) peak.current.tj = Math.max(peak.current.tj, tj);
      if (r && r.rate && r.rate.genTps) peak.current.genTps = Math.max(peak.current.genTps, r.rate.genTps);
      const cpuNow = Array.isArray(s.tegra && s.tegra.cpu) && s.tegra.cpu.length
        ? Math.max(...s.tegra.cpu.map((c) => c.pct || 0)) : 0;
      if (cpuNow) peak.current.cpu = Math.max(peak.current.cpu, cpuNow);
    } catch (e) { setErr(e.message); }
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 3000); return () => clearInterval(t); }, [load]);

  const imgUnitOn = !!(st && st.units && st.units['comfyui'] && st.units['comfyui'].active === 'active');
  useEffect(() => {
    if (!imgUnitOn || sdModels) return;
    api.getSdModels().then((d) => setSdModels(d && d.models)).catch(() => { /* 列不出来就退回提示文案 */ });
  }, [imgUnitOn, sdModels]);

  const act = async (label, fn) => {
    setBusy(label); setErr(''); setNotice('');
    try { await fn(); setNotice(label + '已完成'); }
    catch (e) { setErr(label + '失败：' + e.message); }
    setBusy(''); load();
  };

  /* 清理文件缓存。结果要报出**实际释放了多少**——只说"已完成"的话，
     用户看不出这次到底有没有用（有时内核早就回收过了，清了也没变化）。 */
  const [dropping, setDropping] = useState(false);
  const dropCaches = async () => {
    setDropping(true); setErr(''); setNotice('');
    try {
      const r = await api.dropCaches();
      const freedG = (r.freedKB || 0) / 1048576;
      const availG2 = (r.after && r.after.availKB ? r.after.availKB : 0) / 1048576;
      setNotice(freedG >= 0.05
        ? `已释放 ${freedG.toFixed(2)} GB 文件缓存，当前剩余可分配 ${availG2.toFixed(2)} GB`
        : `缓存已是最简状态，无可释放的部分（剩余可分配 ${availG2.toFixed(2)} GB）`);
    } catch (e) { setErr('清理缓存失败：' + e.message); }
    setDropping(false); load();
  };

  if (!st) {
    return (
      <div className="grid h-full place-items-center p-6 text-[13px]" style={{ color: 'var(--fg-3)' }}>
        {err ? <Banner>{'无法连接面板服务：' + err}</Banner> : '正在读取设备状态…'}
      </div>
    );
  }

  const mem = st.mem;
  const totalG = fromKB(mem.totalKB);
  const availG = fromKB(mem.availKB);
  const usedG = totalG - availG;
  const cacheG = fromKB(mem.cachedKB);
  const memLevel = levelOfAvail(availG);

  const tj = st.thermal.tj ?? st.thermal.GPU ?? 0;
  const tempLevel = levelOfTemp(tj);
  const cpuBusiest = Array.isArray(st.tegra.cpu) && st.tegra.cpu.length
    ? Math.max(...st.tegra.cpu.map((c) => c.pct || 0)) : null;
  /* 峰值口径：服务端历史缓冲（6 小时，跨页面刷新保留）与本次前端采样取大。
     此前只用前端 useRef，刷新一次就归零，会话跑完再打开面板永远是空的。 */
  const pk = (rt && rt.peaks) || {};
  const maxOf = (...xs) => {
    const v = xs.filter((x) => Number.isFinite(x) && x > 0);
    return v.length ? Math.max(...v) : null;
  };
  const peakTj = maxOf(pk.tj, peak.current.tj);
  /* ★ 生成速度峰值只认服务端（2026-08-19 改）：服务端已按模型分桶，
     而前端这个 useRef 不分模型——在面板上换完模型不刷新页面，
     上一个模型的峰值就会一直跟着新模型走。温度/CPU 是机器级的，仍可取大。 */
  const peakGenTps = maxOf(pk.genTps);
  const peakCpu = maxOf(pk.cpu, peak.current.cpu);
  /* 模型级峰值从该模型第一次被记录起算，机器级从面板首次运行起算，两者口径不同 */
  const peakWin = pk.modelPeakSince
    ? '自 ' + new Date(pk.modelPeakSince).toLocaleDateString('zh-CN') + ' 换用本模型起'
    : pk.since ? '自 ' + new Date(pk.since).toLocaleDateString('zh-CN') + ' 起' : '统计期内';
  const availMinG = Number.isFinite(pk.availKBMin) ? pk.availKBMin / 1048576 : null;

  const llm = st.units['llm-server'] || {};
  const car = st.units['application_start'] || {};
  const emb = st.units['llm-embedding'] || {};
  const img = st.units['comfyui'] || {};
  const llmOn = llm.active === 'active';
  const carOn = car.active === 'active';
  const imgOn = img.active === 'active';
  const embOn = emb.active === 'active';
  /* active 与 ready 是两件事：systemd 起了进程就报 active，而生图服务要几十秒
   * 才开始接请求（要先把模型载进内存）。凡是"能不能打开界面"，判据用 ready；
   * 凡是"当前处于哪个模式"，判据用 active。混用会让入口提前出现、点进去打不开。 */
  const imgReady = img.ready === true;
  const imgStarting = imgOn && !imgReady;
  const llmReady = llm.ready !== false;      // 后端没给 ready 时按旧行为处理
  const llmStarting = llmOn && !llmReady;
  /* 生图与生视频是同一个服务的两组启动参数，靠档位区分，不是两个服务。
   * 所以 imgOn 只说明"ComfyUI 在跑"，跑的是哪一档要看 comfyProfile。
   * 这个区分必须显示出来：用错档不报错，只是生图慢 14~38%、
   * 或长视频跑到 8 分钟才被内存杀掉，界面上看不出来就永远不会被发现。 */
  const prof = st.comfyProfile || null;          // 'image' | 'video' | 'unknown' | null
  const videoOn = imgOn && prof === 'video';
  const imageOn = imgOn && prof !== 'video';     // 档位未知时按生图算（历史默认）
  /* 模式共用内存，同时只能有一种；向量服务不参与，它各模式下都能常驻 */
  const modeName = carOn ? '车机模式' : videoOn ? '生视频模式' : imgOn ? '生图模式' : llmOn ? '推理模式' : '均未运行';
  const modeConflict = [llmOn, imgOn, carOn].filter(Boolean).length > 1;

  /* 生图统计。后端只在生图服务 ready 时才去拉，没起来时是 null——所有引用都要判空。
   * 口径：这些数来自生图服务自己的任务历史，**重启该服务后归零**，不是历史总量。 */
  const cy = st.comfy || null;

  const slot = (rt && rt.kv && rt.kv[0]) || null;
  const ctxTotal = slot ? slot.nCtx : (st.config.ctx || 0);
  const ctxUsed = slot ? slot.used : 0;
  const ctxRemain = slot ? slot.remain : ctxTotal;
  const ctxPct = ctxTotal ? (ctxUsed / ctxTotal) * 100 : 0;
  /* 命中率要用"没重算的比例"，不能用 n_prompt_tokens_cache。
     实测：从 --cache-ram 池恢复的状态走的是另一条路径，n_prompt_tokens_cache 仍是 0，
     只有 n_prompt_tokens_processed 会变小——8696 个 token 里只重算了 4 个，
     按旧公式显示 0%，实际命中 99.9%。 */
  const cacheHitPct = slot && slot.promptTokens
    ? ((slot.promptTokens - (slot.processedTokens || 0)) / slot.promptTokens) * 100 : null;

  const rate = (rt && rt.rate) || {};
  const life = (rt && rt.lifetime) || {};
  /* ★ 当前模型自己的用量（2026-08-19 加）。lifetime 是跨模型终身累计，
     拿它当"这个模型有多快"的回退值会显示另一个模型的成绩：
     板上换成 Qwen3.8-27B（实测 10~12 tok/s）后，空闲时那里一直写着 36.5，
     那是 Qwen3.6 时代攒下的平均。凡是模型性能的展示位一律用 mdl。 */
  const mdl = (rt && rt.model) || {};
  const reqs = (rt && rt.requests) || {};
  const hasTtft = reqs.ttftP95 != null;   // 只有流式请求才量得出首 Token 延迟
  const ember = (rt && rt.embedding) || null;
  const queued = rt && rt.queue ? rt.queue.deferred : 0;
  const processing = rt && rt.queue ? rt.queue.processing : 0;
  const working = processing > 0 || (slot && slot.busy);

  /* ★ 不再兜底到硬编码的 18 KiB（2026-08-19 修）：那个数是对 Qwen3.6-35B-A3B
     实测的，Qwen3.8-27B 是 SSM/全注意力混合架构，KV 结构完全不同，套用会得出错的
     GB 数。后端查不到实测值就返回 null，这里一路传 null 下去，界面显示"—"。 */
  const kvPerTokenB = (rt && Number.isFinite(rt.kvBytesPerToken)) ? rt.kvBytesPerToken : null;
  const kvFullG = kvPerTokenB ? (ctxTotal * kvPerTokenB) / 1073741824 : null;
  const kvUsedG = kvPerTokenB ? (ctxUsed * kvPerTokenB) / 1073741824 : null;

  /* 健康判断按当前模式给：生图模式下"推理服务未运行"是正常状态，不该报红 */
  const health = modeConflict ? { level: 'bad', text: '多个模式同时运行' }
    : availG < 0.5 ? { level: 'bad', text: '内存不足' }
      : tj >= 92 ? { level: 'bad', text: '温度过高' }
        : imgOn ? ((availG < 1.5 || tj >= 80) ? { level: 'warn', text: '需要留意' } : { level: 'ok', text: '生图服务运行中' })
          : carOn ? { level: 'ok', text: '车机软件运行中' }
            : !llmOn ? { level: 'bad', text: '推理服务未运行' }
              : (availG < 1.5 || tj >= 80 || queued > 3) ? { level: 'warn', text: '需要留意' }
                : { level: 'ok', text: '运行正常' };

  const toggle = (k) => setDetail((d) => (d === k ? '' : k));

  return (
    <div className="mx-auto max-w-[1280px] p-4">
      <header className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="m-0 text-[17px] font-semibold tracking-tight">IECU 推理服务</h1>
        <Status level={health.level}>{health.text}</Status>
        <Tag>{modeConflict ? '冲突' : modeName}</Tag>
        <span className="tnum text-[11.5px]" style={{ color: 'var(--fg-3)' }}
          title="推理服务自上次启动以来的运行时长">
          运行 {fmt(st.uptimeSec / 3600)} 小时
        </span>
        <span className="flex-1" />
        <span className="tnum text-[11.5px]" style={{ color: 'var(--fg-3)' }}>
          {new Date().toLocaleTimeString('zh-CN')}
        </span>
        <button onClick={() => api.logout().then(() => window.location.replace('/login.html'))}
          className="text-[11.5px] underline underline-offset-2" style={{ color: 'var(--fg-3)' }}>退出</button>
      </header>

      {err ? <Banner onClose={() => setErr('')}>{err}</Banner> : null}
      {notice ? <Banner level="ok" onClose={() => setNotice('')}>{notice}</Banner> : null}

      {/* ── 概览 ─────────────────────────────────────────── */}
      <div className="cardgrid mb-3" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(268px,1fr))' }}>
        {/* 前两张卡跟着模式走。生图模式下对话模型本就停着，再摆「生成速度 未运行」
            和「上下文 0/128K」，等于半个屏幕在显示恒为空的数字——看着像坏了。
            换成生图自己的指标：这一单跑多久、在调用哪个模型。
            （同样的做法下面「模型配置」卡已经用了，保持一致。） */}
        {imgOn ? (
          <Card onClick={() => toggle('imgspeed')} active={detail === 'imgspeed'}>
            <CardTitle hint="单张图从开始执行到写出文件的耗时，取自生图服务自己的记录。首张含模型载入，会明显慢于后续。"
              right={<Status level={cy && cy.running > 0 ? 'accent' : 'idle'}>{cy && cy.running > 0 ? '出图中' : '空闲'}</Status>}>
              出图耗时
            </CardTitle>
            <Big value={cy && cy.lastSec != null ? fmt(cy.lastSec, 1) : '尚未出图'}
              unit={cy && cy.lastSec != null ? '秒' : ''}
              level={cy && cy.lastSec != null ? 'ok' : 'idle'}
              sub={cy && cy.pending > 0 ? `${cy.pending} 个排队` : (cy && cy.avgSec != null ? '平均 ' + fmt(cy.avgSec, 1) + ' 秒' : '在生图界面提交任务后这里会有数据')} />
            <Bar pct={cy && cy.lastSec != null ? Math.min(100, (cy.lastSec / 120) * 100) : 0}
              level={cy && cy.lastSec > 120 ? 'warn' : 'ok'} />
            <StatGrid items={[
              { k: '平均耗时', v: cy && cy.avgSec != null ? fmt(cy.avgSec, 1) : '—', u: cy && cy.avgSec != null ? '秒' : '',
                title: '本次服务运行以来所有成功任务的平均耗时。' },
              { k: '已出图', v: cy ? int(cy.images) : '—', u: '张', title: '本次服务运行以来写出的图片张数。重启生图服务后归零。' },
              { k: '排队', v: cy ? int(cy.pending) : '—', u: '个', level: cy && cy.pending > 0 ? 'warn' : 'ok',
                title: '已提交但还没开始执行的任务数。' },
              { k: '失败', v: cy ? int(cy.failed) : '—', u: '次', level: cy && cy.failed > 0 ? 'warn' : 'ok',
                title: '执行中出错的任务数，多为内存不足或缺模型。详情看生图界面的日志。' },
            ]} />
          </Card>
        ) : (
        <Card onClick={() => toggle('infer')} active={detail === 'infer'}>
          <CardTitle hint={T.decode} right={<Status level={working ? 'accent' : 'idle'}>{working ? '生成中' : '空闲'}</Status>}>
            生成速度
          </CardTitle>
          {/* 车机模式下对话模型本就该停着，这时显示"未运行"而不是报红的"停止" */}
          {/* 空闲时回退到**当前模型**的平均值，不是终身平均——终身平均跨模型，
              换模型之后会把上一个模型的成绩挂在这里。当前模型还没跑过就显示"—"。 */}
          <Big value={llmOn ? fmt(rate.genTps ?? mdl.genTps, 1) : carOn ? '未运行' : '停止'}
            unit={llmOn && (rate.genTps ?? mdl.genTps) != null ? 'tokens/s' : ''}
            level={llmOn ? 'ok' : carOn ? 'idle' : 'bad'}
            sub={llmOn ? (queued > 0 ? `${queued} 个排队` : (rate.genTps == null && mdl.genTps != null ? '空闲，显示本模型均值' : null)) : (carOn ? '当前为车机模式' : null)} />
          {/* 进度条满刻度跟着本模型的实测峰值走。原来写死 40 tok/s 是按 Qwen3.6 定的，
              27B 最高才 12，条永远只有四分之一格，看不出快慢。 */}
          <Bar pct={((rate.genTps ?? mdl.genTps ?? 0) / Math.max(pk.genTps || 0, mdl.genTps || 0, 5) * 100)}
            level={queued > 3 ? 'warn' : 'ok'} />
          <StatGrid items={[
            { k: 'Prefill', v: fmt(rate.promptTps ?? mdl.promptTps, 0), u: 'tokens/s', title: T.prefill },
            /* 非流式请求量不出 TTFT（第一个字节就是整段回答），此时改看总耗时，
               而不是留一个永远是 — 的格子 */
            hasTtft
              ? { k: '首 Token 延迟', v: ms(reqs.ttftLast), title: T.ttft }
              : { k: '单次总耗时', v: reqs.totalLast != null ? ms(reqs.totalLast) : '—', title: T.totalP95 },
            hasTtft
              ? { k: 'TTFT P95', v: ms(reqs.ttftP95), title: '最近 60 次流式请求里，95% 的首 Token 延迟都优于这个值。' }
              : { k: '总耗时 P95', v: reqs.totalP95 != null ? ms(reqs.totalP95) : '—', title: T.totalP95 },
            { k: '排队', v: queued, u: '个', level: queued > 3 ? 'warn' : 'ok', title: T.queue },
          ]} />
        </Card>
        )}

        {imgOn ? (
          <Card onClick={() => toggle('imgcall')} active={detail === 'imgcall'}>
            <CardTitle hint="最近一次执行实际加载的主模型，取自任务本身的参数，不是面板的配置项——工作流里换了模型，这里就会跟着变。">
              当前调用
            </CardTitle>
            {/* 大字放缩短名，完整文件名给 title——原样放会把卡片撑变形 */}
            <Big value={prettyName(cy && (cy.runningModel || cy.lastModel)) || '尚未调用'}
              title={cy && (cy.runningModel || cy.lastModel) ? '文件名：' + (cy.runningModel || cy.lastModel) : ''}
              level={cy && cy.runningModel ? 'accent' : (cy && cy.lastModel ? 'ok' : 'idle')}
              sub={cy && cy.runningModel ? '正在执行' :
                (cy && cy.lastAtISO ? '最近一次 ' + new Date(cy.lastAtISO).toLocaleTimeString('zh-CN') : '在生图界面提交任务后这里会有数据')} />
            <Bar pct={cy && cy.running > 0 ? 100 : 0} level="accent" />
            <StatGrid items={[
              { k: '执行中', v: cy ? int(cy.running) : '—', u: '个', level: cy && cy.running > 0 ? 'accent' : 'ok',
                title: '生图服务当前正在执行的任务数。' },
              { k: '任务数', v: cy ? int(cy.jobs) : '—', u: '次',
                title: '本次服务运行以来提交的任务总数，含失败的。重启生图服务后归零。' },
              { k: '工作流节点', v: cy && cy.lastNodes ? int(cy.lastNodes) : '—', u: cy && cy.lastNodes ? '个' : '',
                title: '最近一次执行的工作流包含多少个节点，可用来认出跑的是哪张工作流。' },
              { k: '向量服务', v: emb.active === 'active' ? '运行中' : '已停止',
                level: emb.active === 'active' ? 'ok' : 'idle',
                title: '向量服务不参与模式互斥，生图时仍可常驻。' },
            ]} />
          </Card>
        ) : (
        <Card onClick={() => toggle('ctx')} active={detail === 'ctx'}>
          <CardTitle hint={T.ctx}>上下文</CardTitle>
          <Big value={tokK(ctxUsed)} unit={'/ ' + ctxK(ctxTotal)} level={levelOfPct(ctxPct)}
            sub={fmt(ctxPct, 0) + '%'} />
          <Bar pct={ctxPct} level={levelOfPct(ctxPct)} />
          <StatGrid items={[
            { k: '剩余可容纳', v: tokK(ctxRemain), u: 'tokens', level: 'accent', title: '在触发最早内容淘汰前，本次会话仍可容纳的 token 数。' },
            { k: '约合中文', v: tokK(ctxRemain * CHARS_PER_TOKEN), u: '字', title: '按 1 token ≈ 0.7 个汉字估算。' },
            { k: 'KV 已占', v: kvUsedG === null ? '—' : fmt(kvUsedG, 2), u: kvUsedG === null ? '' : 'GB',
              title: kvUsedG === null
                ? '当前模型每 token 的 KV 字节数还没有实测值，换算不出 GB。\n在 config.json 里填 kvBytesPerToken 后这里就会显示。'
                : T.kv },
            { k: '缓存命中', v: cacheHitPct === null ? '—' : fmt(cacheHitPct, 0), u: '%', title: T.cacheHit },
          ]} />
        </Card>
        )}

        <Card onClick={() => toggle('mem')} active={detail === 'mem'}>
          <CardTitle hint={T.unifiedMem}>内存</CardTitle>
          <Big value={fmt(usedG) + ' / ' + fmt(totalG)} unit="GB" level="ok"
            sub={fmt((usedG / totalG) * 100, 0) + '%'} />
          <Bar segments={[
            { pct: ((llm.realB || 0) / 1073741824 / totalG) * 100, color: 'var(--accent)', title: '推理服务' },
            { pct: ((emb.realB || 0) / 1073741824 / totalG) * 100, color: 'var(--accent)', dim: true, title: 'Embedding 服务' },
            { pct: Math.max(0, ((usedG - (llm.realB || 0) / 1073741824 - (emb.realB || 0) / 1073741824) / totalG) * 100), color: 'var(--fg-3)', dim: true, title: '系统与其它' },
          ]} />
          <StatGrid items={[
            { k: '剩余可分配', v: fmt(availG, 2), u: 'GB', level: memLevel === 'ok' ? 'accent' : memLevel,
              title: T.avail + (availMinG != null ? peakWin + '记录到的最低值为 ' + fmt(availMinG, 2) + ' GB。' : '') },
            { k: '推理服务', v: fmt(GiB(llm.realB || 0)), u: 'GB', title: T.realMem },
            { k: 'Embedding', v: fmt(GiB(emb.realB || 0)), u: 'GB', title: T.realMem },
            { k: '系统文件缓存', v: fmt(cacheG), u: 'GB',
              title: '内核为已读文件保留的页缓存，内存不足时由系统自动回收。与推理服务的 Prompt 缓存池无关，后者计入进程内存。' },
          ]} />
        </Card>

        <Card onClick={() => toggle('temp')} active={detail === 'temp'}>
          <CardTitle hint={T.tj}>温度与负载</CardTitle>
          <Big value={fmt(tj)} unit="°C" level={tempLevel}
            sub={peakTj ? '峰值 ' + fmt(peakTj) + '°' : null} />
          <Bar pct={(tj / 105) * 100} level={tempLevel} />
          <StatGrid items={[
            { k: 'GPU', v: fmt(st.thermal.GPU), u: '°C', title: '显卡温度。' },
            { k: 'CPU', v: fmt(st.thermal.CPU), u: '°C', title: '处理器温度。' },
            { k: 'GPU 占用', v: st.tegra.gr3d && st.tegra.gr3d.pct != null ? st.tegra.gr3d.pct : '—', u: '%', title: T.gpu },
            { k: '最忙核心', v: cpuBusiest != null ? cpuBusiest : '—', u: '%',
              title: '当前 12 个核心里占用最高的那一个。' + (peakCpu ? peakWin + '内最高 ' + Math.round(peakCpu) + '%。' : '') },
          ]} />
        </Card>
      </div>

      {detail ? (
        <DetailPanel which={detail} st={st} rt={rt} slot={slot} life={life} reqs={reqs}
          usedG={usedG} availG={availG} totalG={totalG} cacheG={cacheG}
          kvPerTokenB={kvPerTokenB} kvFullG={kvFullG} llm={llm} emb={emb} cy={cy}
          onDropCaches={dropCaches} dropping={dropping}
          onClose={() => setDetail('')} />
      ) : null}

      {/* ── 运行模式 + 服务 ─────────────────────────────── */}
      <div className="cardgrid mb-3" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(400px,1fr))' }}>
        <Card>
          <CardTitle hint="各模式共用同一块内存，同一时刻只能运行一种。生图与生视频是同一个服务的两组参数，切换需重启该服务，约 1 分钟。向量服务不受影响，除车机模式外都可常驻。">运行模式</CardTitle>
          <Big value={modeConflict ? '冲突' : modeName}
            level={modeConflict ? 'bad' : (llmOn || imgOn || carOn) ? 'ok' : 'warn'} />
          <StatGrid cols="repeat(2,1fr)" items={[
            { k: '对话模型', v: llmStarting ? '启动中' : llmOn ? '运行中' : '已停止',
              level: llmStarting ? 'warn' : llmOn ? 'ok' : 'idle',
              title: llmStarting ? '进程已启动，模型正在载入内存，此时还不能对话。' : undefined },
            { k: '生图服务', v: imgStarting ? '启动中' : imgOn ? '运行中' : '已停止',
              level: imgStarting ? 'warn' : imgOn ? 'ok' : 'idle',
              title: imgStarting ? '进程已启动，模型正在载入内存，通常 30 秒到 1 分钟。载入完成后才能打开生图界面。' : undefined },
            { k: '当前档位', v: prof === 'video' ? '生视频' : prof === 'image' ? '生图' : '未知',
              level: prof === 'video' || prof === 'image' ? 'ok' : 'warn',
              title: '生图与生视频共用同一个服务，靠启动参数区分。生图档全部模型常驻，出图快；生视频档按需调度内存，能跑更长的片子。用错档不会报错：生图档跑长视频会中途失败，生视频档出图慢 14% 到 38%。' },
            { k: '车机软件', v: carOn ? '运行中' : '已停止', level: carOn ? 'ok' : 'idle' },
            { k: '向量服务', v: embOn ? '运行中' : '已停止', level: embOn ? 'ok' : 'idle',
              title: '不参与模式互斥。CPU 档只占约 1.3 GB，对话与生图模式下都能常驻；需要腾内存时在下方「服务」里单独停止。' },
            { k: '开机启动', v: llm.enabled === 'enabled' ? '对话模型' : car.enabled === 'enabled' ? '车机软件' : '无',
              title: '断电重启后自动启动的服务。生图模式是临时状态，切换时不改这一项，重启后回到对话模型。' },
          ]} />
          <div className="mt-auto flex flex-wrap items-center gap-2 pt-3">
            <Btn kind="primary" disabled={busy !== '' || (llmOn && !imgOn && !carOn)}
              onClick={() => setConfirm({
                title: '切换到推理模式',
                body: '将停止生图服务与车机软件，启动对话模型，并把开机自启项设为对话模型。模型加载约 1.5 分钟。',
                confirmLabel: '切换到推理模式',
                run: () => act('切换到推理模式', () => api.switchMode('llm')),
              })}>推理模式</Btn>
            <Btn disabled={busy !== '' || (imageOn && !llmOn && !carOn)}
              onClick={() => setConfirm({
                title: '切换到生图模式',
                body: '将停止对话模型，启动生图服务并切到生图档（模型全部常驻，出图最快）。正在进行的对话立即中断，网关与知识库将无法调用对话模型；向量服务不受影响，仍可继续使用。'
                  + '开机自启项保持为对话模型，断电重启后回到推理模式。切换约需 1 分钟。',
                confirmLabel: '停止对话并切换',
                run: () => act('切换到生图模式', () => api.switchMode('image')),
              })}>生图模式</Btn>
            <Btn disabled={busy !== '' || (videoOn && !llmOn && !carOn)}
              onClick={() => setConfirm({
                title: '切换到生视频模式',
                body: '将停止对话模型，启动生图服务并切到生视频档（按需调度内存，能跑更长的片子）。正在进行的对话立即中断；向量服务不受影响。'
                  + '这一档出图比生图档慢 14% 到 38%，只在生成视频时使用。'
                  + '开机自启项保持为对话模型，断电重启后回到推理模式。切换约需 1 分钟。',
                confirmLabel: '停止对话并切换',
                run: () => act('切换到生视频模式', () => api.switchMode('video')),
              })}>生视频模式</Btn>
            <Btn kind="danger" disabled={busy !== '' || (carOn && !llmOn && !imgOn)}
              onClick={() => setConfirm({
                title: '切换到车机模式',
                body: '将停止对话模型、生图服务与向量服务，启动车机软件。所有本地模型能力立即不可用。',
                confirmWord: '车机模式',
                confirmLabel: '停止全部并切换',
                run: () => act('切换到车机模式', () => api.switchMode('car')),
              })}>车机模式</Btn>
          </div>
          {/* 入口跟着模式走：当前模式能用哪个界面就只显示哪个，不给已停服务的死链接 */}
          <div className="mt-2 flex flex-wrap items-center gap-3 border-t pt-2.5"
            style={{ borderColor: 'var(--line-soft)' }}>
            {/* 入口只在服务真能接请求时才是链接。启动中给不可点的提示——
                以前按 active 就放出链接，用户点进去撞 502，而错误页还叫他"切换到生图模式"，
                他明明已经切了。 */}
            {llmOn && llmReady ? (
              <a href="/llm/" target="_blank" rel="noreferrer"
                className="text-[12.5px] underline underline-offset-2" style={{ color: 'var(--accent)' }}>
                打开对话测试 ↗
              </a>
            ) : null}
            {llmStarting ? (
              <span className="text-[12.5px]" style={{ color: 'var(--fg-3)' }}>
                对话模型载入中，完成后出现测试入口
              </span>
            ) : null}
            {imgReady ? (
              <a href="/comfy/" target="_blank" rel="noreferrer"
                className="text-[12.5px] underline underline-offset-2" style={{ color: 'var(--accent)' }}>
                打开生图界面 ↗
              </a>
            ) : null}
            {imgStarting ? (
              <span className="text-[12.5px]" style={{ color: 'var(--fg-3)' }}>
                生图服务载入中，通常 30 秒到 1 分钟，完成后出现界面入口
              </span>
            ) : null}
            {!llmOn && !imgOn ? (
              <span className="text-[12.5px]" style={{ color: 'var(--fg-3)' }}>
                切换到推理或生图模式后，这里会出现对应的界面入口
              </span>
            ) : null}
          </div>
        </Card>

        {(() => {
          const pr = presets && presets.presets;
          const prActive = pr
            ? (pr.mtp && pr.mtp.active ? 'mtp'
              : pr.mm && pr.mm.active ? 'mm'
              : pr.q38 && pr.q38.active ? 'q38' : 'custom')
            : null;
          /* 当前跑的是 Qwen3.6 家族（mtp / mm 两个加载档），还是 Qwen3.8-27B（单档）。
             custom 也归到 3.6 一侧：那说明配置被手工改过，两个加载档仍然可选。 */
          const q36Active = prActive !== 'q38';
          const ebOn = embBackend && embBackend.active;
          const VEC_NOTE = '两档算出的向量数值不同（余弦相似度 0.9997），已建立的知识库需重新生成向量。';
          /* 档位状态取值统一：使用中 / 就绪 / 模型文件缺失。三档共用，避免各写一份写歪。 */
          const prState = (k) => (pr && pr[k] ? (pr[k].active ? '使用中' : pr[k].modelReady ? '就绪' : '模型文件缺失') : '—');
          const prLevel = (k) => (pr && pr[k] && pr[k].active ? 'ok' : 'idle');
          /* 两个区块结构与交互保持一致：当前值 + 状态网格 + 切换按钮 */
          const Section = ({ title, current, items, buttons, border }) => (
            <div className={border ? 'border-b pb-3' : 'pt-3'} style={border ? { borderColor: 'var(--line-soft)' } : undefined}>
              <div className="mb-1.5 flex items-baseline justify-between gap-2">
                <span className="text-[12.5px] font-semibold">{title}</span>
                <span className="text-[14px] font-semibold" style={{ color: current.dim ? 'var(--fg-3)' : 'var(--accent)' }}>
                  {current.text}
                </span>
              </div>
              <StatGrid cols="repeat(2,1fr)" items={items} />
              <div className="mt-2.5 flex flex-wrap gap-2">{buttons}</div>
            </div>
          );
          /* 这张卡片必须跟着模式走。生图模式下对话模型已经停了，再摆两个"切换到 MTP 加速"
             的按钮是错的——点下去会重启对话模型，等于把模式偷偷切回推理、还把生图打断。
             所以生图模式下这一段换成生图模型清单（只读），对话模型的切换收起来。 */
          const fmtG = (b) => (b / 1073741824).toFixed(1) + ' GB';
          /* prettyName 已提到模块级（生图卡片也要用），这里直接引用 */
          /* 三档而不是能/不能两档：14.5 GB 与 19.3 GB 两个点是实测的，中间那段没测过，
             不能把内插出来的边界说成确定结论。 */
          /* 文案只讲体积与余量，不下"能/不能"的断言。
             断言过一次就翻过车：算法把目录里所有编码器求和，把正在正常出图的模型
             标成了「内存不足」——与用户眼前的事实相反。能不能跑取决于工作流实际
             加载哪几个文件、以及当时还剩多少内存，静态判断给不出这个答案。 */
          const FIT = {
            ok: { v: null, level: 'idle', note: '' },
            tight: { v: null, level: 'warn', note: '\n体积偏大，接近本板的常驻上限，视当时余量而定。' },
            over: { v: null, level: 'warn', note: '\n体积较大，若载入失败就换更低的量化档。' },
          };
          const SdSection = () => {
            const list = Array.isArray(sdModels) ? sdModels : [];
            return (
              <div className="border-b pb-3" style={{ borderColor: 'var(--line-soft)' }}>
                <div className="mb-1.5 flex items-baseline justify-between gap-2">
                  <span className="text-[12.5px] font-semibold">生图模型</span>
                  {/* 不再报"X / Y 个可用"：能不能用取决于工作流实际加载哪几个文件，
                      面板给不出这个判断，报了反而与眼前的事实打架 */}
                  <span className="text-[14px] font-semibold" style={{ color: 'var(--fg-3)' }}>
                    {list.length ? `${list.length} 个` : '读取中'}
                  </span>
                </div>
                {list.length ? (
                  <StatGrid cols="repeat(2,1fr)" items={list.slice(0, 6).map((m) => {
                    const f = FIT[m.fit] || FIT.ok;
                    return {
                      k: prettyName(m.name),
                      /* 装不下的直接说清楚，别让人选完了才撞内存不足 */
                      v: f.v || fmtG(m.sizeB),
                      level: f.level,
                      title: m.name + '\n'
                        + (m.kind === 'checkpoint'
                          ? '单文件模型，在生图界面选中即可出图。'
                          : '出图时还要载入文本编码器与 VAE，合计约 ' + fmtG(m.totalB) + '。')
                        + (m.quantized ? '\n量化权重，占用内存更小。' : '')
                        + f.note,
                    };
                  })} />
                ) : (
                  <div className="text-[12.5px]" style={{ color: 'var(--fg-3)' }}>
                    未读取到模型文件。请确认模型已放入板上的模型目录。
                  </div>
                )}
                <div className="mt-2.5 text-[12px]" style={{ color: 'var(--fg-3)' }}>
                  在生图界面的工作流里选择要用的模型，面板不代为切换。
                </div>
              </div>
            );
          };

          return (
            <Card>
              <CardTitle hint={imgOn
                ? '当前是生图模式。生图模型在生图界面里选择；向量服务不受模式影响，仍可在这里切换。'
                : '推理服务与向量服务各自使用的模型与计算方式。切换会重启对应服务，设置在重启后保持。'}>
                模型配置
              </CardTitle>

              {imgOn ? <SdSection /> : (
              <Section
                border
                title={q36Active ? '加载档位 · Qwen3.6-35B-A3B' : '加载档位 · Qwen3.8-27B'}
                current={{
                  text: prActive === 'mtp' ? 'MTP 加速（图像走 CPU）'
                    : prActive === 'mm' ? '多模态加速（图像走 GPU）'
                    : prActive === 'q38' ? '单一档位'
                    : prActive === 'custom' ? '自定义' : '—',
                  dim: !prActive || prActive === 'custom',
                }}
                /* ★ 这一区块只管「当前这个模型怎么加载」，不管换模型（2026-08-19 改）。
                   原来把 Qwen3.8-27B 和 Qwen3.6 的两个加载档并列成三个按钮，
                   等于把"换模型"和"换加载方式"混在同一行——前者换的是模型本体，
                   后者只是同一个模型的两种跑法。换模型的入口在下方「模型与参数」。 */
                items={q36Active ? [
                  {
                    k: 'MTP 加速',
                    v: prState('mtp'),
                    level: prLevel('mtp'),
                    title: 'Qwen3.6-35B-A3B，MTP 投机解码。32K 以上上下文的生成速度提高 28%~50%。图像识别走 CPU，1024×1024 约 28 秒。加载约 1.5 分钟。',
                  },
                  {
                    k: '多模态加速',
                    v: prState('mm'),
                    level: prLevel('mm'),
                    title: 'Qwen3.6-35B-A3B，图像识别走 GPU，1024×1024 约 4 秒。生成速度为基准值。加载约 4 分钟。',
                  },
                ] : [
                  { k: '当前模型', v: 'Qwen3.8-27B', level: 'ok',
                    title: '27B 密集模型，SSM 与全注意力混合架构。上下文 64K，不支持图像识别。' },
                  { k: '可选档位', v: '仅一档', level: 'idle',
                    title: 'MTP 投机解码已内置在模型文件里，没有第二种加载方式可选。\n实测生成 10~12 tok/s、预填充 244 tok/s，接受率 0.42~0.51。' },
                ]}
                buttons={q36Active ? <>
                  <Btn kind="primary" disabled={busy !== '' || !pr || prActive === 'mtp' || !(pr.mtp && pr.mtp.modelReady)}
                    onClick={() => setConfirm({
                      title: '切换到 MTP 加速',
                      body: '重启推理服务并加载 MTP 模型，期间约 1.5 分钟无法对话。切换后 32K 以上上下文生成提速 28%~50%，图像识别走 CPU、1024×1024 约 28 秒。',
                      confirmLabel: '切换到 MTP 加速',
                      run: () => act('切换到 MTP 加速', () => api.applyPreset('mtp')),
                    })}>切换到 MTP 加速</Btn>
                  <Btn disabled={busy !== '' || !pr || prActive === 'mm' || !(pr.mm && pr.mm.modelReady)}
                    onClick={() => setConfirm({
                      title: '切换到多模态加速',
                      body: '重启推理服务并加载多模态模型，期间约 4 分钟无法对话。切换后图像识别走 GPU、1024×1024 约 4 秒，生成速度为基准值。',
                      confirmLabel: '切换到多模态加速',
                      run: () => act('切换到多模态加速', () => api.applyPreset('mm')),
                    })}>切换到多模态加速</Btn>
                </> : (
                  <span className="text-[12px]" style={{ color: 'var(--fg-3)' }}>
                    要换成别的对话模型，在下方「模型与参数」里操作。
                  </span>
                )}
              />
              )}

              <Section
                title="向量计算"
                current={{ text: ebOn === 'cuda' ? 'GPU' : ebOn === 'cpu' ? 'CPU' : '—', dim: !ebOn }}
                items={[
                  {
                    k: 'GPU',
                    v: ebOn === 'cuda' ? '使用中' : ebOn ? '可切换' : '—',
                    level: ebOn === 'cuda' ? 'ok' : 'idle',
                    title: '单条编码 12 ms，占用 GPU 映射内存约 2.2 GB。' + VEC_NOTE,
                  },
                  {
                    k: 'CPU',
                    v: ebOn === 'cpu' ? '使用中' : ebOn ? '可切换' : '—',
                    level: ebOn === 'cpu' ? 'ok' : 'idle',
                    title: '单条编码 23 ms，不占用 GPU 映射内存，使用 11 个 CPU 核。' + VEC_NOTE,
                  },
                ]}
                buttons={<>
                  <Btn kind="primary" disabled={busy !== '' || !ebOn || ebOn === 'cuda'}
                    onClick={() => setConfirm({
                      title: '向量计算切换到 GPU',
                      body: '重启向量服务，期间约 10 秒无法检索。切换后单条编码 12 ms，占用 GPU 映射内存约 2.2 GB。' + VEC_NOTE,
                      confirmLabel: '切换到 GPU',
                      run: () => act('向量计算切换到 GPU', () => api.applyEmbeddingBackend('cuda')),
                    })}>切换到 GPU</Btn>
                  <Btn disabled={busy !== '' || !ebOn || ebOn === 'cpu'}
                    onClick={() => setConfirm({
                      title: '向量计算切换到 CPU',
                      body: '重启向量服务，期间约 10 秒无法检索。切换后单条编码 23 ms，释放约 2.2 GB GPU 映射内存。' + VEC_NOTE,
                      confirmLabel: '切换到 CPU',
                      run: () => act('向量计算切换到 CPU', () => api.applyEmbeddingBackend('cpu')),
                    })}>切换到 CPU</Btn>
                </>}
              />
            </Card>
          );
        })()}

        <Card>
          <CardTitle hint={T.realMem}>服务</CardTitle>
          <div className="flex flex-col">
            {SERVICES.map(([key, name, desc]) => {
              const u = st.units[key] || {};
              const on = u.active === 'active';
              /* 推理服务与生图服务争同一块内存，同时只能有一个。
                 生图模式下若还能点「启动」推理服务，点下去就是两个大模型抢内存，
                 轻则加载失败重则触发低内存保护重启——这种按钮不该是可点的。
                 要换模式请用上面的「运行模式」卡，那里会先停另一个再启这个。 */
              const blocked = key === 'llm-server' && imgOn && !on;
              return (
                <div key={key} className="flex flex-wrap items-center justify-between gap-3 border-b py-2.5 last:border-b-0"
                  style={{ borderColor: 'var(--line-soft)' }}>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13.5px] font-semibold">{name}</span>
                      <Status level={on ? 'ok' : u.active === 'failed' ? 'bad' : 'idle'}>
                        {on ? '运行中' : u.active === 'failed' ? '启动失败' : '已停止'}
                      </Status>
                      {u.enabled === 'enabled' ? <Tag>开机自启</Tag> : null}
                      {on && u.realB ? <Tag>{fmt(GiB(u.realB))} GB</Tag> : null}
                    </div>
                    {/* 运行时这一行给内存分解，比重复一遍服务用途有用；停止时才显示用途 */}
                    <div className="mt-0.5 truncate text-[11.5px]" style={{ color: 'var(--fg-3)' }}>
                      {blocked
                        ? '当前是生图模式，两者共用内存。要用对话模型请在上方切换运行模式。'
                        : on && u.realB
                          ? `GPU 映射 ${fmt(GiB(u.gpuB || 0))} GB · 进程 ${fmt(GiB(u.hostB || 0))} GB`
                          : desc}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    <Btn disabled={on || blocked || busy !== ''}
                      title={blocked ? '生图模式下不能启动推理服务：两者共用内存。请用上方「运行模式」切换。' : ''}
                      onClick={() => act(name + '启动', () => api.serviceAction(key, 'start'))}>启动</Btn>
                    <Btn disabled={!on || busy !== ''} kind="danger"
                      onClick={() => setConfirm({
                        title: '停止' + name,
                        body: key === 'llm-server'
                          ? '正在进行的对话立即中断，所有调用方将无法调用模型。'
                          : '依赖向量检索的功能将不可用，知识库无法完成检索。',
                        confirmLabel: '停止' + name,
                        run: () => act(name + '停止', () => api.serviceAction(key, 'stop')),
                      })}>停止</Btn>
                    {/* 重启 = 停了再起，生图模式下同样会把推理服务拉起来抢内存 */}
                    <Btn disabled={blocked || busy !== ''}
                      title={blocked ? '生图模式下不能启动推理服务：两者共用内存。' : ''}
                      onClick={() => act(name + '重启', () => api.serviceAction(key, 'restart'))}>重启</Btn>
                  </div>
                </div>
              );
            })}
          </div>
          {busy ? <Meta>正在执行：{busy}…</Meta> : null}
        </Card>
      </div>

      {/* ── 累计：对话模型与 Embedding 分开 ───────────────── */}
      <div className="cardgrid mb-3" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(400px,1fr))' }}>
        {/* 累计卡同样跟着模式走：生图模式下对话模型停着，这一整张卡会是全 0 tokens */}
        {imgOn ? (
        <Card>
          <CardTitle right={<Tag>生图</Tag>}
            hint="来自生图服务自己的任务记录，重启该服务后归零，不是历史总量。">累计用量</CardTitle>
          <StatGrid cols="repeat(auto-fit,minmax(88px,1fr))" items={[
            { k: '任务数', v: cy ? int(cy.jobs) : '—', u: '次', title: '本次服务运行以来提交的任务总数，含失败的。' },
            { k: '已出图', v: cy ? int(cy.images) : '—', u: '张', title: '写出的图片张数。一个任务可能出多张。' },
            { k: '失败', v: cy ? int(cy.failed) : '—', u: '次', level: cy && cy.failed > 0 ? 'warn' : 'ok',
              title: '执行中出错的任务数，多为内存不足或缺模型。' },
            { k: '平均耗时', v: cy && cy.avgSec != null ? fmt(cy.avgSec, 1) : '—', u: cy && cy.avgSec != null ? '秒/张' : '',
              title: '成功任务的平均耗时。含模型载入的首张会把这个值拉高。' },
            { k: '最近耗时', v: cy && cy.lastSec != null ? fmt(cy.lastSec, 1) : '—', u: cy && cy.lastSec != null ? '秒' : '',
              title: '最近一次成功任务的耗时。' },
            { k: '累计计算', v: cy && cy.totalSec ? fmt(cy.totalSec, 0) : '—', u: cy && cy.totalSec ? '秒' : '',
              title: '所有任务的执行耗时之和，不含排队与空闲。' },
            { k: '最近调用', v: prettyName(cy && cy.lastModel) || '—',
              title: (cy && cy.lastModel ? '文件名：' + cy.lastModel + '\n' : '') + '最近一次执行实际加载的主模型，取自任务参数本身。' },
            { k: '最近完成', v: cy && cy.lastAtISO ? new Date(cy.lastAtISO).toLocaleTimeString('zh-CN') : '—',
              title: '最近一次任务完成的时间。' },
          ]} />
        </Card>
        ) : (
        <Card>
          <CardTitle right={<Tag>对话模型</Tag>}>累计用量</CardTitle>
          <StatGrid cols="repeat(auto-fit,minmax(88px,1fr))" items={[
            /* ★ 必须读 lifetime 不是 totals（2026-08-19 修）：totals 是「本次服务运行以来」，
               llama-server 一重启就归零，而这张卡的口径是累计。同一张卡里其它字段读的都是
               lifetime，只有这三项漏了，于是出现「累计计算 10011 秒、累计生成 0 tokens」
               这种自相矛盾的一屏。 */
            { k: '累计输入', v: tokK(rt ? life.promptTokens : NaN), u: 'tokens',
              title: '读入的 token 总数，跨服务重启累加，含历史上跑过的全部模型。'
                + (mdl.promptTokens != null ? '\n当前模型这一份：' + tokK(mdl.promptTokens) + ' tokens。' : '') },
            { k: '累计生成', v: tokK(rt ? life.genTokens : NaN), u: 'tokens',
              title: '生成的 token 总数，跨服务重启累加，含历史上跑过的全部模型。'
                + (mdl.genTokens != null ? '\n当前模型这一份：' + tokK(mdl.genTokens) + ' tokens。' : '') },
            /* ★ 速度类一律用当前模型的数（2026-08-19 改）。此前用 lifetime，
               那是跨模型累计：换成 Qwen3.8-27B 后这里仍显示 36.5 tokens/s，
               而它实测只有 10~12——把上一个模型的成绩安在了当前模型头上。 */
            { k: '平均 Prefill', v: fmt(mdl.promptTps, 0), u: 'tokens/s', title: T.prefill + '\n只统计当前模型。' },
            { k: 'Prefill 峰值', v: pk.promptTps ? fmt(pk.promptTps, 0) : '—',
              u: pk.promptTps ? 'tokens/s' : '', title: peakWin + '内的最高读入速度。与平均值差距大时，说明期间有请求被取消或有图像走 CPU 编码，那些时间计入平均值的分母。' },
            { k: '平均生成', v: fmt(mdl.genTps, 1), u: 'tokens/s', title: T.decode + '\n只统计当前模型。' },
            { k: '生成峰值', v: peakGenTps ? fmt(peakGenTps, 1) : '—',
              u: peakGenTps ? 'tokens/s' : '', title: peakWin + '内的最高生成速度，跨页面刷新保留。' },
            { k: '平均读入耗时', v: life.avgPromptSec != null ? fmt(life.avgPromptSec, 1) : '—',
              u: life.avgPromptSec != null ? '秒/次' : '',
              title: '单次对话在 Prefill 阶段平均花的时间，按累计 Prefill 耗时除以对话次数计算，含被中断的请求。'
                + (life.requests ? '已统计 ' + int(life.requests) + ' 次对话。' : '') },
            { k: '最长输入', v: tokK(rt ? life.maxSeenTokens : NaN), u: 'tokens', title: '单次请求的最大输入长度记录，跨服务重启保留。' },
            { k: '中断请求', v: reqs.abortedTotal ?? reqs.aborted ?? '—', u: '次',
              level: (reqs.abortedTotal ?? 0) > 0 ? 'warn' : 'ok',
              title: '客户端在响应完成前断开连接的请求数，跨面板重启累加。长输入被调用方超时掐断会计入这里。' },
            { k: '累计计算', v: fmt((life.promptSeconds || 0) + (life.genSeconds || 0), 0), u: '秒', title: 'Prefill 与生成的累计耗时，不含空闲时间。' },
          ]} />
        </Card>
        )}

        <Card>
          <CardTitle right={<Tag>Embedding</Tag>}>Embedding 服务</CardTitle>
          {ember ? (
            <StatGrid cols="repeat(auto-fit,minmax(88px,1fr))" items={[
              { k: '状态', v: ember.up ? '在线' : '离线', level: ember.up ? 'ok' : 'bad' },
              { k: '累计处理', v: tokK(ember.usage ? ember.usage.tokens : NaN), u: 'tokens', title: '编码的 token 总数，跨服务重启累加。' },
              { k: '平均速度', v: fmt(ember.usage ? ember.usage.tps : NaN, 0), u: 'tokens/s', title: T.embTps },
              ember.rate && ember.rate.tps
                ? { k: '近期速度', v: fmt(ember.rate.tps, 0), u: 'tokens/s', title: '最近 2 分钟内的编码速度。' }
                : { k: '近期速度', v: '空闲', level: 'idle', title: '最近 2 分钟没有编码请求。' },
              { k: '单次耗时', v: ember.usage && ember.usage.avgMs != null ? ms(ember.usage.avgMs) : '—', title: T.embLatency },
              { k: '请求数', v: ember.usage ? int(ember.usage.count) : '—', u: '次', title: '经面板转发的编码请求次数，跨服务重启累加。' },
              { k: '处理位', v: ember.totalSlots ?? '—', u: '个', title: T.slot },
              { k: '单次上限', v: ember.nCtx ? ctxK(ember.nCtx) : '—', u: 'tokens', title: '单条文本的最大长度，超出会被截断。' },
              { k: '最长输入', v: tokK(ember.usage ? ember.usage.maxTokens : NaN), u: 'tokens', title: '已记录的最大单次输入长度。' },
              { k: '排队', v: ember.deferred ?? 0, u: '个', title: T.queue },
            ]} />
          ) : <Meta>Embedding 服务未响应。</Meta>}
        </Card>
      </div>

      {/* ── 管理层 ─────────────────────────────────────── */}
      <div className="mb-2 flex gap-1">
        {[['charts', '历史趋势'], ['params', '模型与参数'], ['logs', '运行日志']].map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className="rounded-t-md border-b-2 px-3 py-1.5 text-[13px] font-medium transition-colors"
            style={{
              borderColor: tab === k ? 'var(--accent)' : 'transparent',
              color: tab === k ? 'var(--fg)' : 'var(--fg-3)',
            }}>{label}</button>
        ))}
      </div>

      {tab === 'params' ? <ParamsPanel st={st} rt={rt} availG={availG} busy={busy} act={act} setConfirm={setConfirm} imgOn={imgOn} cy={cy} presets={presets} />
        : tab === 'charts' ? <TrendPanel ctxTotal={ctxTotal} imgOn={imgOn} />
          : <LogsPanel imgOn={imgOn} />}

      <ConfirmDialog
        open={!!confirm}
        title={confirm ? confirm.title : ''}
        body={confirm ? confirm.body : ''}
        confirmWord={confirm ? confirm.confirmWord : undefined}
        confirmLabel={confirm ? confirm.confirmLabel : '确认'}
        onCancel={() => setConfirm(null)}
        onConfirm={() => { const c = confirm; setConfirm(null); c.run(); }}
      />
    </div>
  );
}

/* ── 详情 ───────────────────────────────────────────────── */
function DetailPanel({ which, st, rt, slot, life, reqs, usedG, availG, totalG, cacheG, kvPerTokenB, kvFullG, llm, emb, cy, onClose, onDropCaches, dropping }) {
  let title = '';
  let body = null;
  const two = 'grid gap-x-8 sm:grid-cols-2';

  if (which === 'infer') {
    const run = (rt && rt.running) || null;
    // 复用的 token 数 = 输入总量 − 真正重算的量。不能用 n_prompt_tokens_cache，
    // 从 Prompt 缓存池恢复的状态不计入那个字段（实测恒为 0）。
    const reusedTokens = slot ? Math.max(0, slot.promptTokens - (slot.processedTokens || 0)) : 0;
    const savedSec = reusedTokens && life.promptTps ? reusedTokens / life.promptTps : null;
    title = '推理详情';
    body = (
      <>
        <div className={two}>
          <div>
            <KV k="当前模型" v={run ? run.modelAlias : '—'} />
            <KV k="量化精度" v={run ? run.ftype : '—'} />
            <KV k="支持输入" v={run && run.modalities
              ? ['文本', run.modalities.vision && '图像', run.modalities.video && '视频'].filter(Boolean).join(' · ') : '—'} />
            <KV k="处理位" v={run ? run.totalSlots + ' 个' : '—'} />
            <KV k="思考链格式" v={run && run.sampling ? run.sampling.reasoningFormat : '—'} />
            <KV k="采样温度" v={run && run.sampling ? run.sampling.temperature : '—'} />
          </div>
          <div>
            <KV k="本次输入" v={slot ? tokK(slot.promptTokens) + ' tokens' : '空闲'} />
            <KV k="其中复用缓存" v={slot ? tokK(reusedTokens) + ' tokens' : '—'} level="accent" />
            <KV k="实际重新计算" v={slot ? tokK(slot.processedTokens) + ' tokens' : '—'} />
            <KV k="节省的 Prefill 时间" v={savedSec ? '约 ' + fmt(savedSec, 1) + ' 秒' : '—'} />
            <KV k="TTFT 中位数" v={reqs.ttftP50 != null ? ms(reqs.ttftP50) : '—'} />
            <KV k="TTFT P95" v={reqs.ttftP95 != null ? ms(reqs.ttftP95) : '—'} />
          </div>
        </div>
        {reqs.last && reqs.last.length ? (
          <>
            <div className="mt-3 mb-1 text-[11.5px]" style={{ color: 'var(--fg-2)' }}>最近的请求</div>
            <div className="overflow-x-auto">
              <table className="tnum w-full text-[11.5px]">
                <thead>
                  <tr style={{ color: 'var(--fg-3)' }}>
                    <th className="py-1 pr-3 text-left font-medium">时间</th>
                    <th className="py-1 pr-3 text-left font-medium">模型</th>
                    <th className="py-1 pr-3 text-right font-medium">首 Token</th>
                    <th className="py-1 pr-3 text-right font-medium">总耗时</th>
                    <th className="py-1 text-right font-medium">结果</th>
                  </tr>
                </thead>
                <tbody>
                  {reqs.last.map((r, i) => (
                    <tr key={i} className="border-t" style={{ borderColor: 'var(--line-soft)' }}>
                      <td className="py-1 pr-3">{new Date(r.at).toLocaleTimeString('zh-CN')}</td>
                      <td className="py-1 pr-3 truncate" style={{ maxWidth: 200 }}>{r.model || '—'}</td>
                      <td className="py-1 pr-3 text-right">{r.ttftMs != null ? ms(r.ttftMs) : '—'}</td>
                      <td className="py-1 pr-3 text-right">{ms(r.totalMs)}</td>
                      <td className="py-1 text-right"
                        style={{ color: r.status === 499 ? 'var(--warn)' : r.status >= 400 ? 'var(--bad)' : 'var(--fg-3)' }}>
                        {r.status === 499 ? '客户端断开' : r.status}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </>
    );
  } else if (which === 'ctx') {
    title = '上下文详情';
    body = (
      <div className={two}>
        <div>
          <KV k="上限" v={ctxK(slot ? slot.nCtx : st.config.ctx) + ' tokens'} />
          <KV k="当前已用" v={slot ? tokK(slot.used) + ' tokens' : '空闲'} />
          <KV k="剩余可容纳" v={slot ? tokK(slot.remain) + ' tokens' : '—'} level="accent" />
          <KV k="约合中文" v={slot ? tokK(slot.remain * CHARS_PER_TOKEN) + ' 字' : '—'} />
        </div>
        <div>
          {/* 这三项都依赖「每 token 多少字节」这个实测系数。当前模型没测过就一律显示"—"，
              不拿别的模型的系数硬算——算出来的 GB 数会与用户眼前的内存读数对不上。 */}
          <KV k="每 token 缓存开销" v={kvPerTokenB
            ? fmt(kvPerTokenB / 1024, 0) + ' KB' + (st.config.cacheTypeK === 'q8_0' ? '（已压缩）' : '（未压缩）')
            : '当前模型未实测'} />
          <KV k="满载 KV 占用" v={kvFullG === null ? '—' : fmt(kvFullG, 2) + ' GB'} />
          <KV k="当前 KV 占用" v={slot && kvPerTokenB ? fmt((slot.used * kvPerTokenB) / 1073741824, 2) + ' GB' : '—'} />
          <KV k="Prompt 缓存池" v={(rt ? rt.promptCacheMiB : '—') + ' MB'} />
          {/* 池子容量按 token 折算才有判断价值：单看 MB 数看不出装不装得下自己的会话。
              整份会话状态比裸 KV 大得多，所以这里不能用上面那个每 token 开销去除。 */}
          <KV k="池内可存会话" v={(() => {
            const psB = (rt && rt.promptStateBytesPerToken) || 0;
            const mib = rt && rt.promptCacheMiB;
            if (!psB || !mib) return '—';
            return '至多 ' + tokK(Math.floor((mib * 1048576) / psB)) + ' tokens';
          })()} />
        </div>
      </div>
    );
  } else if (which === 'mem') {
    const g = st.guard || {};
    const otherG = Math.max(0, usedG - GiB(llm.realB || 0) - GiB(emb.realB || 0));
    title = '内存详情';
    body = (
      <div className={two}>
        <div>
          <KV k="总容量" v={fmt(totalG) + ' GB'} />
          <KV k="已用" v={fmt(usedG) + ' GB'} />
          <KV k="剩余可分配" v={fmt(availG, 2) + ' GB'} level="accent" />
          <KV k="可回收文件缓存" v={fmt(cacheG) + ' GB'} />
          <KV k="交换分区" v={st.mem.swapTotalKB ? fmt(fromKB(st.mem.swapTotalKB)) + ' GB' : '未配置'} />
          <KV k="低内存保护" v={g.enabled ? `低于 ${g.softGiB} GB 自动重启` : '未启用'} />
        </div>
        <div>
          <KV k="推理服务合计" v={fmt(GiB(llm.realB || 0)) + ' GB'} />
          <KV k="　GPU 映射内存" v={fmt(GiB(llm.gpuB || 0)) + ' GB'} />
          <KV k="　进程内存" v={fmt(GiB(llm.hostB || 0)) + ' GB'} />
          <KV k="Embedding 合计" v={fmt(GiB(emb.realB || 0)) + ' GB'} />
          <KV k="　GPU 映射内存" v={fmt(GiB(emb.gpuB || 0)) + ' GB'} />
          <KV k="系统与其它" v={fmt(otherG) + ' GB'} />
        </div>
        {/* 文件缓存的说明与操作放在这一层（详情），不放概览卡：
            它需要一句话讲清"不是泄漏"，概览层塞不下也不该塞。 */}
        <div className="col-span-full mt-1 pt-2" style={{ borderTop: '1px solid var(--line)' }}>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--fg-2)' }}>
              文件缓存当前 <b>{fmt(cacheG)} GB</b>，是内核为读过的文件留的副本，
              <b>内存不够时会自动回收，不是泄漏</b>。平时不必处理。
              不过「剩余可分配」是内核的保守估算，手动清理后这个数还会再涨一些
              （实测一次：清理 3.95 GB，可分配从 5.51 升到 9.19 GB）。
              所以在<b>切换模式或加载大模型之前</b>清一次是有意义的；
              代价是下次读模型要重新走磁盘，加载会慢一点。
            </div>
            {onDropCaches ? (
              <Btn onClick={onDropCaches} disabled={dropping}>{dropping ? '清理中' : '清理缓存'}</Btn>
            ) : null}
          </div>
        </div>
      </div>
    );
  } else if (which === 'imgspeed' || which === 'imgcall') {
    /* 生图的两张卡共用一个详情：数据同源，分两个面板反而要用户点两次才看全 */
    const c = cy || {};
    title = '生图任务详情';
    body = (
      <>
        <div className={two}>
          <div>
            <KV k="执行中" v={(c.running ?? '—') + ' 个'} level={c.running > 0 ? 'accent' : undefined} />
            <KV k="排队" v={(c.pending ?? '—') + ' 个'} />
            <KV k="任务数" v={(c.jobs ?? '—') + ' 次'} />
            <KV k="其中失败" v={(c.failed ?? '—') + ' 次'} level={c.failed > 0 ? 'warn' : undefined} />
            <KV k="已出图" v={(c.images ?? '—') + ' 张'} />
          </div>
          <div>
            <KV k="最近一次耗时" v={c.lastSec != null ? fmt(c.lastSec, 1) + ' 秒' : '—'} />
            <KV k="平均耗时" v={c.avgSec != null ? fmt(c.avgSec, 1) + ' 秒' : '—'} />
            <KV k="最近调用模型" v={c.lastModel || '—'} />
            <KV k="工作流节点数" v={c.lastNodes ? c.lastNodes + ' 个' : '—'} />
            <KV k="最近完成时间" v={c.lastAtISO ? new Date(c.lastAtISO).toLocaleString('zh-CN') : '—'} />
          </div>
        </div>
        <div className="mt-2 pt-2 text-[11.5px] leading-relaxed"
          style={{ borderTop: '1px solid var(--line)', color: 'var(--fg-2)' }}>
          以上数字来自生图服务自己的任务记录，<b>重启生图服务后归零</b>，不是历史总量。
          首张图含模型载入，耗时明显高于后续；换工作流或换模型后第一张同理。
          任务的完整日志在生图界面里查看。
        </div>
      </>
    );
  } else if (which === 'temp') {
    const t = st.thermal;
    const order = ['tj', 'GPU', 'CPU', 'SOC0', 'SOC1', 'SOC2', 'CV0', 'CV1', 'CV2'];
    const label = { tj: '整体', GPU: 'GPU', CPU: 'CPU', SOC0: '主控 1', SOC1: '主控 2', SOC2: '主控 3', CV0: '视觉核 1', CV1: '视觉核 2', CV2: '视觉核 3' };
    const keys = Object.keys(t).sort((a, b) => (order.indexOf(a) < 0 ? 99 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 99 : order.indexOf(b)));
    const cpus = (st.tegra && st.tegra.cpu) || [];
    title = '温度与负载详情';
    body = (
      <>
        <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(88px,1fr))' }}>
          {keys.map((k) => (
            <div key={k} className="rounded-md px-2 py-1.5" style={{ background: 'var(--surface-2)' }}
              title={`${label[k] || k} 温度传感器`}>
              <div className="text-[10.5px]" style={{ color: 'var(--fg-3)' }}>{label[k] || k}</div>
              <div className="tnum text-[15px] font-semibold"
                style={{ color: t[k] >= 92 ? 'var(--bad)' : t[k] >= 80 ? 'var(--warn)' : 'var(--fg)' }}>
                {fmt(t[k])}°
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 text-[11.5px]" style={{ color: 'var(--fg-2)' }}>CPU 各核心负载（灰色为系统保留，不参与推理）</div>
        <div className="mt-1.5 flex h-[36px] items-end gap-[3px]">
          {cpus.map((c, i) => (
            <div key={i} title={`核心 ${i}：${c.pct || 0}% @ ${c.mhz || '?'} MHz`}
              className="flex-1 rounded-t-sm"
              style={{ height: Math.max(2, c.pct || 0) + '%', background: i === 5 ? 'var(--fg-3)' : 'var(--accent)', opacity: i === 5 ? 0.35 : 1 }} />
          ))}
        </div>
        <StatGrid items={[
          { k: '平均占用', v: cpus.length ? fmt(cpus.reduce((a, c) => a + (c.pct || 0), 0) / cpus.length, 0) : '—', u: '%' },
          { k: '主频', v: cpus[0] ? cpus[0].mhz : '—', u: 'MHz', title: '已锁定在性能档，不随负载升降。' },
          { k: '1 分钟负载', v: fmt(st.load.m1, 2), title: '最近 1 分钟内可运行与不可中断任务数的平均值。' },
          { k: '5 分钟负载', v: fmt(st.load.m5, 2) },
          { k: '15 分钟负载', v: fmt(st.load.m15, 2) },
        ]} />
      </>
    );
  }

  return (
    <div className="mb-3 rounded-[10px] border p-4" style={{ background: 'var(--surface)', borderColor: 'var(--accent)' }}>
      <div className="mb-1.5 flex items-center justify-between">
        <h2 className="m-0 text-[12.5px] font-semibold" style={{ color: 'var(--fg-2)' }}>{title}</h2>
        <button onClick={onClose} className="text-[11.5px]" style={{ color: 'var(--fg-3)' }}>收起</button>
      </div>
      {body}
    </div>
  );
}

/* ── 模型与参数 ─────────────────────────────────────────── */
/* 换对话模型本体的地方就在这一页（2026-08-19 加）。此前它被放在概览区的
   「模型配置」卡里，和「同一个模型的两种加载档」并列成三个按钮——那张卡管的是
   "当前模型怎么跑"，把"换成另一个模型"混进去，位置就错了。 */
function ModelSwitchCard({ presets, busy, act, setConfirm }) {
  const pr = presets && presets.presets;
  if (!pr) return null;
  const active = pr.mtp && pr.mtp.active ? 'mtp' : pr.mm && pr.mm.active ? 'mm' : pr.q38 && pr.q38.active ? 'q38' : 'custom';
  const q36 = active === 'mtp' || active === 'mm';
  const ready = (k) => !!(pr[k] && pr[k].modelReady);
  return (
    <Card className="mb-3">
      <CardTitle hint="切换会重启推理服务并重新载入权重，期间无法对话。加载档位（同一模型的不同跑法）在上方「模型配置」卡里调。">
        对话模型
      </CardTitle>
      <StatGrid cols="repeat(auto-fit,minmax(150px,1fr))" items={[
        { k: 'Qwen3.6-35B-A3B', v: q36 ? '使用中' : ready('mtp') || ready('mm') ? '就绪' : '模型文件缺失',
          level: q36 ? 'ok' : 'idle',
          title: '35B 稀疏 MoE（激活 3B）。生成 26~33 tok/s，上下文 128K，支持图像识别。\n有两个加载档：MTP 加速 / 多模态加速，在上方「模型配置」卡里切。' },
        { k: 'Qwen3.8-27B', v: active === 'q38' ? '使用中' : ready('q38') ? '就绪' : '模型文件缺失',
          level: active === 'q38' ? 'ok' : 'idle',
          title: '27B 密集 + SSM 混合架构。生成 10~12 tok/s，预填充 244 tok/s，上下文 64K，不支持图像识别。\n速度不如 3.6，胜在密集模型的回答质量与稳定的中文思考。' },
      ]} />
      <div className="mt-2.5 flex flex-wrap gap-2">
        <Btn kind={q36 ? undefined : 'primary'}
          disabled={busy !== '' || q36 || !ready('mtp')}
          onClick={() => setConfirm({
            title: '换成 Qwen3.6-35B-A3B',
            body: '重启推理服务并加载 Qwen3.6-35B-A3B（MTP 加速档），期间约 1.5 分钟无法对话。生成 26~33 tok/s，上下文 128K，支持图像识别。',
            confirmLabel: '换成 Qwen3.6',
            run: () => act('换成 Qwen3.6-35B-A3B', () => api.applyPreset('mtp')),
          })}>换成 Qwen3.6-35B-A3B</Btn>
        <Btn kind={q36 ? 'primary' : undefined}
          disabled={busy !== '' || active === 'q38' || !ready('q38')}
          onClick={() => setConfirm({
            title: '换成 Qwen3.8-27B',
            body: '重启推理服务并加载 Qwen3.8-27B，期间约 75 秒无法对话。生成 10~12 tok/s（Qwen3.6 的 MTP 档是 26~33），上下文 64K，不支持图像识别。',
            confirmLabel: '换成 Qwen3.8-27B',
            run: () => act('换成 Qwen3.8-27B', () => api.applyPreset('q38')),
          })}>换成 Qwen3.8-27B</Btn>
      </div>
      <div className="mt-2 text-[12px]" style={{ color: 'var(--fg-3)' }}>
        换模型会一并换掉上下文长度与采样参数（每个模型有自己的一套预设），下面这一页显示的就是切换后的值。
      </div>
    </Card>
  );
}

function ParamsPanel({ st, rt, availG, busy, act, setConfirm, imgOn, cy, presets }) {
  const cfg = st.config || {};
  const run = (rt && rt.running) || null;
  const [f, setF] = useState(null);
  const [adv, setAdv] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (dirty) return;
    setF({
      model: cfg.model || '', mmproj: cfg.mmproj || '', backend: cfg.backend || 'cuda',
      ctx: cfg.ctx || 32768, ngl: cfg.ngl ?? 99, threads: cfg.threads || 4,
      parallel: cfg.parallel || 1, cacheTypeK: cfg.cacheTypeK || '',
      batchSize: cfg.batchSize || '', ubatchSize: cfg.ubatchSize || '',
      cacheRamMiB: cfg.cacheRamMiB ?? 512, bindHost: cfg.bindHost || '0.0.0.0',
      reasoningFormat: cfg.reasoningFormat || '', requireLoginOnLan: cfg.requireLoginOnLan === true,
    });
  }, [st.config, dirty]);

  if (!f) return null;
  const set = (k) => (e) => {
    setDirty(true);
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setF((p) => ({ ...p, [k]: v }));
  };

  /* 改上下文长度会多吃多少内存，取决于当前模型每 token 的 KV 字节数。
     后端没有该模型的实测值时（rt.kvBytesPerToken 为 null），**不做估算也不报警**——
     用别的模型的系数算出来的警告会误导人去改一个本来能跑的配置（陷阱 52 同类）。 */
  const perTokenB = (rt && Number.isFinite(rt.kvBytesPerToken)) ? rt.kvBytesPerToken : null;
  const kvNeedG = perTokenB ? (Number(f.ctx) * perTokenB) / 1073741824 : null;
  const kvNowG = perTokenB ? ((run ? run.nCtx : cfg.ctx) * perTokenB) / 1073741824 : null;
  const deltaG = perTokenB ? kvNeedG - kvNowG : null;
  const tooBig = deltaG !== null && deltaG > 0 && deltaG > availG - 0.3;

  const now = (v) => (
    <span className="tnum whitespace-nowrap text-[11.5px]" style={{ color: 'var(--fg-3)' }} title="当前实际运行中的值">
      {v === undefined || v === null || v === '' ? '—' : v}
    </span>
  );

  const save = (restart) => act(restart ? '保存并重启推理服务' : '保存配置', async () => {
    await api.saveConfig({
      model: f.model, mmproj: f.mmproj, backend: f.backend,
      ctx: Number(f.ctx), ngl: Number(f.ngl), threads: Number(f.threads), parallel: Number(f.parallel),
      cacheTypeK: f.cacheTypeK, cacheTypeV: f.cacheTypeK, flashAttn: f.cacheTypeK ? 'on' : '',
      batchSize: f.batchSize === '' ? undefined : Number(f.batchSize),
      ubatchSize: f.ubatchSize === '' ? undefined : Number(f.ubatchSize),
      cacheRamMiB: Number(f.cacheRamMiB), bindHost: f.bindHost,
      reasoningFormat: f.reasoningFormat, requireLoginOnLan: !!f.requireLoginOnLan,
    });
    setDirty(false);
    if (restart) await api.serviceAction('llm-server', 'restart');
  });

  /* 只列能独立对话的模型。kind 由后端给（mmproj / draft / chat），
     前端不再各写一套正则——草稿模型就是这么漏进来的。老后端没有 kind 时退回按名字判断。 */
  const kindOf = (m) => m.kind || (/mmproj/i.test(m.name) ? 'mmproj'
    : /(dflash|dspark|eagle3?|[-_]draft)/i.test(m.name) ? 'draft'
      : /embedding/i.test(m.name) ? 'embed' : 'chat');
  const models = st.models.filter((m) => kindOf(m) === 'chat');
  const mmprojs = st.models.filter((m) => kindOf(m) === 'mmproj');
  /* 当前配置的模型如果不在扫描目录里（换过目录、文件被挪走），也要让它出现在下拉里并选中。
     否则 select 会静默落到第一项，显示的模型和实际跑的不是一个，一点保存就把模型改了。 */
  const curMissing = f.model && !models.some((m) => m.path === f.model);
  const grid = { gridTemplateColumns: 'max-content minmax(0,1fr) max-content' };

  return (
    <>
    {/* 生图模式下这一整页调的都是对话模型的参数，而对话模型是停着的——
        不说清楚的话，用户会以为在调生图参数，改完发现"没反应"。
        生图的参数不在面板里：它们写在工作流节点上，在生图界面里改。 */}
    {/* 生图模式下对话模型停着，换模型没有意义，这张卡不出现 */}
    {imgOn ? null : <ModelSwitchCard presets={presets} busy={busy} act={act} setConfirm={setConfirm} />}
    {imgOn ? (
      <Card className="mb-3">
        <CardTitle>生图运行信息</CardTitle>
        <StatGrid cols="repeat(auto-fit,minmax(120px,1fr))" items={[
          { k: '最近调用模型', v: prettyName(cy && cy.lastModel) || '—',
            title: cy && cy.lastModel ? '文件名：' + cy.lastModel : '还没有执行过任务。' },
          { k: '工作流节点', v: cy && cy.lastNodes ? cy.lastNodes : '—', u: cy && cy.lastNodes ? '个' : '' },
          { k: '已出图', v: cy ? cy.images : '—', u: '张' },
          { k: '平均耗时', v: cy && cy.avgSec != null ? fmt(cy.avgSec, 1) : '—', u: cy && cy.avgSec != null ? '秒' : '' },
        ]} />
        <div className="mt-2 text-[12px] leading-relaxed" style={{ color: 'var(--fg-3)' }}>
          生图的参数（模型、采样器、步数、分辨率、LoRA）都写在工作流的节点上，
          在生图界面里改，面板不代为设置。下面这一页是<b>对话模型</b>的参数，
          当前对话模型已停止，改动会在下次启动推理服务时生效。
        </div>
      </Card>
    ) : null}
    <Card>
      <CardTitle right={<span className="text-[11px]" style={{ color: 'var(--fg-3)' }}>右列为当前实际运行值</span>}>
        {imgOn ? '对话模型参数（当前未运行）' : '常用参数'}
      </CardTitle>

      <div className="grid items-center gap-x-3 gap-y-2.5" style={grid}>
        <Field label="模型">
          <select className={inputCls} style={inputStyle} value={f.model} onChange={set('model')}>
            {curMissing ? (
              <option value={f.model}>{f.model.split('/').pop()}（当前，不在扫描目录内）</option>
            ) : null}
            {models.length ? models.map((m) => (
              <option key={m.path} value={m.path}>{m.name}（{fmt(GiB(m.sizeB))} GB）</option>
            )) : <option value="">设备上没有可用模型</option>}
          </select>
        </Field>
        {now(run ? run.modelAlias : null)}

        <Field label="图像理解" hint="加载视觉投影模块（mmproj），启用后模型可处理图像输入。留空则不加载，相应减少内存占用。">
          <select className={inputCls} style={inputStyle} value={f.mmproj} onChange={set('mmproj')}>
            <option value="">不启用</option>
            {mmprojs.map((m) => <option key={m.path} value={m.path}>{m.name}</option>)}
          </select>
        </Field>
        {now(run && run.modalities && run.modalities.vision ? '已启用' : '未启用')}

        <Field label="上下文长度" hint={T.ctx + ' 填 131072 就是 128K。'}>
          <input type="number" step="4096" min="1024" className={inputCls} style={inputStyle} value={f.ctx} onChange={set('ctx')} />
        </Field>
        {now(run ? ctxK(run.nCtx) : null)}

        <Field label="KV 缓存压缩" hint="以 q8_0 精度存储 KV 缓存，占用约为 f16 的一半。实测生成速度无明显变化。">
          <select className={inputCls} style={inputStyle} value={f.cacheTypeK} onChange={set('cacheTypeK')}>
            <option value="q8_0">开启（占用减半）</option>
            <option value="">关闭</option>
          </select>
        </Field>
        {now(cfg.cacheTypeK === 'q8_0' ? '已开启' : '关闭')}

        <Field label="处理位" hint={T.slot + ' 设为 2 时，单个请求可用的上下文减半，超长输入将无法容纳。'}>
          <input type="number" min="1" max="8" className={inputCls} style={inputStyle} value={f.parallel} onChange={set('parallel')} />
        </Field>
        {now(run ? run.totalSlots : null)}

        <Field label="运算设备" hint="默认使用 GPU。CPU 为故障回退选项，实测生成速度约为 GPU 的三分之一。">
          <select className={inputCls} style={inputStyle} value={f.backend} onChange={set('backend')}>
            <option value="cuda">GPU</option>
            <option value="cpu">CPU（较慢，故障回退用）</option>
          </select>
        </Field>
        {now(cfg.backend === 'cuda' ? 'GPU' : 'CPU')}
      </div>

      <div className="mt-3 rounded-lg px-3 py-2 text-[12.5px]"
        style={{ background: tooBig ? 'var(--bad-bg)' : 'var(--surface-2)', color: tooBig ? 'var(--bad)' : 'var(--fg-2)' }}>
        {perTokenB === null
          ? `设备剩余 ${fmt(availG, 2)} GB。当前模型每 token 的 KV 字节数还没有实测值，这里不估算上下文长度带来的内存变化——改大之后请看重启日志确认是否载入成功。`
          : tooBig
            ? `按当前设置，KV 缓存需要 ${fmt(kvNeedG, 2)} GB，比现在多占 ${fmt(deltaG, 2)} GB，而设备只剩 ${fmt(availG, 2)} GB。保存并重启后推理服务会启动失败。`
            : `KV 缓存预计占用 ${fmt(kvNeedG, 2)} GB${Math.abs(deltaG) > 0.05 ? `（较当前${deltaG > 0 ? '增加' : '减少'} ${fmt(Math.abs(deltaG), 2)} GB）` : '，与当前相同'}，设备剩余 ${fmt(availG, 2)} GB。`}
      </div>

      <button onClick={() => setAdv((v) => !v)} className="mt-3 self-start text-[12.5px] underline underline-offset-2"
        style={{ color: 'var(--accent)' }}>{adv ? '收起进阶参数' : '进阶参数'}</button>

      {adv ? (
        <div className="mt-2.5 grid items-center gap-x-3 gap-y-2.5" style={grid}>
          <Field label="Batch 大小" hint="单次 decode 调用处理的最大 token 数（逻辑批）。增大可提升长输入的 Prefill 速度，同时增加内存占用。留空为默认值 2048。">
            <input type="number" className={inputCls} style={inputStyle} placeholder="默认 2048" value={f.batchSize} onChange={set('batchSize')} />
          </Field>
          {now(cfg.batchSize || '默认')}

          <Field label="uBatch 大小" hint="单次提交给 GPU 的 token 数（物理批），不超过 Batch 大小。留空为默认值 512。">
            <input type="number" className={inputCls} style={inputStyle} placeholder="默认 512" value={f.ubatchSize} onChange={set('ubatchSize')} />
          </Field>
          {now(cfg.ubatchSize || '默认')}

          <Field label="Prompt 缓存池" hint="保存已计算的输入状态，相同开头的请求可直接复用。单位 MB，0 为关闭。128K 上下文下单条状态占一两百 MB，池容量不足时按最旧优先淘汰。当前值 1024 对应剩余内存约 1.5 GB。">
            <input type="number" className={inputCls} style={inputStyle} value={f.cacheRamMiB} onChange={set('cacheRamMiB')} />
          </Field>
          {now((cfg.cacheRamMiB ?? 1024) + ' MB')}

          <Field label="GPU 层数" hint="卸载到 GPU 的模型层数，99 表示全部层。降低此值会将部分层交给 CPU 计算。">
            <input type="number" className={inputCls} style={inputStyle} value={f.ngl} onChange={set('ngl')} />
          </Field>
          {now(cfg.ngl)}

          <Field label="CPU 线程" hint="CPU 侧计算使用的线程数。GPU 承担全部层时，CPU 仅参与采样，实测调整此值对速度无明显影响。">
            <input type="number" className={inputCls} style={inputStyle} value={f.threads} onChange={set('threads')} />
          </Field>
          {now(cfg.threads)}

          <Field label="思考链格式" hint="决定思考内容以何种形式返回。deepseek-legacy 同时填充 content 中的标签与 reasoning_content 字段，两类客户端均可解析。">
            <select className={inputCls} style={inputStyle} value={f.reasoningFormat} onChange={set('reasoningFormat')}>
              <option value="deepseek-legacy">deepseek-legacy（兼容性最好）</option>
              <option value="deepseek">deepseek（独立字段）</option>
              <option value="none">none（不分离）</option>
              <option value="">自动</option>
            </select>
          </Field>
          {now(run && run.sampling ? run.sampling.reasoningFormat : null)}

          <Field label="模型接口监听" hint="设为「仅本机」后，8080 与 8081 只接受本机连接，模型接口须经本面板访问。切换前请确认没有其它设备直连这两个端口。">
            <select className={inputCls} style={inputStyle} value={f.bindHost} onChange={set('bindHost')}>
              <option value="0.0.0.0">局域网可直连</option>
              <option value="127.0.0.1">仅本机</option>
            </select>
          </Field>
          {now(cfg.bindHost || '0.0.0.0')}

          <Field label="局域网也要登录" hint="开启后，从局域网访问面板同样需要输入密码。公网访问始终需要登录。">
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={f.requireLoginOnLan} onChange={set('requireLoginOnLan')} />需要登录
            </label>
          </Field>
          {now(cfg.requireLoginOnLan ? '要求登录' : '免登录')}
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Btn disabled={busy !== '' || tooBig} onClick={() => save(false)}>仅保存</Btn>
        <Btn kind="primary" disabled={busy !== '' || tooBig} onClick={() => save(true)}>保存并重启推理服务</Btn>
        <Btn kind="danger" disabled={busy !== ''}
          onClick={() => setConfirm({
            title: '恢复上一次的参数',
            body: '丢弃当前配置，恢复上一次保存前的参数并重启推理服务。适用于参数修改后服务无法启动的情况。',
            confirmLabel: '恢复并重启',
            run: () => { setDirty(false); act('恢复上一次的参数', api.rollbackConfig); },
          })}>恢复上一次的参数</Btn>
        {dirty ? <span className="text-[12px]" style={{ color: 'var(--warn)' }}>有未保存的修改</span> : null}
      </div>
    </Card>
    </>
  );
}

/* ── 历史趋势 ───────────────────────────────────────────── */
const RANGES = [[5, '5 分钟'], [30, '30 分钟'], [60, '1 小时'], [180, '3 小时'], [360, '6 小时']];

function TrendPanel({ ctxTotal, imgOn }) {
  const [minutes, setMinutes] = useState(60);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const pull = useCallback(async () => {
    try { setData(await api.getHistory(minutes)); setError(''); }
    catch (e) { setError(e.message); }
  }, [minutes]);

  useEffect(() => { pull(); const t = setInterval(pull, 15000); return () => clearInterval(t); }, [pull]);

  if (error) return <Card><Banner>{'读取历史数据失败：' + error}</Banner></Card>;
  if (!data) return <Card><Meta>正在读取历史数据…</Meta></Card>;

  const p = data.points || [];
  const A = 'var(--accent)';
  const W = 'var(--warn)';

  /* 「推理速度」「上下文占用」两张图的数据来自对话模型，生图模式下它是停着的，
     画出来就是两条贴着零轴的直线——占了半屏却什么都没说。这时直接不渲染。
     生图任务的耗时不在这里：采样是每 10 秒一次，而出图是几十秒一单，
     画成曲线没有意义，改在上方「累计用量」卡里给最近/平均耗时。 */
  const charts = [
    ...(imgOn ? [] : [{
      title: '推理速度', unit: ' tokens/s',
      hint: T.decode + ' ' + T.prefill + ' 无请求的时段速度为零。',
      series: [
        { label: '生成', color: A, fill: true, points: ratesFrom(p, 'gTok', 'gSec') },
        { label: 'Prefill', color: W, points: ratesFrom(p, 'pTok', 'pSec') },
      ],
    }]),
    {
      title: 'Embedding 速度', unit: ' tokens/s',
      hint: T.embTps + ' 无请求的时段曲线为零。',
      series: [{ label: 'Embedding', color: A, fill: true, points: ratesFrom(p, 'ePTok', 'ePSec') }],
    },
    ...(imgOn ? [] : [{
      title: '上下文占用', unit: ' tokens', fmtY: (v) => tokK(v),
      hint: T.ctx + ' 曲线归零表示会话已结束，占用的 KV 缓存被释放。',
      yMax: ctxTotal || undefined,
      series: [{ label: '已用', color: A, fill: true, points: seriesFrom(p, 'ctx') }],
    }]),
    {
      title: '剩余内存', unit: ' GB', fmtY: (v) => v.toFixed(1),
      hint: T.avail + ' ' + T.guard,
      series: [{ label: '剩余可分配', color: A, fill: true, points: seriesFrom(p, 'availKB', 1 / 1048576) }],
    },
    {
      title: '温度', unit: ' °C', fmtY: (v) => v.toFixed(0),
      hint: T.tj,
      series: [{ label: '结温', color: W, fill: true, points: seriesFrom(p, 'tj') }],
    },
    {
      title: 'GPU 占用', unit: ' %', yMax: 100, fmtY: (v) => v.toFixed(0),
      hint: T.gpu,
      series: [{ label: 'GPU', color: A, fill: true, points: seriesFrom(p, 'gr3d') }],
    },
  ];

  return (
    <div>
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <span className="text-[12.5px]" style={{ color: 'var(--fg-2)' }}>时间范围</span>
        {RANGES.map(([m, label]) => (
          <button key={m} onClick={() => setMinutes(m)}
            className="rounded-md border px-2.5 py-1 text-[12px] transition-colors"
            style={{
              background: minutes === m ? 'var(--accent-soft)' : 'var(--surface-2)',
              borderColor: minutes === m ? 'var(--accent)' : 'var(--line)',
              color: minutes === m ? 'var(--accent)' : 'var(--fg-2)',
            }}>{label}</button>
        ))}
        <span className="ml-auto text-[11.5px]" style={{ color: 'var(--fg-3)' }}
          title="采样数据保存在内存中，最长保留 6 小时，面板重启后清空。">
          {p.length} 个采样点 · 每 {Math.round((data.stepMs || 10000) / 1000)} 秒一次
        </span>
      </div>

      <div className="cardgrid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(420px,1fr))' }}>
        {charts.map((c) => (
          <Card key={c.title}>
            <CardTitle hint={c.hint}>{c.title}</CardTitle>
            <TimeChart series={c.series} unit={c.unit} yMax={c.yMax} fmtY={c.fmtY} />
          </Card>
        ))}
      </div>
    </div>
  );
}

/* ── 运行日志 ───────────────────────────────────────────── */
const LOG_UNITS = [
  ['llm-server', '推理服务'],
  ['comfyui', '生图服务'],
  ['llm-embedding', 'Embedding 服务'],
  ['iecu-frpc', '远程隧道'],
  ['iecu-panel', '本面板'],
  ['application_start', '车机软件'],
];

const LEVEL_STYLE = {
  ok: 'var(--ok)', warn: 'var(--warn)', bad: 'var(--bad)',
  info: 'var(--fg)', dim: 'var(--fg-3)', plain: 'var(--fg-2)',
};

function LogsPanel({ imgOn }) {
  /* 默认选当前模式对应的服务：生图模式下默认停着推理服务，
     打开日志页却默认显示它的日志，看到的只有"已停止"，没有意义 */
  const [unit, setUnit] = useState(imgOn ? 'comfyui' : 'llm-server');
  const [n, setN] = useState(200);
  const [text, setText] = useState('');
  const [raw, setRaw] = useState(false);
  const [auto, setAuto] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const boxRef = useRef(null);

  const pull = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const r = await api.getLogs(unit, n);
      setText(r.text || '');
      requestAnimationFrame(() => { if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight; });
    } catch (e) { setError(e.message); }
    setLoading(false);
  }, [unit, n]);

  useEffect(() => { pull(); }, [pull]);
  useEffect(() => {
    if (!auto) return undefined;
    const t = setInterval(pull, 5000);
    return () => clearInterval(t);
  }, [auto, pull]);

  const rows = raw ? null : translateLog(text);
  const rawCount = String(text || '').split('\n').filter((l) => l.trim()).length;

  return (
    <Card>
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <select className="rounded-md border px-2 py-[5px] text-[13px]" style={inputStyle}
          value={unit} onChange={(e) => setUnit(e.target.value)}>
          {LOG_UNITS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
        <select className="rounded-md border px-2 py-[5px] text-[13px]" style={inputStyle}
          value={n} onChange={(e) => setN(Number(e.target.value))}>
          {[100, 200, 500, 1000].map((v) => <option key={v} value={v}>最近 {v} 行</option>)}
        </select>
        <Btn onClick={pull} disabled={loading}>{loading ? '读取中…' : '刷新'}</Btn>
        <label className="flex items-center gap-1.5 text-[12.5px]" style={{ color: 'var(--fg-2)' }}>
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />每 5 秒刷新
        </label>
        <label className="flex items-center gap-1.5 text-[12.5px]" style={{ color: 'var(--fg-2)' }}
          title="勾选后显示服务输出的原始日志，不做中文改写与过滤。">
          <input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} />显示原文
        </label>
        {!raw && rows ? (
          <span className="ml-auto text-[11.5px]" style={{ color: 'var(--fg-3)' }}
            title="显示行数 / 原始总行数。已隐藏逐层加载、内部循环等重复行，勾选「显示原文」查看全部。">
            {rows.length} / {rawCount} 行
          </span>
        ) : null}
      </div>
      {error ? <Banner onClose={() => setError('')}>{'读取日志失败：' + error}</Banner> : null}

      {raw ? (
        <pre ref={boxRef}
          className="m-0 max-h-[420px] overflow-auto whitespace-pre-wrap break-all rounded-md border p-2.5 text-[11.5px] leading-relaxed"
          style={{ background: 'var(--surface-2)', borderColor: 'var(--line)', fontFamily: 'var(--font-mono)' }}>
          {text || (loading ? '正在读取…' : '这段时间没有日志记录。')}
        </pre>
      ) : (
        <div ref={boxRef} className="max-h-[420px] overflow-auto rounded-md border"
          style={{ background: 'var(--surface-2)', borderColor: 'var(--line)' }}>
          {rows && rows.length ? rows.map((r, i) => (
            <div key={i} className="flex gap-2.5 border-b px-2.5 py-[3px] text-[12px] last:border-b-0"
              style={{ borderColor: 'var(--line-soft)' }} title={r.raw}>
              <span className="tnum shrink-0" style={{ color: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}>{r.time}</span>
              <span className="min-w-0 flex-1" style={{ color: LEVEL_STYLE[r.level] || 'var(--fg)' }}>{r.text}</span>
            </div>
          )) : (
            <div className="px-2.5 py-3 text-[12px]" style={{ color: 'var(--fg-3)' }}>
              {loading ? '正在读取…' : '这段时间没有日志记录。'}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
