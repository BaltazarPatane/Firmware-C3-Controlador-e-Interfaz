/** Textual responses verified against the attached Marlin-Cartesiana sources.
 * M31: SERIAL_ECHO_MSG("Print time: ", duration_t::toString(buffer))
 * M27 C: SERIAL_ECHOPGM("Current file: ", filename)
 * Do NOT invent remaining time: M73_REPORT/SET_PROGRESS_MANUALLY are disabled.
 */
export type SdPrintDetails = {
  filename: string | null
  elapsedSeconds: number | null
}

export function parseSdDetail(line: string): Partial<SdPrintDetails> | null {
  // Ignore async bridge history: a previous job is not the current job.
  if (/^\[Anterior\]/i.test(line.trim())) return null
  const filename = line.match(/(?:^|\s)(?:echo:\s*)?Current file:\s*(.*)$/i)
  if (filename) return { filename: filename[1].trim() || null }
  const duration = line.match(/(?:^|\s)(?:echo:\s*)?Print time:\s*(.*)$/i)
  if (!duration) return null
  const tail = duration[1].trim()
  const pieces = [...tail.matchAll(/(\d+)\s*([ydhms])\b/gi)]
  if (pieces.length === 0) return null
  const factors: Record<string, number> = { y: 31536000, d: 86400, h: 3600, m: 60, s: 1 }
  // Never turn malformed output into a plausible elapsed time.
  const leftovers = tail.replace(/(\d+)\s*[ydhms]\b/gi, '').trim()
  if (leftovers.length > 0) return null
  const seconds = pieces.reduce((sum, p) => sum + Number(p[1]) * factors[p[2].toLowerCase()], 0)
  return Number.isSafeInteger(seconds) ? { elapsedSeconds: seconds } : null
}

export function sdFraction(done: number, total: number): number | null {
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0 || done < 0) return null
  return Math.max(0, Math.min(100, (done / total) * 100))
}

export function formatSdElapsed(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '—'
  const v = Math.floor(seconds)
  const d = Math.floor(v / 86400)
  const h = Math.floor(v / 3600) % 24
  const m = Math.floor(v / 60) % 60
  const s = v % 60
  return d ? `${d} d ${h} h ${m} min` : `${h ? `${h} h ` : ''}${m} min ${s} s`
}
