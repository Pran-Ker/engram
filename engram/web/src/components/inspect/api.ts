import type { DistillJob, InspectFlag, InspectRun, InspectTurn } from '../../../../shared/types.ts'

export const inspectApi = {
  runs: (slug: string) => get<InspectRun[]>(`/api/inspect/${slug}/runs`),
  turns: (slug: string) => get<InspectTurn[]>(`/api/inspect/${slug}/turns`),
  flags: (slug: string) => get<InspectFlag[]>(`/api/inspect/${slug}/flags`),
  addFlag: (slug: string, flag: Omit<InspectFlag, 'id' | 'engram' | 'ts'>) => post<InspectFlag>(`/api/inspect/${slug}/flags`, flag),
  jobs: (slug: string) => get<DistillJob[]>(`/api/inspect/${slug}/jobs`),
  distill: (slug: string, flagIds: string[], fromCheckpoint: number) =>
    post<DistillJob>(`/api/inspect/${slug}/distill`, { flagIds, fromCheckpoint }),
  synthesize: async (slug: string, text: string, turnId: string) => {
    const r = await fetch(`/api/engrams/${slug}/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, turnId }) })
    if (!r.ok) throw new Error(`tts ${r.status}`)
    return { audio: await r.arrayBuffer(), provider: r.headers.get('x-voice-provider') ?? 'unknown' }
  },
}

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url} ${r.status}`)
  return r.json()
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`${url} ${r.status}: ${(await r.json().catch(() => ({ error: r.statusText }))).error}`)
  return r.json()
}
