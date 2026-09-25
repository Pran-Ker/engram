import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const LOCAL_PROVIDER = 'local:say'

export function localAvailable() {
  return process.platform === 'darwin'
}

export async function localSay(text: string): Promise<Buffer> {
  if (!localAvailable()) throw new Error('local tts needs macOS `say`')
  const dir = mkdtempSync(join(tmpdir(), 'engram-say-'))
  const aiff = join(dir, 'out.aiff')
  const wav = join(dir, 'out.wav')
  try {
    await run('say', ['-o', aiff, text])
    await toWav24k(aiff, wav)
    return readFileSync(wav)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function toWav24k(src: string, dst: string) {
  try {
    await run('afconvert', ['-f', 'WAVE', '-d', 'LEI16@24000', '-c', '1', src, dst])
  } catch {
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-ar', '24000', '-ac', '1', '-sample_fmt', 's16', dst])
  }
}
