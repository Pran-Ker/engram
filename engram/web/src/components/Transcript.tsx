import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import type { Line } from '../lib/useEngram.ts'
import './Transcript.css'

type Props = {
  lines: Line[]
  interim: string
  lead?: ReactNode
  blank?: string
  disabled?: boolean
  input: boolean
  focusInput: boolean
  onReveal: () => void
  onHide: () => void
  onSubmit: (text: string) => void
}

const BLANK = 'Press start and say hello.'

const lastUserId = (lines: Line[]) => [...lines].reverse().find((l) => l.role === 'user')?.id

export function Transcript({ lines, interim, lead, blank = BLANK, disabled = false, input, focusInput, onReveal, onHide, onSubmit }: Props) {
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState('')
  const pinned = lastUserId(lines)

  useEffect(() => { followSpeech(listRef.current) }, [lines, interim])
  useEffect(() => { if (input && focusInput) inputRef.current?.focus() }, [input, focusInput])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!draft.trim()) return
    onSubmit(draft)
    setDraft('')
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Escape') return
    inputRef.current?.blur()
    onHide()
  }

  return (
    <section className="transcript" aria-label="Transcript" onClick={onReveal}>
      <div className="transcript-lines" ref={listRef}>
        {lead && <p className="transcript-line" data-role="note">{lead}</p>}
        {lines.length === 0 && !interim && <p className="transcript-blank">{blank}</p>}
        {lines.map((line) => <LineView key={line.id} line={line} pinned={line.id === pinned} />)}
        {interim && <p className="transcript-line" data-role="interim">{interim}</p>}
      </div>
      {input && (
        <form className="transcript-input" onSubmit={submit}>
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder="Type a question"
            aria-label="Type a question"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
          />
        </form>
      )}
    </section>
  )
}

const PINNED_GAP = 20
const last = <T extends Element>(list: NodeListOf<T>) => list.item(list.length - 1) as T | null

function followSpeech(list: HTMLDivElement | null) {
  if (!list) return
  const lastLine = last(list.querySelectorAll<HTMLElement>('.transcript-line[data-role="engram"]'))
  const active = last(list.querySelectorAll<HTMLElement>('[data-status="speaking"]')) ?? lastLine?.querySelector<HTMLElement>('[data-status="pending"]') ?? null
  const pinned = list.querySelector<HTMLElement>('[data-pinned="true"]')
  const pinnedH = pinned ? pinned.offsetHeight + PINNED_GAP : 0
  const box = list.getBoundingClientRect()
  const top = box.top + pinnedH
  const fits = lastLine && lastLine === list.lastElementChild && lastLine.getBoundingClientRect().height <= box.height - pinnedH - 4
  const target = fits ? lastLine : active
  if (!target) return list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' })
  const rect = target.getBoundingClientRect()
  if (!fits && rect.top >= top && rect.bottom <= box.bottom) return
  list.scrollTo({ top: list.scrollTop + rect.top - top, behavior: 'smooth' })
}

function LineView({ line, pinned }: { line: Line; pinned: boolean }) {
  if (line.role === 'user') return <p className="transcript-line" data-role="user" data-pinned={pinned}><span>{line.text}</span></p>
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
