/* 时序图。手写内联 SVG，不引图表库——面板要从公网加载，包越小越好，
   而这里的需求只是"几条折线 + 悬停读数"，用不上通用图表库那一整套。

   数据来自 /api/history 的累计量，速率在这里做差分算出来：
   存速率会因为采样间隔抖动而失真，存累计量再差分才准。 */
import { useMemo, useRef, useState } from 'react';
import { fmt } from './ui';

const PAD = { l: 44, r: 8, t: 10, b: 18 };

export function TimeChart({ series, height = 132, unit = '', yMax: forcedMax, fmtY = (v) => fmt(v, 0) }) {
  const [hover, setHover] = useState(null);
  const ref = useRef(null);

  const { pts, max, t0, t1 } = useMemo(() => {
    let mx = 0; let a = Infinity; let b = -Infinity;
    for (const s of series) {
      for (const p of s.points) {
        if (p.v != null && p.v > mx) mx = p.v;
        if (p.t < a) a = p.t;
        if (p.t > b) b = p.t;
      }
    }
    return { pts: series, max: forcedMax || (mx > 0 ? mx * 1.15 : 1), t0: a, t1: b };
  }, [series, forcedMax]);

  const has = series.some((s) => s.points.length > 1);
  if (!has) {
    return (
      <div className="grid h-[132px] place-items-center rounded-md border text-[12px]"
        style={{ borderColor: 'var(--line)', background: 'var(--surface-2)', color: 'var(--fg-3)' }}>
        正在积累数据，稍后显示趋势
      </div>
    );
  }

  const W = 640;
  const H = height;
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const x = (t) => PAD.l + (t1 === t0 ? iw : ((t - t0) / (t1 - t0)) * iw);
  const y = (v) => PAD.t + ih - (Math.max(0, Math.min(max, v)) / max) * ih;

  const ticks = [0, 0.5, 1].map((f) => ({ v: max * f, y: PAD.t + ih - f * ih }));

  const onMove = (e) => {
    const r = ref.current.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    if (px < PAD.l || px > W - PAD.r) { setHover(null); return; }
    const t = t0 + ((px - PAD.l) / iw) * (t1 - t0);
    const rows = series.map((s) => {
      let best = null; let bd = Infinity;
      for (const p of s.points) { const d = Math.abs(p.t - t); if (d < bd) { bd = d; best = p; } }
      return { label: s.label, color: s.color, p: best };
    }).filter((r2) => r2.p);
    if (!rows.length) { setHover(null); return; }
    setHover({ px, t: rows[0].p.t, rows });
  };

  const timeLabel = (t) => new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="relative">
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img"
        aria-label={series.map((s) => s.label).join('、') + ' 的时间趋势'}
        onMouseMove={onMove} onMouseLeave={() => setHover(null)}
        style={{ display: 'block', touchAction: 'none' }}>
        {ticks.map((tk, i) => (
          <g key={i}>
            <line x1={PAD.l} x2={W - PAD.r} y1={tk.y} y2={tk.y} stroke="var(--line-soft)" strokeWidth="1" />
            <text x={PAD.l - 6} y={tk.y + 3.5} textAnchor="end" fontSize="10" fill="var(--fg-3)">{fmtY(tk.v)}</text>
          </g>
        ))}
        <text x={PAD.l} y={H - 4} fontSize="10" fill="var(--fg-3)">{timeLabel(t0)}</text>
        <text x={W - PAD.r} y={H - 4} textAnchor="end" fontSize="10" fill="var(--fg-3)">{timeLabel(t1)}</text>

        {pts.map((s, i) => {
          const d = s.points
            .filter((p) => p.v != null)
            .map((p, j) => (j === 0 ? 'M' : 'L') + x(p.t).toFixed(1) + ' ' + y(p.v).toFixed(1))
            .join(' ');
          const area = s.fill
            ? d + ` L${x(s.points[s.points.length - 1].t).toFixed(1)} ${PAD.t + ih} L${x(s.points[0].t).toFixed(1)} ${PAD.t + ih} Z`
            : null;
          return (
            <g key={i}>
              {area ? <path d={area} fill={s.color} opacity="0.12" /> : null}
              <path d={d} fill="none" stroke={s.color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
            </g>
          );
        })}

        {hover ? (
          <g>
            <line x1={hover.px} x2={hover.px} y1={PAD.t} y2={PAD.t + ih} stroke="var(--fg-3)" strokeWidth="1" strokeDasharray="3 3" />
            {hover.rows.map((r, i) => (r.p.v == null ? null : (
              <circle key={i} cx={x(r.p.t)} cy={y(r.p.v)} r="3" fill={r.color} stroke="var(--surface)" strokeWidth="1.5" />
            )))}
          </g>
        ) : null}
      </svg>

      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]" style={{ color: 'var(--fg-2)' }}>
        {series.map((s, i) => (
          <span key={i} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-[2px] w-3.5 rounded" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
        {hover ? (
          <span className="tnum ml-auto" style={{ color: 'var(--fg)' }}>
            {timeLabel(hover.t)}
            {hover.rows.map((r, i) => (
              <span key={i} className="ml-2.5">{r.label} <b>{r.p.v == null ? '—' : fmt(r.p.v, 1)}</b>{unit}</span>
            ))}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/* 把 /api/history 的累计量转成速率序列。相邻两点做差分：
   Δ词元 ÷ Δ耗时。耗时用服务端的累计秒数，不用墙上时间——
   空闲时墙上时间在走而模型没在算，用墙上时间会把速度算成 0。 */
export function ratesFrom(points, tokKey, secKey) {
  const out = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]; const b = points[i];
    const dTok = (b[tokKey] || 0) - (a[tokKey] || 0);
    const dSec = (b[secKey] || 0) - (a[secKey] || 0);
    out.push({ t: b.t, v: dSec > 0.02 ? dTok / dSec : 0 });
  }
  return out;
}

export function seriesFrom(points, key, scale = 1) {
  return points.map((p) => ({ t: p.t, v: p[key] == null ? null : p[key] * scale }));
}
