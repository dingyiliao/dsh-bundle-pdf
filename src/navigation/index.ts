/** PDF coordinates remain stable when the sidebar size or rendering scale changes. */
export interface NavigationPosition {
  documentVersion: string
  page: number
  x: number
  y: number
  scale: number
  rotation: number
  fit: 'custom' | 'width' | 'page'
  /** Where the PDF anchor sits in the viewport, as fractions of width/height. */
  viewportAnchor?: { x: number; y: number }
}

export interface NavigationAdapter {
  /** Read the viewport just before an operation starts, not when a link was parsed. */
  capture(): NavigationPosition
  /** Resolve after the actual viewport has settled. Reject if the target cannot be applied. */
  apply(position: NavigationPosition, signal: AbortSignal): NavigationPosition | Promise<NavigationPosition>
}

export interface NavigationResult {
  status: 'changed' | 'noop' | 'empty' | 'cancelled'
  position?: NavigationPosition
}

function copy(position: NavigationPosition): NavigationPosition {
  return { ...position, ...(position.viewportAnchor ? { viewportAnchor: { ...position.viewportAnchor } } : {}) }
}

function validate(position: NavigationPosition): void {
  if (!position.documentVersion || !Number.isInteger(position.page) || position.page < 1
    || ![position.x, position.y, position.scale, position.rotation].every(Number.isFinite)
    || position.scale <= 0 || position.rotation % 90 !== 0
    || !['custom', 'width', 'page'].includes(position.fit)
    || (position.viewportAnchor && ![position.viewportAnchor.x, position.viewportAnchor.y].every((n) => Number.isFinite(n) && n >= 0 && n <= 1))) {
    throw new RangeError('Invalid PDF navigation position.')
  }
}

export function sameNavigationPosition(left: NavigationPosition, right: NavigationPosition): boolean {
  const near = (a: number, b: number) => Math.abs(a - b) < 0.001
  return left.documentVersion === right.documentVersion && left.page === right.page
    && near(left.x, right.x) && near(left.y, right.y) && near(left.scale, right.scale)
    && ((left.rotation - right.rotation) % 360 === 0) && left.fit === right.fit
    && near(left.viewportAnchor?.x ?? 0, right.viewportAnchor?.x ?? 0)
    && near(left.viewportAnchor?.y ?? 0, right.viewportAnchor?.y ?? 0)
}

/** One history instance belongs to one PDF tab. Ordinary scrolling never calls jump. */
export class NavigationHistory {
  private readonly entries: NavigationPosition[] = []
  private queue: Promise<unknown> = Promise.resolve()
  private readonly pending = new Set<AbortController>()
  private documentVersion: string | undefined
  private capacity: number

  constructor(options: { capacity?: number } = {}) {
    this.capacity = options.capacity ?? 100
    this.setCapacity(this.capacity)
  }

  get size(): number { return this.entries.length }
  get canGoBack(): boolean { return this.entries.length > 0 }
  peek(): NavigationPosition | undefined {
    const entry = this.entries.at(-1)
    return entry ? copy(entry) : undefined
  }

  setCapacity(capacity: number): void {
    if (!Number.isInteger(capacity) || capacity < 0 || capacity > 1000) throw new RangeError('Navigation capacity must be between 0 and 1000.')
    this.capacity = capacity
    this.entries.splice(0, Math.max(0, this.entries.length - capacity))
  }

  /** Returns true only when a different source version invalidated the history. */
  resetForDocument(version: string): boolean {
    if (!version) throw new RangeError('Document version is required.')
    const changed = this.documentVersion !== undefined && this.documentVersion !== version
    if (changed) this.clear()
    this.documentVersion = version
    return changed
  }

  clear(): void {
    this.entries.length = 0
    for (const controller of this.pending) controller.abort()
  }

  jump(target: NavigationPosition, adapter: NavigationAdapter, signal?: AbortSignal): Promise<NavigationResult> {
    validate(target)
    const destination = copy(target)
    return this.enqueue(async (operationSignal) => {
      const origin = copy(adapter.capture())
      validate(origin)
      if (origin.documentVersion !== destination.documentVersion) throw new Error('The navigation target belongs to another document version.')
      this.assertVersion(origin.documentVersion)
      if (sameNavigationPosition(origin, destination)) return { status: 'noop', position: origin }
      const actual = copy(await adapter.apply(destination, operationSignal))
      if (operationSignal.aborted) return { status: 'cancelled' }
      validate(actual)
      if (actual.documentVersion !== origin.documentVersion) throw new Error('The document changed during navigation.')
      if (sameNavigationPosition(origin, actual)) return { status: 'noop', position: actual }
      if (this.capacity) {
        this.entries.push(origin)
        this.entries.splice(0, Math.max(0, this.entries.length - this.capacity))
      }
      return { status: 'changed', position: actual }
    }, signal)
  }

  back(adapter: Pick<NavigationAdapter, 'apply'>, signal?: AbortSignal): Promise<NavigationResult> {
    return this.enqueue(async (operationSignal) => {
      const target = this.peek()
      if (!target) return { status: 'empty' }
      const actual = copy(await adapter.apply(copy(target), operationSignal))
      if (operationSignal.aborted) return { status: 'cancelled' }
      validate(actual)
      const expected = target.fit === 'custom' ? target : { ...target, scale: actual.scale }
      if (!sameNavigationPosition(actual, expected)) {
        throw new Error('Could not restore the previous PDF position.')
      }
      // A resize may legitimately change the effective scale in fit mode.
      this.entries.pop()
      return { status: 'changed', position: actual }
    }, signal)
  }

  private assertVersion(version: string): void {
    if (this.documentVersion === undefined) this.documentVersion = version
    else if (this.documentVersion !== version) throw new Error('Reset navigation history after reloading the document.')
  }

  private enqueue(operation: (signal: AbortSignal) => Promise<NavigationResult>, signal?: AbortSignal): Promise<NavigationResult> {
    const controller = new AbortController()
    this.pending.add(controller)
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const task = this.queue.catch(() => undefined).then(async () => {
      if (controller.signal.aborted) return { status: 'cancelled' } as NavigationResult
      try { return await operation(controller.signal) } catch (error) {
        if (controller.signal.aborted) return { status: 'cancelled' } as NavigationResult
        throw error
      }
    }).finally(() => {
      signal?.removeEventListener('abort', abort)
      this.pending.delete(controller)
    })
    this.queue = task
    return task
  }
}
