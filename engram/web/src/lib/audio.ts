export type Player = ReturnType<typeof createPlayer>
export type Stream = ReturnType<Player['startStream']>

const HOLD_MS = 350
const BUFFER_LEAD_S = 0.03
const STREAM_LEAD_S = 0.06
const STREAM_RATE = 24_000

export function createPlayer(onSpeaking: (speaking: boolean) => void) {
  let ctx: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let micAnalyser: AnalyserNode | null = null
  let micStream: MediaStream | null = null
  let nextTime = 0
  let speaking = false
  let holdTimer: ReturnType<typeof setTimeout> | undefined
  type Scheduled = {
    onStart: () => void
    onEnd: () => void
    timer?: ReturnType<typeof setTimeout>
    started: boolean
    open: boolean
    sources: Set<AudioBufferSourceNode>
  }
  const live = new Set<Scheduled>()
  const idleWaiters: Array<() => void> = []

  const ensure = () => {
    if (!ctx) {
      ctx = new AudioContext()
      analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      analyser.smoothingTimeConstant = 0.5
      analyser.connect(ctx.destination)
    }
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  }

  const setSpeaking = (on: boolean) => {
    clearTimeout(holdTimer)
    if (on) {
      if (!speaking) { speaking = true; onSpeaking(true) }
      return
    }
    holdTimer = setTimeout(() => {
      if (live.size) return
      speaking = false
      onSpeaking(false)
    }, HOLD_MS)
  }

  const drain = () => {
    if (live.size) return
    idleWaiters.splice(0).forEach((resolve) => resolve())
  }

  const item = (onStart: () => void, onEnd: () => void, open: boolean): Scheduled => {
    const it = { onStart, onEnd, started: false, open, sources: new Set<AudioBufferSourceNode>() }
    live.add(it)
    return it
  }

  const settle = (it: Scheduled) => {
    if (it.open || it.sources.size) return
    live.delete(it)
    clearTimeout(it.timer)
    it.onEnd()
    setSpeaking(false)
    drain()
  }

  const schedule = (it: Scheduled, buffer: AudioBuffer, lead: number) => {
    const c = ensure()
    const source = c.createBufferSource()
    source.buffer = buffer
    source.connect(analyser!)
    const startAt = Math.max(c.currentTime + lead, nextTime)
    nextTime = startAt + buffer.duration
    it.sources.add(source)
    if (!it.timer) it.timer = setTimeout(() => { it.started = true; setSpeaking(true); it.onStart() }, (startAt - c.currentTime) * 1000)
    source.onended = () => { it.sources.delete(source); settle(it) }
    source.start(startAt)
  }

  async function enqueue(wav: ArrayBuffer, onStart: () => void, onEnd: () => void) {
    const buffer = await ensure().decodeAudioData(wav.slice(0))
    schedule(item(onStart, onEnd, false), buffer, BUFFER_LEAD_S)
  }

  function startStream(onStart: () => void, onEnd: () => void) {
    const c = ensure()
    const it = item(onStart, onEnd, true)
    let first = true
    return {
      push(pcm: Int16Array) {
        if (!live.has(it) || !pcm.length) return
        const buffer = c.createBuffer(1, pcm.length, STREAM_RATE)
        buffer.copyToChannel(Float32Array.from(pcm, (v) => v / 32768), 0)
        schedule(it, buffer, first ? STREAM_LEAD_S : 0)
        first = false
      },
      end() {
        if (!live.has(it)) return
        it.open = false
        settle(it)
      },
    }
  }

  function stop() {
    live.forEach((it) => {
      clearTimeout(it.timer)
      it.open = false
      it.sources.forEach((source) => {
        source.onended = null
        try { source.stop() } catch {}
      })
      it.sources.clear()
      if (it.started) it.onEnd()
    })
    live.clear()
    nextTime = 0
    clearTimeout(holdTimer)
    if (speaking) { speaking = false; onSpeaking(false) }
    drain()
  }

  const whenIdle = () => new Promise<void>((resolve) => (live.size ? idleWaiters.push(resolve) : resolve()))

  async function attachMic() {
    const c = ensure()
    if (micAnalyser) return micAnalyser
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    micAnalyser = c.createAnalyser()
    micAnalyser.fftSize = 1024
    micAnalyser.smoothingTimeConstant = 0.5
    c.createMediaStreamSource(micStream).connect(micAnalyser)
    return micAnalyser
  }

  function detachMic() {
    micStream?.getTracks().forEach((track) => track.stop())
    micStream = null
    micAnalyser = null
  }

  return {
    ensure,
    enqueue,
    startStream,
    stop,
    whenIdle,
    attachMic,
    detachMic,
    get analyser() { return analyser },
    get mic() { return micAnalyser },
    get busy() { return live.size > 0 },
  }
}

const scratch = new Uint8Array(1024)

export function level(node: AnalyserNode | null) {
  if (!node) return 0
  node.getByteTimeDomainData(scratch)
  let sum = 0
  for (let i = 0; i < node.fftSize; i++) {
    const v = (scratch[i] - 128) / 128
    sum += v * v
  }
  const rms = Math.sqrt(sum / node.fftSize)
  return Math.min(1, Math.pow(rms * 3.2, 0.75))
}
