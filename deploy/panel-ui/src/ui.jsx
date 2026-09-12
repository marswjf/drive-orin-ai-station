/* 基础组件。
 *
 * 上色规则（整套界面只有这一条）：
 *   正常状态一律中性色，颜色只留给需要人处理的事。
 *   蓝色 = 可交互 / 被选中 / 进度填充，不表达好坏；
 *   琥珀 = 需要留意；砖红 = 需要处理；绿色只出现在状态圆点上。
 * 所以 Big 的 level='ok' 渲染出来是中性色，不是绿色——这是有意的。
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export const GiB = (b) => (b / 1073741824);
export const fromKB = (kb) => (kb / 1048576);
export const fmt = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '—');
export const int = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('zh-CN') : '—');

/* 上下文容量按 1024 进制写，131072 就是业内说的 128K。
   token 计数（tokK）也用同一进制，全站不出现两种换算。 */
export const ctxK = (n) => {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1024) return String(Math.round(n));
  const k = n / 1024;
  return (Number.isInteger(k) ? k : k.toFixed(1)) + 'K';
};

/* token 计数与上下文容量统一按 1024 进制。
 * 曾按 1000 进制显示，结果同一屏里出现"已用 0 / 128K、剩余可容纳 131K"——
 * 131072 这个数在分母处按 1024 进制写成 128K，在剩余处按 1000 进制写成 131K，
 * 看上去像是剩余比总量还多。两处必须同进制。 */
export const tokK = (n) => {
  if (!Number.isFinite(n)) return '—';
  const v = Math.round(n);
  const a = Math.abs(v);
  if (a >= 1048576) return (v / 1048576).toFixed(2) + 'M';
  if (a >= 10240) return Math.round(v / 1024) + 'K';
  if (a >= 1024) return (v / 1024).toFixed(1) + 'K';
  return String(v);
};

/* 毫秒 → 人能读的时长 */
export const ms = (v) => {
  if (!Number.isFinite(v)) return '—';
  if (v < 1000) return Math.round(v) + ' ms';
  if (v < 60000) return (v / 1000).toFixed(1) + ' 秒';
  return Math.floor(v / 60000) + ' 分 ' + Math.round((v % 60000) / 1000) + ' 秒';
};

const TEXT_COLOR = { ok: 'var(--fg)', idle: 'var(--fg-3)', warn: 'var(--warn)', bad: 'var(--bad)', accent: 'var(--accent)' };
const FILL_COLOR = { ok: 'var(--accent)', idle: 'var(--fg-3)', warn: 'var(--warn)', bad: 'var(--bad)' };
const DOT_COLOR = { ok: 'var(--ok)', idle: 'var(--fg-3)', warn: 'var(--warn)', bad: 'var(--bad)' };

export function Card({ children, className = '', onClick, active, ...rest }) {
  const clickable = typeof onClick === 'function';
  return (
    <div
      {...rest}
      onClick={onClick}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e); } } : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-expanded={clickable ? !!active : undefined}
      className={'flex h-full flex-col rounded-[10px] border px-4 py-3 transition-colors '
        + (clickable ? 'cursor-pointer hover:border-[color:var(--accent)] ' : '') + className}
      style={{ background: 'var(--surface)', borderColor: active ? 'var(--accent)' : 'var(--line)' }}
    >
      {children}
    </div>
  );
}

export function CardTitle({ children, hint, right }) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5">
      <h2 className="m-0 text-[11.5px] font-semibold tracking-[.04em]" style={{ color: 'var(--fg-2)' }}>{children}</h2>
      {hint ? <Hint text={hint} /> : null}
      {right ? <span className="ml-auto">{right}</span> : null}
    </div>
  );
}

/* 说明浮层。
 * 原生 title 属性要悬停一秒才出现、触摸设备上根本不出现，等于没有说明——
 * 这正是"问号鼠标移上去什么都没有"的原因。这里自己画：hover / 键盘聚焦立即显示，
 * 点击可锁定（触摸设备唯一能用的方式），渲染到 body 上避免被卡片边界裁掉。 */
export function Tip({ text, children, className = '', block = false }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0, above: true });
  const ref = useRef(null);

  const place = () => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const above = r.top > 150;                       // 上方放不下就翻到下面
    const half = 150;
    setPos({
      x: Math.min(Math.max(r.left + r.width / 2, half + 8), window.innerWidth - half - 8),
      y: above ? r.top - 8 : r.bottom + 8,
      above,
    });
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(false);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [open]);

  // 没有说明就不做任何交互，但 block 模式仍要保留外层容器，否则会破坏栅格
  if (!text) return block ? <div className={className}>{children}</div> : children;

  const Wrap = block ? 'div' : 'span';
  return (
    <>
      <Wrap
        ref={ref}
        tabIndex={0}
        className={(block ? '' : 'inline-flex ') + 'cursor-help outline-none ' + className}
        onMouseEnter={place}
        onMouseLeave={() => setOpen(false)}
        onFocus={place}
        onBlur={() => setOpen(false)}
        onClick={(e) => { e.stopPropagation(); if (open) setOpen(false); else place(); }}
      >
        {children}
      </Wrap>
      {open ? createPortal(
        <div
          role="tooltip"
          className="pointer-events-none fixed z-[80] max-w-[300px] rounded-lg border px-2.5 py-2 text-[12px] leading-[1.55] shadow-lg"
          style={{
            left: pos.x, top: pos.y,
            transform: `translate(-50%, ${pos.above ? '-100%' : '0'})`,
            background: 'var(--surface-2)', borderColor: 'var(--line)', color: 'var(--fg)',
          }}
        >{text}</div>, document.body,
      ) : null}
    </>
  );
}

export function Hint({ text }) {
  return (
    <Tip text={text}>
      <span aria-label={text}
        className="inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-full border text-[9px] leading-none"
        style={{ borderColor: 'var(--line)', color: 'var(--fg-3)' }}>?</span>
    </Tip>
  );
}

export function Big({ value, unit, level = 'ok', sub }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="tnum text-[25px] font-semibold leading-none tracking-tight" style={{ color: TEXT_COLOR[level] }}>
        {value}
      </span>
      {unit ? <span className="text-[12.5px]" style={{ color: 'var(--fg-3)' }}>{unit}</span> : null}
      {sub ? <span className="tnum ml-auto text-[12px]" style={{ color: 'var(--fg-2)' }}>{sub}</span> : null}
    </div>
  );
}

/* 需要被一眼看到的第二数字（比如剩余内存）。用蓝色而不是绿色——
   它是"重点"不是"状态好"。真出问题时会被 level 覆盖成琥珀或砖红。 */
export function Focus({ label, value, unit, level = 'accent' }) {
  return (
    <span className="tnum inline-flex items-baseline gap-1">
      <span className="text-[11.5px]" style={{ color: 'var(--fg-3)' }}>{label}</span>
      <b className="text-[14px] font-semibold" style={{ color: TEXT_COLOR[level] }}>{value}</b>
      {unit ? <span className="text-[11px]" style={{ color: 'var(--fg-3)' }}>{unit}</span> : null}
    </span>
  );
}

export function Meta({ children }) {
  return <div className="tnum mt-1.5 text-[11.5px] leading-[1.5]" style={{ color: 'var(--fg-3)' }}>{children}</div>;
}

export function Bar({ pct, level = 'ok', segments }) {
  return (
    <div className="mt-2 flex h-[5px] overflow-hidden rounded-full" style={{ background: 'var(--track)' }}>
      {segments
        ? segments.map((s, i) => (
          <div key={i} title={s.title} className="h-full transition-[width] duration-500"
            style={{ width: Math.max(0, Math.min(100, s.pct)) + '%', background: s.color, opacity: s.dim ? 0.45 : 1 }} />
        ))
        : <div className="h-full rounded-full transition-[width] duration-500"
          style={{ width: Math.max(0, Math.min(100, pct || 0)) + '%', background: FILL_COLOR[level] }} />}
    </div>
  );
}

/* 状态用"圆点 + 文字"，不用整块彩色标签——彩块面积太大，一屏下来全是颜色 */
export function Status({ level = 'idle', children }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium" style={{ color: 'var(--fg-2)' }}>
      <span className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: DOT_COLOR[level] }} />
      {children}
    </span>
  );
}

export function Tag({ children }) {
  return (
    <span className="rounded px-1.5 py-px text-[10.5px] font-medium"
      style={{ background: 'var(--idle-bg)', color: 'var(--fg-3)' }}>{children}</span>
  );
}

/* 密集数据行：监控面板的主力排版单元。标签在上、数值在下，等宽数字对齐。
   带说明的格子在标签后面缀一个虚线下划线记号，指明这里可以看解释——
   没有记号就没有说明，鼠标移上去也不会落空。 */
export function StatGrid({ items, cols = 'repeat(auto-fit,minmax(104px,1fr))' }) {
  return (
    <div className="mt-2 grid gap-x-4 gap-y-2.5" style={{ gridTemplateColumns: cols }}>
      {items.filter(Boolean).map((it, i) => (
        <Tip key={i} text={it.title} block className="min-w-0">
          <div className="truncate text-[10.5px] leading-tight" style={{ color: 'var(--fg-3)' }}>
            <span style={it.title ? { borderBottom: '1px dotted var(--fg-3)' } : undefined}>{it.k}</span>
          </div>
          <div className="tnum truncate text-[13.5px] font-medium leading-snug"
            style={{ color: TEXT_COLOR[it.level || 'ok'] }}>
            {it.v}
            {it.u ? <span className="ml-0.5 text-[10.5px] font-normal" style={{ color: 'var(--fg-3)' }}>{it.u}</span> : null}
          </div>
        </Tip>
      ))}
    </div>
  );
}

export function KV({ k, v, level }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b py-[5px] text-[12.5px] last:border-b-0"
      style={{ borderColor: 'var(--line-soft)' }}>
      <span style={{ color: 'var(--fg-2)' }}>{k}</span>
      <span className="tnum text-right" style={{ color: TEXT_COLOR[level || 'ok'] }}>{v}</span>
    </div>
  );
}

export function Btn({ children, kind = 'normal', ...rest }) {
  const base = 'rounded-md border px-3 py-[5px] text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40';
  const style = kind === 'primary'
    ? { background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--accent-fg)' }
    : kind === 'danger'
      ? { background: 'transparent', borderColor: 'var(--line)', color: 'var(--bad)' }
      : { background: 'var(--surface-2)', borderColor: 'var(--line)', color: 'var(--fg)' };
  return <button {...rest} className={base + ' ' + (rest.className || '')} style={style}>{children}</button>;
}

export function Field({ label, hint, children }) {
  return (
    <>
      <label className="flex items-center gap-1.5 self-center text-[12.5px]" style={{ color: 'var(--fg-2)' }}>
        {label}{hint ? <Hint text={hint} /> : null}
      </label>
      <div className="min-w-0">{children}</div>
    </>
  );
}

export const inputStyle = { background: 'var(--surface-2)', borderColor: 'var(--line)', color: 'var(--fg)' };
export const inputCls = 'w-full rounded-md border px-2 py-[5px] text-[13px]';

export function ConfirmDialog({ open, title, body, confirmWord, confirmLabel = '确认', onCancel, onConfirm }) {
  const [typed, setTyped] = useState('');
  const ref = useRef(null);
  useEffect(() => { if (open) { setTyped(''); setTimeout(() => ref.current && ref.current.focus(), 30); } }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const esc = (e) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [open, onCancel]);
  if (!open) return null;
  const ready = !confirmWord || typed.trim() === confirmWord;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-5" style={{ background: 'rgba(0,0,0,.5)' }} onClick={onCancel}>
      <div role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[440px] rounded-xl border p-5" style={{ background: 'var(--surface)', borderColor: 'var(--line)' }}>
        <h3 className="m-0 text-[15px] font-semibold">{title}</h3>
        <div className="mt-2 text-[13px] leading-relaxed" style={{ color: 'var(--fg-2)' }}>{body}</div>
        {confirmWord ? (
          <div className="mt-3">
            <label className="mb-1.5 block text-[12px]" style={{ color: 'var(--fg-2)' }}>
              请输入 <b style={{ color: 'var(--fg)' }}>{confirmWord}</b> 以继续
            </label>
            <input ref={ref} value={typed} onChange={(e) => setTyped(e.target.value)} className={inputCls} style={inputStyle} />
          </div>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <Btn onClick={onCancel}>取消</Btn>
          <Btn kind="danger" disabled={!ready} onClick={onConfirm}>{confirmLabel}</Btn>
        </div>
      </div>
    </div>
  );
}

export function Banner({ level = 'bad', children, onClose }) {
  const bg = { ok: 'var(--ok-bg)', warn: 'var(--warn-bg)', bad: 'var(--bad-bg)' }[level];
  const fg = { ok: 'var(--ok)', warn: 'var(--warn)', bad: 'var(--bad)' }[level];
  return (
    <div className="mb-3 flex items-start gap-3 rounded-lg px-3.5 py-2 text-[12.5px]" style={{ background: bg, color: fg }}>
      <div className="flex-1">{children}</div>
      {onClose ? <button onClick={onClose} aria-label="关闭提示" className="shrink-0 opacity-70">×</button> : null}
    </div>
  );
}
