import type { ConsoleEntry, ConsoleOrigin, MessageDirection } from './printer-types'

/** Presentation only: none of these decisions change printer communication. */
export function isCriticalMarlinOutput(text: string): boolean {
  return /(?:Error:|!!|ALARM:|Warning:|Printer halted|kill\(|Thermal Runaway|Heating failed|MINTEMP|MAXTEMP|resend:|rs N\d+|emergency stop|Unknown command)/i.test(text)
}
export function visibleInNormalConsole(
  direction: MessageDirection, content: string, origin: ConsoleOrigin = 'operator',
): boolean {
  if (direction === 'ERR' || direction === 'SYS') return true
  if (direction === 'RX' && isCriticalMarlinOutput(content)) return true
  if (direction === 'RX' && /^\s*echo:busy:/i.test(content)) return false
  if (direction === 'RX' && /^\s*start\s*$/i.test(content)) return true
  return origin === 'operator' || origin === 'startup'
}
export function normalConsoleEntry(entry: ConsoleEntry): boolean {
  return entry.visibleInNormal !== false
}
