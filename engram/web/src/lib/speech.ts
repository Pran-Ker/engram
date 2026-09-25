export type MicFailure = 'denied' | 'nodevice' | 'unsupported' | 'network' | 'other'

type Handlers = {
  onInterim: (text: string) => void
  onFinal: (text: string) => void
  onFailure: (kind: MicFailure, detail: string) => void
}

type Recognition = {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((e: RecognitionEvent) => void) | null
  onerror: ((e: { error: string; message?: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

type RecognitionEvent = {
  resultIndex: number
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>
}

const ctor = (): (new () => Recognition) | undefined =>
  (window as unknown as { SpeechRecognition?: new () => Recognition }).SpeechRecognition ??
  (window as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition

const failureKind = (error: string): MicFailure | null => {
  if (error === 'not-allowed' || error === 'service-not-allowed') return 'denied'
  if (error === 'network') return 'network'
  if (error === 'no-speech' || error === 'aborted') return null
  return 'other'
}

export function createRecognizer(handlers: Handlers) {
  const Recognizer = ctor()
  let recognition: Recognition | null = null
  let wanted = false
  let failures = 0

  const spawn = () => {
    const r = new Recognizer!()
    r.continuous = true
    r.interimResults = true
    r.lang = 'en-US'
    r.onresult = (e) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const text = e.results[i][0].transcript.trim()
        if (!text) continue
        if (e.results[i].isFinal) { failures = 0; handlers.onFinal(text) }
        else interim += (interim ? ' ' : '') + text
      }
      handlers.onInterim(interim)
    }
    r.onerror = (e) => {
      const kind = failureKind(e.error)
      if (!kind) return
      failures++
      if (kind === 'denied' || failures > 2) {
        wanted = false
        handlers.onFailure(kind, e.message ?? e.error)
      }
    }
    r.onend = () => {
      recognition = null
      if (wanted) setTimeout(() => wanted && !recognition && start(), 150)
    }
    return r
  }

  function start() {
    if (!Recognizer) return handlers.onFailure('unsupported', 'no SpeechRecognition in this browser')
    wanted = true
    if (recognition) return
    recognition = spawn()
    try { recognition.start() } catch {}
  }

  function stop() {
    wanted = false
    handlers.onInterim('')
    const r = recognition
    recognition = null
    if (r) { r.onend = null; try { r.abort() } catch {} }
  }

  return { start, stop, supported: !!Recognizer, get listening() { return wanted } }
}
