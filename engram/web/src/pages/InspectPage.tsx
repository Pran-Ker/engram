import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import type { DistillJob, InspectFlag, InspectFlagTrack, InspectRun, InspectTurn } from '../../../shared/types.ts'
import { inspectApi } from '../components/inspect/api.ts'
import { Header } from '../components/inspect/Header.tsx'
import { TurnList } from '../components/inspect/TurnList.tsx'
import { TurnDetail } from '../components/inspect/TurnDetail.tsx'
import { LineChart } from '../components/inspect/Charts.tsx'
import { DistillQueue } from '../components/inspect/DistillQueue.tsx'
import './inspect.css'

type Load<T> = { data: T; state: 'loading' | 'ready' | 'error'; error?: string }

const loading = <T,>(data: T): Load<T> => ({ data, state: 'loading' })

export function InspectPage() {
  const slug = useParams().slug ?? 'prannay'
  const [params, setParams] = useSearchParams()
  const [name, setName] = useState(slug)
  const [runs, setRuns] = useState<Load<InspectRun[]>>(loading([]))
  const [turns, setTurns] = useState<Load<InspectTurn[]>>(loading([]))
  const [flags, setFlags] = useState<Load<InspectFlag[]>>(loading([]))
  const [jobs, setJobs] = useState<Load<DistillJob[]>>(loading([]))
  const [loadedStep, setLoadedStep] = useState<number | null>(() => readStep(slug))
  const [selectedFlagIds, setSelectedFlagIds] = useState<Set<string>>(new Set())
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [posterUrl, setPosterUrl] = useState<string | null>(null)
  const [hotkeyTrack, setHotkeyTrack] = useState<InspectFlagTrack | null>(null)
  const [now, setNow] = useState(Date.now())

  const run = runs.data[0] ?? null
  const selectedTurnId = params.get('turn') ?? turns.data[0]?.id ?? null
  const turn = turns.data.find((t) => t.id === selectedTurnId) ?? null
  const turnFlags = useMemo(() => flags.data.filter((f) => f.turnId === selectedTurnId), [flags.data, selectedTurnId])

  const fetchInto = useCallback(<T,>(set: (l: Load<T>) => void, req: () => Promise<T>, keep?: T) => {
    req().then((data) => set({ data, state: 'ready' })).catch((e: Error) => set({ data: keep ?? ([] as T), state: 'error', error: e.message }))
  }, [])

  const loadTurns = useCallback(() => fetchInto(setTurns, () => inspectApi.turns(slug)), [slug, fetchInto])
  const loadJobs = useCallback(() => fetchInto(setJobs, () => inspectApi.jobs(slug)), [slug, fetchInto])
  const loadFlags = useCallback(() => {
    inspectApi.flags(slug)
      .then((data) => setFlags((f) => ({ data: [...data, ...f.data.filter((x) => x.id.startsWith('tmp-'))], state: 'ready' })))
      .catch((e: Error) => setFlags((f) => ({ ...f, state: f.data.length ? f.state : 'error', error: e.message })))
  }, [slug])

  useEffect(() => {
    fetchInto(setRuns, () => inspectApi.runs(slug))
    loadTurns()
    loadFlags()
    loadJobs()
    fetch(`/api/engrams/${slug}`).then((r) => r.ok ? r.json() : null).then((m) => m?.name && setName(m.name)).catch(() => {})
    fetch(`/api/engrams/${slug}/video/poster`, { method: 'HEAD' }).then((r) => setPosterUrl(r.ok ? `/api/engrams/${slug}/video/poster` : null)).catch(() => setPosterUrl(null))
  }, [slug, fetchInto, loadTurns, loadFlags, loadJobs])

  useEffect(() => {
    document.title = `${name} · Inspect · Engram`
    return () => { document.title = 'Engram' }
  }, [name])

  useEffect(() => {
    const visible = () => document.visibilityState === 'visible'
    const jobsTimer = setInterval(loadJobs, 4000)
    const turnsTimer = setInterval(() => { if (visible()) loadTurns() }, 12000)
    const flagsTimer = setInterval(() => { if (visible()) loadFlags() }, 6000)
    const clock = setInterval(() => setNow(Date.now()), 1000)
    return () => { clearInterval(jobsTimer); clearInterval(turnsTimer); clearInterval(flagsTimer); clearInterval(clock) }
  }, [loadJobs, loadTurns, loadFlags])

  useEffect(() => {
    if (params.get('turn') || !turns.data[0]) return
    setParams((prev) => { prev.set('turn', turns.data[0].id); return prev }, { replace: true })
  }, [turns.data, params, setParams])

  useEffect(() => {
    if (loadedStep !== null || !run) return
    const best = run.checkpoints.reduce((a, b) => (b.valLoss < a.valLoss ? b : a))
    setLoadedStep(best.step)
  }, [run, loadedStep])

  const onLoad = (step: number) => {
    setLoadedStep(step)
    try { localStorage.setItem(`engram.inspect.${slug}.ckpt`, String(step)) } catch {}
  }

  const selectTurn = useCallback((id: string) => {
    setParams((prev) => { prev.set('turn', id); return prev }, { replace: true })
  }, [setParams])

  const toggleFlag = (id: string) => setSelectedFlagIds((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const addFlag = async (flag: Omit<InspectFlag, 'id' | 'engram' | 'ts'>) => {
    const temp: InspectFlag = { ...flag, id: `tmp-${Date.now()}`, engram: slug, ts: new Date().toISOString() }
    setFlags((f) => ({ ...f, data: [...f.data, temp] }))
    try {
      const saved = await inspectApi.addFlag(slug, flag)
      setFlags((f) => ({ ...f, data: f.data.map((x) => (x.id === temp.id ? saved : x)) }))
      setSelectedFlagIds((prev) => new Set(prev).add(saved.id))
    } catch (e) {
      setFlags((f) => ({ ...f, data: f.data.filter((x) => x.id !== temp.id) }))
      throw e
    }
  }

  const distill = async () => {
    if (!selectedFlagIds.size) return
    const ids = [...selectedFlagIds]
    const from = loadedStep ?? run?.steps ?? 0
    const temp: DistillJob = { id: 'queuing…', engram: slug, flagIds: ids, fromCheckpoint: from, createdAt: new Date().toISOString(), status: 'queued', progress: 0, eta: new Date(Date.now() + 270_000).toISOString(), detail: 'submitting' }
    setJobs((j) => ({ ...j, data: [temp, ...j.data] }))
    setSelectedFlagIds(new Set())
    try {
      const job = await inspectApi.distill(slug, ids, from)
      setJobs((j) => ({ ...j, data: j.data.map((x) => (x.id === temp.id ? job : x)) }))
    } catch (e) {
      setJobs((j) => ({ data: j.data.filter((x) => x.id !== temp.id), state: 'error', error: (e as Error).message }))
      setSelectedFlagIds(new Set(ids))
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey) return
      const idx = turns.data.findIndex((t) => t.id === selectedTurnId)
      if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); const n = turns.data[Math.min(turns.data.length - 1, idx + 1)]; if (n) selectTurn(n.id) }
      if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); const n = turns.data[Math.max(0, idx - 1)]; if (n) selectTurn(n.id) }
      if (e.key === 'l') setPopoverOpen((o) => !o)
      if (e.key === 'd') void distill()
      if (e.key === 'v') setHotkeyTrack('voice')
      if (e.key === 'f') setHotkeyTrack('face')
      if (e.key === 'Escape') setPopoverOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [turns.data, selectedTurnId, selectTurn, selectedFlagIds, loadedStep, run])

  const lossSeries = useMemo(() => run ? [
    { name: 'train loss', color: 'var(--series-1)', points: run.curve.map((c) => ({ x: c.step, y: c.train })), format: f3, axisFormat: f1 },
    { name: 'val loss', color: 'var(--series-2)', points: run.curve.filter((c) => c.val !== undefined).map((c) => ({ x: c.step, y: c.val! })), dots: true, format: f3, axisFormat: f1 },
  ] : [], [run])

  const qualitySeries = useMemo(() => run ? [
    { name: 'speaker sim', color: 'var(--series-1)', points: run.checkpoints.map((c) => ({ x: c.step, y: c.speakerSim })), dots: true, format: (n: number) => n.toFixed(2) },
    { name: 'WER', color: 'var(--series-2)', points: run.checkpoints.map((c) => ({ x: c.step, y: c.wer })), dots: true, axis: 'right' as const, format: (n: number) => `${n.toFixed(1)}%` },
  ] : [], [run])

  const ckSteps = run?.checkpoints.map((c) => c.step) ?? []

  return (
    <main className="inspect">
      <Header
        name={name}
        slug={slug}
        run={run}
        loadedStep={loadedStep}
        onLoad={onLoad}
        popoverOpen={popoverOpen}
        setPopoverOpen={setPopoverOpen}
        selectedFlags={selectedFlagIds.size}
        onDistill={() => void distill()}
      />
      <TurnList turns={turns.data} selectedId={selectedTurnId} onSelect={selectTurn} flags={flags.data} state={turns.state} error={turns.error} onRetry={loadTurns} slug={slug} />
      <TurnDetail
        slug={slug}
        turn={turn}
        flags={turnFlags}
        selectedFlagIds={selectedFlagIds}
        onToggleFlag={toggleFlag}
        onAddFlag={addFlag}
        posterUrl={posterUrl}
        state={turns.state}
        hotkeyTrack={hotkeyTrack}
        onHotkeyConsumed={() => setHotkeyTrack(null)}
      />
      <footer className="bottom">
        {runs.state === 'error' && <p className="state-msg span-2">Couldn't load fine-tune runs from /api/inspect/{slug}/runs. {runs.error}</p>}
        {runs.state === 'ready' && !run && (
          <p className="state-msg span-2">No fine-tune run for {slug} yet. Record a few minutes of voice, then <span className="mono">make train RUN={slug}-v1</span> in voice/. Loss, speaker similarity and WER per checkpoint chart here.</p>
        )}
        {run && (
          <>
            <LineChart title="loss" series={lossSeries} xMax={run.steps} checkpoints={ckSteps} loaded={loadedStep} onLoad={onLoad} />
            <LineChart title="voice quality per checkpoint" series={qualitySeries} xMax={run.steps} checkpoints={ckSteps} loaded={loadedStep} onLoad={onLoad} />
          </>
        )}
        <DistillQueue jobs={jobs.data} state={jobs.state} error={jobs.error} now={now} />
      </footer>
    </main>
  )
}

const f3 = (n: number) => n.toFixed(3)
const f1 = (n: number) => n.toFixed(1)

function readStep(slug: string) {
  try {
    const v = localStorage.getItem(`engram.inspect.${slug}.ckpt`)
    return v ? Number(v) : null
  } catch {
    return null
  }
}
