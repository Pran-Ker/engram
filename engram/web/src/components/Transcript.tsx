import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { Line } from '../lib/useEngram.ts'
import './Transcript.css'

type Props = {
  lines: Line[]
  interim: string
  blank?: string
  disabled?: boolean
  onSubmit: (text: string) => void
}

const BLANK = 'Press start and say hello. Your words land here, the answer follows in orange as it is spoken.'

export function Transcript({ lines, interim, blank = BLANK, disabled = false, onSubmit }: Props) {
  const listRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines, interim])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!draft.trim()) return
    onSubmit(draft)
    setDraft('')
  }

  return (
    <section className="transcript" aria-label="Transcript">
      <div className="transcript-lines" ref={listRef}>
        {lines.length === 0 && !interim && (
          <p className="transcript-blank">{blank}</p>
        )}
        {lines.map((line) => <LineView key={line.id} line={line} />)}
        {interim && <p className="transcript-line" data-role="interim">{interim}</p>}
      </div>
      <form className="transcript-input" onSubmit={submit}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Say something, or type it"
          aria-label="Type a message"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
        />
      </form>
    </section>
  )
}

function LineView({ line }: { line: Line }) {
  if (line.role === 'user') return <p className="transcript-line" data-role="user">{line.text}</p>
  if (line.role === 'note') return <p className="transcript-line" data-role="note">{line.text}</p>
  if (!line.sentences.length && !line.draft && !line.error) return null
  return (
    <p className="transcript-line" data-role="engram">
      {line.sentences.map((s) => (
        <span key={s.index} className="transcript-sentence" data-status={s.status}>
          {s.text}{' '}
        </span>
      ))}
      {line.draft && <span className="transcript-sentence" data-status="pending">{line.draft}</span>}
      {line.sentences.some((s) => s.status === 'novoice') && (
        <span className="transcript-aside">{line.sentences.every((s) => s.status === 'novoice') ? 'no voice for this, shown as text' : 'no voice for part of this'}</span>
      )}
      {line.error && <span className="transcript-aside">{line.error}</span>}
    </p>
  )
}
