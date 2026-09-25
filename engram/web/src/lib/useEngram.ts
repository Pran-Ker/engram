import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatMessage } from '../../../shared/types.ts'
import { api } from './api.ts'
import { createPlayer, type Player, type Stream } from './audio.ts'
import { createRecognizer, type MicFailure } from './speech.ts'

export type SentenceStatus = 'pending' | 'speaking' | 'done' | 'novoice' | 'skipped'
export type Sentence = { index: number; text: string; status: SentenceStatus }
export type Line =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'engram'; sentences: Sentence[]; draft?: string; error?: string }
  | { id: string; role: 'note'; text: string }
export type Status = 'paused' | 'listening' | 'thinking' | 'speaking'
export type MicState = 'off' | 'on' | MicFailure
type Voice = { provider: string; whole?: ArrayBuffer }
type Speech = { attach: (sink: (pcm: Int16Array) => void) => void; done: Promise<Voice> }

const HIGHLIGHT_MS = 4000
const HISTORY = 12
const MIN_SENTENCE = 12
const SENTENCE_END = /[.!?]["')\]]*(?=\s|$)/g
const uid = () => Math.random().toString(36).slice(2, 10)

const afterSentence = (streamed: string) => {
  SENTENCE_END.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = SENTENCE_END.exec(streamed))) {
    const end = match.index + match[0].length
    if (streamed.slice(0, end).trim().length >= MIN_SENTENCE) return streamed.slice(end)
  }
  return ''
}

const micNote: Record<MicFailure, string> = {
  denied: 'The microphone is blocked for this page. Allow it in the address bar, or type below.',
  nodevice: 'No microphone found on this machine. You can type below.',
  unsupported: 'This browser has no speech recognition. Chrome does. You can type below.',
  network: 'Speech recognition lost its connection. Press start to try again, or type below.',
  other: "The microphone stopped. Press start to try again, or type below.",
}

const fetchSpeech = (slug: string, text: string, signal: AbortSignal): Speech => {
  const buffered: Int16Array[] = []
  let sink: ((pcm: Int16Array) => void) | null = null
  let received = false
  const onChunk = (pcm: Int16Array) => {
    received = true
    sink ? sink(pcm) : buffered.push(pcm)
  }
  const done = api.ttsStream(slug, text, undefined, onChunk, signal).catch(async (err) => {
    if (signal.aborted || received) throw err
    const { audio, provider } = await api.tts(slug, text, undefined, signal)
    return { provider, whole: audio }
  })
  return {
    attach: (fn) => { sink = fn; buffered.splice(0).forEach(fn) },
    done,
  }
}

const describe = (err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  if (message.includes('404')) return 'The brain is not wired up yet (chat route missing).'
  if (message.includes('Failed to fetch')) return 'The API is not reachable. Is the server running on :4100?'
  return `The brain stopped: ${message.slice(0, 140)}`
}

export function useEngram(slug: string) {
  const [running, setRunning] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [turnOpen, setTurnOpen] = useState(false)
  const [lines, setLines] = useState<Line[]>([])
  const [interim, setInterim] = useState('')
  const [micState, setMicState] = useState<MicState>('off')
  const [usedCards, setUsedCards] = useState<string[]>([])
  const [turns, setTurns] = useState(0)

  const runningRef = useRef(false)
  const speakingRef = useRef(false)
  const generation = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const history = useRef<ChatMessage[]>([])
  const sessionId = useRef(uid())
  const sessionLogged = useRef(false)
  const highlightTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const playerRef = useRef<Player | null>(null)
  const providerRef = useRef<string | undefined>(undefined)
  const slugRef = useRef(slug)
  slugRef.current = slug

  const player = useMemo(() => {
    if (playerRef.current) return playerRef.current
    playerRef.current = createPlayer((on) => {
      speakingRef.current = on
      setSpeaking(on)
      void api.event({ engram: slugRef.current, session: sessionId.current, type: 'video_state', provider: providerRef.current, meta: { state: on ? 'talk' : 'idle' } })
    })
    return playerRef.current
  }, [])

  const addNote = useCallback((text: string) => setLines((l) => [...l, { id: uid(), role: 'note', text }]), [])

  const failMic = useCallback((kind: MicFailure) => {
    setMicState(kind)
    runningRef.current = false
    setRunning(false)
    addNote(micNote[kind])
  }, [addNote])

  const askRef = useRef<(text: string) => void>(() => {})
  const recognizer = useMemo(() => createRecognizer({
    onInterim: setInterim,
    onFinal: (text) => askRef.current(text),
    onFailure: (kind) => failMic(kind),
  }), [failMic])

  const patchLine = (id: string, patch: (line: Line) => Line) =>
    setLines((l) => l.map((line) => (line.id === id ? patch(line) : line)))

  const upsertSentence = (lineId: string, sentence: Sentence) =>
    patchLine(lineId, (line) => {
      if (line.role !== 'engram') return line
      const rest = line.sentences.filter((s) => s.index !== sentence.index)
      return { ...line, sentences: [...rest, sentence].sort((a, b) => a.index - b.index) }
    })

  const setDraft = (lineId: string, draft: string) =>
    patchLine(lineId, (line) => (line.role === 'engram' ? { ...line, draft: draft.trim() || undefined } : line))

  const skipUnspoken = () =>
    setLines((l) => l.map((line) => {
      if (line.role !== 'engram') return line
      const sentences = line.sentences.map((s) => (s.status === 'done' || s.status === 'novoice' ? s : { ...s, status: 'skipped' as const }))
      return { ...line, sentences, draft: undefined }
    }))

  const flash = (cards: string[]) => {
    clearTimeout(highlightTimer.current)
    setUsedCards(cards)
  }

  const finishTurn = (gen: number) => {
    if (gen !== generation.current) return
    setTurnOpen(false)
    setTurns((n) => n + 1)
    clearTimeout(highlightTimer.current)
    highlightTimer.current = setTimeout(() => setUsedCards([]), HIGHLIGHT_MS)
    if (runningRef.current) setTimeout(() => runningRef.current && gen === generation.current && recognizer.start(), 250)
  }

  const speakSentence = async (lineId: string, index: number, text: string, speech: Speech, gen: number) => {
    const onStart = () => gen === generation.current && upsertSentence(lineId, { index, text, status: 'speaking' })
    const onEnd = () => gen === generation.current && upsertSentence(lineId, { index, text, status: 'done' })
    const held: { stream: Stream | null } = { stream: null }
    speech.attach((pcm) => {
      if (gen !== generation.current) return
      held.stream ??= player.startStream(onStart, onEnd)
      held.stream.push(pcm)
    })
    try {
      const { provider, whole } = await speech.done
      if (gen !== generation.current) return
      providerRef.current = provider
      held.stream?.end()
      if (whole) await player.enqueue(whole, onStart, onEnd)
    } catch {
      if (gen !== generation.current) return
      if (held.stream) held.stream.end()
      else upsertSentence(lineId, { index, text, status: 'novoice' })
    }
  }

  const ask = useCallback(async (raw: string) => {
    const text = raw.trim()
    if (!text) return
    const gen = ++generation.current
    player.stop()
    abortRef.current?.abort()
    skipUnspoken()
    const abort = new AbortController()
    abortRef.current = abort
    recognizer.stop()
    setInterim('')
    player.ensure()

    const lineId = uid()
    setLines((l) => [...l, { id: uid(), role: 'user', text }, { id: lineId, role: 'engram', sentences: [] }])
    setTurnOpen(true)
    history.current.push({ role: 'user', content: text })
    void api.event({ engram: slug, session: sessionId.current, type: 'user_utterance', text, chars: text.length })

    let sequence = Promise.resolve()
    let gotDone = false
    let spoken = ''
    let streamed = ''
    const sentences: string[] = []
    try {
      await api.chat(slug, { messages: history.current.slice(-HISTORY), sessionId: sessionId.current }, (e) => {
        if (gen !== generation.current) return
        if (e.type === 'context') flash(e.cards)
        if (e.type === 'token') { streamed += e.text; setDraft(lineId, streamed) }
        if (e.type === 'sentence') {
          sentences.push(e.text)
          streamed = afterSentence(streamed)
          upsertSentence(lineId, { index: e.index, text: e.text, status: 'pending' })
          setDraft(lineId, streamed)
          const speech = fetchSpeech(slug, e.text, abort.signal)
          sequence = sequence.then(() => speakSentence(lineId, e.index, e.text, speech, gen))
        }
        if (e.type === 'done') { gotDone = true; spoken = e.text; setDraft(lineId, '') }
        if (e.type === 'error') patchLine(lineId, (line) => ({ ...line, error: e.message }))
      }, abort.signal)
      if (!gotDone && !sentences.length && gen === generation.current)
        patchLine(lineId, (line) => ({ ...line, error: 'The brain returned nothing we could read. It may still be starting.' }))
    } catch (err) {
      if (gen !== generation.current) return
      patchLine(lineId, (line) => ({ ...line, error: describe(err) }))
    }
    setDraft(lineId, '')
    const answer = spoken || sentences.join(' ')
    if (answer) history.current.push({ role: 'assistant', content: answer })
    await sequence
    await player.whenIdle()
    finishTurn(gen)
  }, [slug, player, recognizer])

  useEffect(() => { askRef.current = (text) => void ask(text) }, [ask])

  const start = useCallback(async () => {
    player.ensure()
    if (!sessionLogged.current) {
      sessionLogged.current = true
      void api.event({ engram: slug, session: sessionId.current, type: 'session_start' })
    }
    runningRef.current = true
    setRunning(true)
    try {
      await player.attachMic()
      setMicState('on')
    } catch (err) {
      const name = err instanceof DOMException ? err.name : ''
      const kind = name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : name === 'NotFoundError' ? 'nodevice' : 'other'
      return failMic(kind)
    }
    if (!recognizer.supported) return failMic('unsupported')
    if (!speakingRef.current) recognizer.start()
  }, [slug, player, recognizer, failMic])

  const pause = useCallback(() => {
    runningRef.current = false
    setRunning(false)
    recognizer.stop()
    abortRef.current?.abort()
    generation.current++
    player.stop()
    skipUnspoken()
    setInterim('')
    setTurnOpen(false)
  }, [player, recognizer])

  const toggle = useCallback(() => (runningRef.current ? pause() : void start()), [pause, start])
  const playbackNode = useCallback(() => player.analyser, [player])
  const micNode = useCallback(() => player.mic, [player])

  useEffect(() => () => { pause(); player.detachMic(); clearTimeout(highlightTimer.current) }, [pause, player])

  const status: Status = speaking ? 'speaking' : turnOpen ? 'thinking' : running ? 'listening' : 'paused'

  return {
    running,
    status,
    speaking,
    lines,
    interim,
    micState,
    usedCards,
    turns,
    playbackNode,
    micNode,
    start,
    pause,
    toggle,
    ask,
  }
}
