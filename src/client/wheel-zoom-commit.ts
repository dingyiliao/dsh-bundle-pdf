export interface ZoomCommitClock {
  set(callback: () => void, delay: number): ReturnType<typeof setTimeout>
  clear(handle: ReturnType<typeof setTimeout>): void
}

export interface ZoomFrameClock {
  request(callback: () => void): number
  cancel(handle: number): void
}

const browserClock: ZoomCommitClock = {
  set: (callback, delay) => setTimeout(callback, delay),
  clear: (handle) => clearTimeout(handle),
}

const browserFrameClock: ZoomFrameClock = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
}

/** Commit a continuous wheel gesture once it has been quiet for the given interval. */
export function createWheelZoomCommit(
  commit: (scale: number) => void,
  delay = 160,
  clock: ZoomCommitClock = browserClock,
) {
  let handle: ReturnType<typeof setTimeout> | undefined
  let pending: number | undefined

  const cancel = () => {
    if (handle !== undefined) clock.clear(handle)
    handle = undefined
    pending = undefined
  }

  const flush = () => {
    const scale = pending
    cancel()
    if (scale !== undefined) commit(scale)
  }

  return {
    schedule(scale: number) {
      pending = scale
      if (handle !== undefined) clock.clear(handle)
      handle = clock.set(flush, delay)
    },
    flush,
    cancel,
  }
}

/** Retry the post-commit anchor restore without retaining a stale preview forever. */
export function createBoundedFrameRetry(callback: () => void, limit = 60, clock: ZoomFrameClock = browserFrameClock) {
  let handle: number | undefined
  let attempts = 0
  return {
    schedule(): boolean {
      if (handle !== undefined) return true
      if (attempts >= limit) return false
      attempts++
      handle = clock.request(() => { handle = undefined; callback() })
      return true
    },
    reset() {
      if (handle !== undefined) clock.cancel(handle)
      handle = undefined
      attempts = 0
    },
  }
}
