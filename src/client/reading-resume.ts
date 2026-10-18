/** Apply an asynchronous fallback only if no newer navigation was requested. */
export async function applyIfNoNewerNavigation<T>(
  load: () => Promise<T>,
  currentIntent: () => number,
  signal: AbortSignal,
  apply: (value: T) => Promise<void>,
): Promise<boolean> {
  const intent = currentIntent()
  const value = await load()
  if (signal.aborted || currentIntent() !== intent) return false
  await apply(value)
  return true
}
