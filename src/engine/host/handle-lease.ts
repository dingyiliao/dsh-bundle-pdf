interface Waiter {
  admit(): void
  cancel(reason: unknown): void
}

const maximumForegroundBurst = 4

/** Serialize access to mutable native document handles, giving Reader tiles a bounded fast lane. */
export function createNativeHandleLease() {
  const foreground: Waiter[] = []
  const normal: Waiter[] = []
  let active = false
  let foregroundBurst = 0
  let closed: Error | undefined

  function admitNext(): void {
    if (active) return
    const useForeground = foreground.length > 0 && (!normal.length || foregroundBurst < maximumForegroundBurst)
    const next = (useForeground ? foreground : normal).shift()
    foregroundBurst = useForeground && normal.length ? foregroundBurst + 1 : 0
    if (!next) return
    active = true
    next.admit()
  }

  async function run<T>(task: () => Promise<T>, signal?: AbortSignal, preferForeground = false): Promise<T> {
    signal?.throwIfAborted()
    if (closed) throw closed
    await new Promise<void>((resolve, reject) => {
      const queue = preferForeground ? foreground : normal
      const abort = () => {
        queue.splice(queue.indexOf(waiter), 1)
        waiter.cancel(signal?.reason)
      }
      const cleanup = () => signal?.removeEventListener('abort', abort)
      const waiter: Waiter = {
        admit() { cleanup(); resolve() },
        cancel(reason) { cleanup(); reject(reason) },
      }
      queue.push(waiter)
      signal?.addEventListener('abort', abort, { once: true })
      admitNext()
    })
    // Resume in the submitting caller's async context, including index metrics.
    try {
      signal?.throwIfAborted()
      if (closed) throw closed
      return await task()
    } finally {
      active = false
      admitNext()
    }
  }

  function close(reason: Error): void {
    closed = reason
    for (const queue of [foreground, normal]) {
      for (const waiter of queue.splice(0)) waiter.cancel(reason)
    }
  }

  return { run, close }
}
