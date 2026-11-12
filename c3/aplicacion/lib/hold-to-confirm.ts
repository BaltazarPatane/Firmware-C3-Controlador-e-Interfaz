/** A continuous hold; releasing, losing focus or hiding the page cancels it. */
export const EMERGENCY_HOLD_MS = 1000

export class HoldToConfirm {
  private started: number | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  constructor(
    private readonly confirm: () => void,
    private readonly progress: (fraction: number) => void,
    private readonly clock = () => performance.now(),
    private readonly schedule = (fn: () => void) => setTimeout(fn, 16),
    private readonly unschedule = (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  ) {}
  begin() {
    if (this.started !== null) return
    this.started = this.clock()
    this.tick()
  }
  cancel() {
    if (this.timer !== null) this.unschedule(this.timer)
    this.timer = null
    this.started = null
    this.progress(0)
  }
  private tick = () => {
    this.timer = null
    if (this.started === null) return
    const elapsed = this.clock() - this.started
    this.progress(Math.min(1, elapsed / EMERGENCY_HOLD_MS))
    if (elapsed >= EMERGENCY_HOLD_MS) {
      this.started = null
      this.confirm()
      return
    }
    this.timer = this.schedule(this.tick)
  }
}
