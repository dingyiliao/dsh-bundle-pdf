/** PDF coordinates remain stable when the sidebar size or rendering scale changes. */
export interface NavigationPosition {
  documentVersion: string
  page: number
  x: number
  y: number
  scale: number
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
  status: 'changed' | 'noop' | 'empty' | 'cancelled' | 'stale'
  position?: NavigationPosition
}

/** Positions are ordered from the next return destination to the oldest one. */
export interface NavigationHistorySnapshot {
  readonly revision: number
  readonly positions: readonly (Readonly<Omit<NavigationPosition, 'viewportAnchor'>> & {
    readonly viewportAnchor?: Readonly<NonNullable<NavigationPosition['viewportAnchor']>>
  })[]
}

function copy(position: NavigationPosition): NavigationPosition {
  return { ...position, ...(position.viewportAnchor ? { viewportAnchor: { ...position.viewportAnchor } } : {}) }
}

function validate(position: NavigationPosition): void {
  if (!position.documentVersion || !Number.isInteger(position.page) || position.page < 1
    || ![position.x, position.y, position.scale].every(Number.isFinite)
    || position.scale <= 0
    || !['custom', 'width', 'page'].includes(position.fit)
    || (position.viewportAnchor && ![position.viewportAnchor.x, position.viewportAnchor.y].every((n) => Number.isFinite(n) && n >= 0 && n <= 1))) {
    throw new RangeError('Invalid PDF navigation position.')
  }
}

export function sameNavigationPosition(left: NavigationPosition, right: NavigationPosition): boolean {
  const near = (a: number, b: number) => Math.abs(a - b) < 0.001
  return left.documentVersion === right.documentVersion && left.page === right.page
    && near(left.x, right.x) && near(left.y, right.y) && near(left.scale, right.scale)
    && left.fit === right.fit
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
  private revision = 0

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

  snapshot(): NavigationHistorySnapshot {
    return { revision: this.revision, positions: [...this.entries].reverse().map(copy) }
  }

  setCapacity(capacity: number): void {
    if (!Number.isInteger(capacity) || capacity < 0 || capacity > 1000) throw new RangeError('Navigation capacity must be between 0 and 1000.')
    if (capacity !== this.capacity) {
      this.revision++
      for (const controller of this.pending) controller.abort()
    }
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
    this.revision++
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
        this.revision++
      }
      return { status: 'changed', position: actual }
    }, signal)
  }

  back(adapter: Pick<NavigationAdapter, 'apply'>, signal?: AbortSignal): Promise<NavigationResult> {
    return this.returnTo(0, undefined, adapter, signal)
  }

  /** Return to a snapshot entry (0 is newest), removing it and all newer entries only after arrival. */
  backTo(depth: number, revision: number, adapter: Pick<NavigationAdapter, 'apply'>, signal?: AbortSignal): Promise<NavigationResult> {
    if (!Number.isInteger(depth) || depth < 0) throw new RangeError('Navigation history depth must be a non-negative integer.')
    if (!Number.isInteger(revision) || revision < 0) throw new RangeError('Navigation history revision must be a non-negative integer.')
    return this.returnTo(depth, revision, adapter, signal)
  }

  private returnTo(depth: number, revision: number | undefined, adapter: Pick<NavigationAdapter, 'apply'>, signal?: AbortSignal): Promise<NavigationResult> {
    return this.enqueue(async (operationSignal) => {
      if (revision !== undefined && revision !== this.revision) return { status: 'stale' }
      const index = this.entries.length - 1 - depth
      const entry = this.entries[index]
      const target = entry && copy(entry)
      if (!target) return { status: 'empty' }
      const actual = copy(await adapter.apply(copy(target), operationSignal))
      if (operationSignal.aborted) return { status: 'cancelled' }
      validate(actual)
      const expected = target.fit === 'custom' ? target : { ...target, scale: actual.scale }
      if (!sameNavigationPosition(actual, expected)) {
        throw new Error('Could not restore the previous PDF position.')
      }
      // A resize may legitimately change the effective scale in fit mode.
      this.entries.splice(index)
      this.revision++
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
