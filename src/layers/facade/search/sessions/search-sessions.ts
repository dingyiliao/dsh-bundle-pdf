import { randomBytes } from 'node:crypto'

export interface SearchSessionOptions {
  prefix: string
  maxEntries?: number
  ttlMs?: number
  now?: () => number
}

interface SearchRecord<Start> {
  searchId: string
  sessionId: string
  input: Start
  cursor?: string
  complete: boolean
  busy: boolean
  touched: number
  invalidated?: Error
}

function error(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

/** Host-owned progress only: callers must reauthorize the document on every invocation. */
export function createSearchSessions<Start extends { documentId: string }>(options: SearchSessionOptions) {
  const { prefix, maxEntries = 64, ttlMs = 30 * 60 * 1000, now = Date.now } = options
  if (!prefix || !Number.isSafeInteger(maxEntries) || maxEntries < 1
    || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new TypeError('Search sessions require a prefix and positive capacity and expiry')
  }
  const records = new Map<string, SearchRecord<Start>>()
  let disposed = false

  function assertAvailable(): void {
    if (disposed) throw error('pdf/unavailable', 'PDF search tools are unavailable')
  }

  function prune(): void {
    const expiry = now() - ttlMs
    for (const [id, record] of records) {
      if (!record.busy && record.touched <= expiry) records.delete(id)
    }
  }

  function touch(record: SearchRecord<Start>): void {
    record.touched = now()
    // Map order breaks equal-clock ties and provides deterministic LRU eviction.
    records.delete(record.searchId)
    records.set(record.searchId, record)
  }

  function lookup(sessionId: string, searchId: string): SearchRecord<Start> {
    assertAvailable()
    if (typeof searchId !== 'string' || !searchId.startsWith(prefix)) {
      throw error('pdf/invalid-search', 'Search ID does not belong to this PDF search tool; start a new search')
    }
    if (!/^[a-f0-9]{12}$/.test(searchId.slice(prefix.length))) {
      throw error('pdf/invalid-search', 'Invalid PDF search ID; start a new search')
    }
    prune()
    const record = records.get(searchId)
    if (!record || record.sessionId !== sessionId) {
      throw error('pdf/unknown-search', 'PDF search is unknown or expired in this session; start a new search')
    }
    touch(record)
    return record
  }

  function create(sessionId: string, input: Start): SearchRecord<Start> {
    if (!input || typeof input.documentId !== 'string' || !input.documentId) {
      throw error('pdf/invalid-search', 'A new PDF search requires a documentId')
    }
    // Clone before evicting anything: an invalid/uncloneable request cannot evict a valid search.
    const original = structuredClone(input)
    prune()
    if (records.size >= maxEntries) {
      const oldest = [...records.values()].find(record => !record.busy)
      if (!oldest) throw error('pdf/search-capacity', 'All PDF search sessions are busy; retry after a search finishes')
      records.delete(oldest.searchId)
    }
    let searchId: string
    do { searchId = `${prefix}${randomBytes(6).toString('hex')}` } while (records.has(searchId))
    const record: SearchRecord<Start> = {
      searchId, sessionId, input: original, complete: false, busy: false, touched: now(),
    }
    records.set(searchId, record)
    return record
  }

  return {
    documentId(sessionId: string, searchId: string): string {
      return lookup(sessionId, searchId).input.documentId
    },

    async run<Result extends object>(sessionId: string, input: Start | { searchId: string },
      signal: AbortSignal,
      step: (input: Start, cursor: string | undefined) => Promise<{ value: Result; nextCursor?: string | null }>,
    ): Promise<Result & { searchId: string; hasMore: boolean }> {
      assertAvailable()
      signal.throwIfAborted()
      const continuation = input !== null && typeof input === 'object' && 'searchId' in input
      if (continuation && Object.keys(input).some(key => key !== 'searchId')) {
        throw error('pdf/invalid-search', 'Continue a PDF search with searchId only; start a new search to change options')
      }
      const record = continuation ? lookup(sessionId, input.searchId as string) : create(sessionId, input as Start)
      if (record.busy) throw error('pdf/search-busy', 'This PDF search is already advancing; wait for its current result')
      if (record.complete) throw error('pdf/search-complete', 'This PDF search is complete; start a new search to run it again')
      record.busy = true
      try {
        // Each step gets a copy so neither the caller nor a step can alter future arguments.
        // Await the real operation even after cancellation: the caller owns its document pin.
        const result = await step(structuredClone(record.input), record.cursor)
        signal.throwIfAborted()
        if (record.invalidated) throw record.invalidated
        record.cursor = result.nextCursor || undefined
        record.complete = !record.cursor
        return { ...result.value, searchId: record.searchId, hasMore: !record.complete }
      } catch (cause) {
        // Failed first pages never exposed their ID and must not consume the retained budget.
        if (!continuation && records.get(record.searchId) === record) records.delete(record.searchId)
        throw cause
      } finally {
        record.busy = false
        if (records.get(record.searchId) === record) touch(record)
      }
    },

    deleteSession(sessionId: string): void {
      for (const [id, record] of records) {
        if (record.sessionId !== sessionId) continue
        record.invalidated = error('pdf/session-disposed', 'The PDF search session was disposed; start a new search')
        records.delete(id)
      }
    },

    dispose(): void {
      disposed = true
      for (const record of records.values()) {
        record.invalidated = error('pdf/unavailable', 'PDF search tools were disposed')
      }
      records.clear()
    },
  }
}
