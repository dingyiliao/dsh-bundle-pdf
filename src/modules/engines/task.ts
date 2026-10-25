/** Bound availability probes too: a removed plugin must not retain a hanging RPC. */
export async function engineProbe<T, P>(tasks: Map<AbortController, P>, provider: P, signal: AbortSignal,
  errors: { cancelled(): Error; timeout(): Error }, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  tasks.set(controller, provider)
  const abort = () => controller.abort(errors.cancelled())
  const timer = setTimeout(() => controller.abort(errors.timeout()), 30_000)
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  let rejectAbort!: () => void
  const cancellation = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(controller.signal.reason)
    controller.signal.addEventListener('abort', rejectAbort, { once: true })
    if (controller.signal.aborted) rejectAbort()
  })
  try {
    controller.signal.throwIfAborted()
    return await Promise.race([operation(controller.signal), cancellation])
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', abort)
    controller.signal.removeEventListener('abort', rejectAbort); tasks.delete(controller)
  }
}
