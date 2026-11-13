/** Wait for a Reader-owned state transition without leaking event listeners. */
export function waitForReaderState<T>(
  target: EventTarget,
  eventName: string,
  read: () => T | undefined,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let listening = false
    let abortListening = false
    let settled = false

    const cleanup = () => {
      if (listening) target.removeEventListener(eventName, onChange)
      if (abortListening) signal.removeEventListener('abort', onAbort)
      if (timer !== undefined) clearTimeout(timer)
    }
    const finish = (value: T) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const fail = (reason: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(reason)
    }
    const check = () => {
      if (settled) return
      try {
        const value = read()
        if (value !== undefined) finish(value)
      } catch (error) {
        fail(error)
      }
    }
    const onChange = () => check()
    const onAbort = () => fail(signal.reason ?? new DOMException('Reader wait aborted', 'AbortError'))

    if (signal.aborted) {
      onAbort()
      return
    }
    check()
    if (settled) return

    try {
      listening = true
      target.addEventListener(eventName, onChange)
      if (settled) return
      abortListening = true
      signal.addEventListener('abort', onAbort)
    } catch (error) {
      fail(error)
      return
    }

    if (signal.aborted) onAbort()
    else check()
    if (!settled) {
      timer = setTimeout(() => fail(new DOMException('Reader state did not become ready', 'TimeoutError')), timeoutMs)
    }
  })
}
