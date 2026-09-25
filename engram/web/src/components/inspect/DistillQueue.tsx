import type { DistillJob } from '../../../../shared/types.ts'
import { fmtClock, fmtInt } from './waveform.ts'

type Props = {
  jobs: DistillJob[]
  state: 'loading' | 'ready' | 'error'
  error?: string
  now: number
}

export function DistillQueue(p: Props) {
  const active = p.jobs.filter((j) => j.status !== 'done').length
  return (
    <section className="queue">
      <div className="pane-head">
        <span>Distill queue</span>
        <span className="mono dim">{active ? `${active} active` : ''}</span>
      </div>
      {p.state === 'error' && <p className="state-msg">Couldn't load jobs. {p.error}</p>}
      {p.state === 'ready' && p.jobs.length === 0 && (
        <p className="state-msg">No jobs. Select flags in a turn and press Distill to queue a run from the loaded checkpoint.</p>
      )}
      <ul className="job-list">
        {p.jobs.map((j) => <Job key={j.id} job={j} now={p.now} />)}
      </ul>
    </section>
  )
}

function Job({ job, now }: { job: DistillJob; now: number }) {
  const remaining = Math.max(0, Math.round((Date.parse(job.eta) - now) / 1000))
  const done = job.status === 'done'
  return (
    <li className={`job${done ? ' is-done' : ''}`}>
      <div className="job-l1">
        <span className="mono">{job.id}</span>
        <span className="dim">from step {fmtInt(job.fromCheckpoint)} · {job.flagIds.length} flag{job.flagIds.length === 1 ? '' : 's'}</span>
        <span className="ih-spacer" />
        <span className="mono dim">{fmtClock(job.createdAt)}</span>
      </div>
      <div className="job-l2">
        <span className={`status status-${job.status}`}>{job.status}</span>
        <span className="dim job-detail">{job.detail}</span>
        <span className="ih-spacer" />
        <span className="mono dim">{done ? '' : `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')} left`}</span>
      </div>
      <div className="bar"><i style={{ width: `${Math.round(job.progress * 100)}%` }} /></div>
    </li>
  )
}
