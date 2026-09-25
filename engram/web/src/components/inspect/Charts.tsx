import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { fmtInt } from './waveform.ts'

export type Series = {
  name: string
  color: string
  points: { x: number; y: number }[]
  axis?: 'left' | 'right'
  dashed?: boolean
  dots?: boolean
  format: (n: number) => string
  axisFormat?: (n: number) => string
}

type Props = {
  title: string
  series: Series[]
  xMax: number
  checkpoints: number[]
  loaded: number | null
  onLoad: (step: number) => void
  xLabel?: string
}

const M = { top: 22, right: 22, bottom: 18, left: 40 }

export function LineChart(p: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [hoverX, setHoverX] = useState<number | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  const hasRight = p.series.some((s) => s.axis === 'right')
  const right = hasRight ? 44 : M.right
  const plotW = Math.max(0, size.w - M.left - right)
  const plotH = Math.max(0, size.h - M.top - M.bottom)
  const sx = (x: number) => M.left + (x / p.xMax) * plotW

  const domains = useMemo(() => ({
    left: domain(p.series.filter((s) => s.axis !== 'right')),
    right: domain(p.series.filter((s) => s.axis === 'right')),
  }), [p.series])

  const sy = (y: number, axis: 'left' | 'right') => {
    const [lo, hi] = domains[axis]
    return M.top + plotH - ((y - lo) / (hi - lo || 1)) * plotH
  }

  const axisLabel = (axis: 'left' | 'right', t: number) => {
    const s = p.series.find((x) => (x.axis ?? 'left') === axis)
    return s ? (s.axisFormat ?? s.format)(t) : String(t)
  }

  const hovered = hoverX === null ? null : p.series.map((s) => nearest(s.points, hoverX))
  const hoverStep = hovered?.find(Boolean)?.x ?? null

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = ((e.clientX - rect.left - M.left) / plotW) * p.xMax
    setHoverX(x < 0 || x > p.xMax ? null : x)
  }

  const onClick = () => {
    if (hoverX === null) return
    const ck = p.checkpoints.reduce((a, b) => (Math.abs(b - hoverX) < Math.abs(a - hoverX) ? b : a))
    if (Math.abs(sx(ck) - sx(hoverX)) < 14) p.onLoad(ck)
  }

  return (
    <div className="chart" ref={ref}>
      <div className="chart-legend">
        <span className="chart-title">{p.title}</span>
        {p.series.map((s, i) => {
          const v = hovered?.[i] ?? s.points[s.points.length - 1]
          return (
            <span key={s.name} className="legend-item">
              <i style={{ background: s.color, borderStyle: s.dashed ? 'dashed' : 'solid' }} />
              <span className="dim">{s.name}</span>
              <span className="mono">{v ? s.format(v.y) : '—'}</span>
            </span>
          )
        })}
        <span className="ih-spacer" />
        <span className="mono dim">{hoverStep !== null ? `step ${fmtInt(Math.round(hoverStep))}` : p.loaded !== null ? `loaded ${fmtInt(p.loaded)}` : ''}</span>
      </div>
      {size.w > 0 && (
        <svg width={size.w} height={size.h} onMouseMove={onMove} onMouseLeave={() => setHoverX(null)} onClick={onClick} style={{ cursor: hoverStep !== null ? 'crosshair' : 'default' }}>
          {yTicks(domains.left).map((t) => (
            <g key={`l${t}`}>
              <line x1={M.left} x2={M.left + plotW} y1={sy(t, 'left')} y2={sy(t, 'left')} className="grid" />
              <text x={M.left - 6} y={sy(t, 'left') + 3} textAnchor="end" className="axis">{axisLabel('left', t)}</text>
            </g>
          ))}
          {hasRight && yTicks(domains.right).map((t) => (
            <text key={`r${t}`} x={M.left + plotW + 6} y={sy(t, 'right') + 3} textAnchor="start" className="axis">{axisLabel('right', t)}</text>
          ))}
          {xTicks(p.xMax, plotW).map((t) => (
            <text key={`x${t}`} x={sx(t)} y={size.h - 4} textAnchor="middle" className="axis">{fmtInt(t)}</text>
          ))}
          <line x1={M.left} x2={M.left + plotW} y1={M.top + plotH} y2={M.top + plotH} className="axis-line" />

          {p.checkpoints.map((c) => (
            <g key={c} className={`ck${c === p.loaded ? ' is-loaded' : ''}`}>
              <line x1={sx(c)} x2={sx(c)} y1={M.top} y2={M.top + plotH} />
              <path d={`M${sx(c) - 3.5},${M.top + plotH + 1} l7,0 l-3.5,-5 z`} />
            </g>
          ))}

          {p.series.map((s) => {
            const axis = s.axis ?? 'left'
            const d = s.points.map((pt, i) => `${i ? 'L' : 'M'}${sx(pt.x).toFixed(1)},${sy(pt.y, axis).toFixed(1)}`).join(' ')
            return (
              <g key={s.name}>
                <path d={d} fill="none" stroke={s.color} strokeWidth={s.dots ? 1.25 : 1.1} strokeDasharray={s.dashed ? '3 3' : undefined} strokeLinejoin="round" />
                {s.dots && s.points.map((pt) => <circle key={pt.x} cx={sx(pt.x)} cy={sy(pt.y, axis)} r={2.4} fill={s.color} />)}
              </g>
            )
          })}

          {hoverStep !== null && (
            <g className="xhair">
              <line x1={sx(hoverStep)} x2={sx(hoverStep)} y1={M.top} y2={M.top + plotH} />
              {p.series.map((s, i) => hovered?.[i] && <circle key={s.name} cx={sx(hovered[i]!.x)} cy={sy(hovered[i]!.y, s.axis ?? 'left')} r={3} fill="var(--bg)" stroke={s.color} strokeWidth={1.5} />)}
            </g>
          )}
        </svg>
      )}
    </div>
  )
}

function domain(series: Series[]): [number, number] {
  const ys = series.flatMap((s) => s.points.map((pt) => pt.y))
  if (!ys.length) return [0, 1]
  const lo = Math.min(...ys)
  const hi = Math.max(...ys)
  const pad = (hi - lo || 1) * 0.08
  return [lo - pad, hi + pad]
}

function yTicks([lo, hi]: [number, number]) {
  const raw = (hi - lo) / 4
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Number(v.toFixed(6)))
  return out
}

function xTicks(xMax: number, plotW: number) {
  const minGap = 56
  const step = [100, 200, 400, 500, 800, 1000, 2000].find((s) => (plotW / (xMax / s)) >= minGap) ?? xMax
  const out: number[] = []
  for (let x = 0; x <= xMax; x += step) out.push(x)
  return out
}

function nearest(points: { x: number; y: number }[], x: number) {
  if (!points.length) return null
  return points.reduce((a, b) => (Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a))
}
