import type { AgentNavigationRequest, TextNavigationTarget } from '../../../contracts/navigation.js'
import type { NavigationPosition } from '../../../navigation/index.js'
import type { WorkspaceSnapshot } from '../../../shared/contracts.js'
import type { NativeDocument } from '../rendering/document.js'
import { NativeViewport } from '../rendering/viewport.js'
import { readingSafeTop } from '../rendering/page-layout.js'
import { joinPageText } from '../../../shared/page-text.js'

export interface ReaderNavigationGuard {
  signal: AbortSignal
  /** Rechecked before and after asynchronous positioning; failure must not enter history. */
  validate(): void
}

export interface AgentTextNavigationOptions {
  current(): { snapshot: WorkspaceSnapshot | null; document: NativeDocument | null; visible: boolean; ready: boolean;
    viewportHeight: number }
  subscribe(documentId: string, changed: () => void): () => void
  jump(page: number, options?: Partial<NavigationPosition>, remember?: boolean, guard?: ReaderNavigationGuard): Promise<boolean>
  timeoutMs?: number
  hashText?(text: string): Promise<string>
}

async function hashText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`
}

function stale(): never { throw new Error('The visible PDF changed before evidence navigation completed') }

/** Pick the first verified glyph line in screen space, including cropped / rotated pages.
 * The model never supplies coordinates: these quads have been re-extracted by Host. */
export function textTargetPosition(snapshot: WorkspaceSnapshot, page: number, target: TextNavigationTarget,
  viewportHeight: number): Partial<NavigationPosition> {
  const geometry = snapshot.document.pages[page - 1]
  if (!geometry) return stale()
  const viewport = new NativeViewport(geometry, 1, geometry.rotation)
  const points = target.quadPoints.slice(0, 8)
  const screen = Array.from({ length: 4 }, (_, index) => viewport.convertToViewportPoint(points[index * 2], points[index * 2 + 1]))
  const left = Math.min(...screen.map(point => point[0])), top = Math.min(...screen.map(point => point[1]))
  const [x, y] = viewport.convertToPdfPoint(left, top)
  return { x, y, viewportAnchor: { x: 0.08,
    y: viewportHeight > 0 ? Math.min(0.45, readingSafeTop(viewportHeight) / viewportHeight + 0.05) : 0.2 } }
}

/** Wait only for the requested revision, then verify visible native text before using ordinary jump/history.
 * An ahead revision, a hidden tab, replaced bytes or cancellation never navigates. */
export async function navigateAgentRequest(request: AgentNavigationRequest, signal: AbortSignal,
  options: AgentTextNavigationOptions): Promise<'opened' | 'stale' | 'unavailable'> {
  try {
    signal.throwIfAborted()
    const target = request.target
    const inspect = () => {
      signal.throwIfAborted()
      const state = options.current(), snapshot = state.snapshot
      if (!state.visible || !snapshot || snapshot.id !== request.documentId
        || snapshot.contentVersion !== request.contentVersion || request.page > snapshot.document.pageCount) return stale()
      if (target && (snapshot.revision > target.revision || (snapshot.revision === target.revision
        && snapshot.reader.bytesHash !== target.sourceDigest))) return stale()
      return state
    }
    const nativeMatches = (state: ReturnType<typeof inspect>) => {
      const native = state.document?.snapshot, snapshot = state.snapshot!
      return native?.id === snapshot.id && native.contentVersion === snapshot.contentVersion
        && native.reader.bytesHash === snapshot.reader.bytesHash
    }
    // Watch snapshots arrive independently from the model RPC. A bounded wait
    // avoids using an old UI draft, without treating a normal watch delay as stale.
    const ready = await new Promise<ReturnType<typeof inspect>>((resolve, reject) => {
      let stop: (() => void) | undefined, poll: ReturnType<typeof setInterval> | undefined
      let timer: ReturnType<typeof setTimeout> | undefined, settled = false
      const cleanup = () => { stop?.(); clearInterval(poll); clearTimeout(timer); signal.removeEventListener('abort', abort) }
      const finish = (failure?: unknown, value?: ReturnType<typeof inspect>) => {
        if (settled) return
        settled = true; cleanup()
        if (failure) reject(failure)
        else resolve(value!)
      }
      const check = () => {
        try {
          const state = inspect()
          if (state.ready && nativeMatches(state) && (!target || state.snapshot!.revision === target.revision)) finish(undefined, state)
        } catch (failure) { finish(failure) }
      }
      const abort = () => finish(signal.reason ?? new DOMException('Navigation cancelled', 'AbortError'))
      signal.addEventListener('abort', abort, { once: true })
      check()
      if (settled) return
      stop = options.subscribe(request.documentId, check)
      if (settled) { stop(); return }
      // Native descriptor attachment is a separate React transition from the snapshot.
      poll = setInterval(check, 25)
      timer = setTimeout(() => finish(new DOMException('Reader revision did not become ready', 'TimeoutError')), options.timeoutMs ?? 10_000)
      check()
    })
    const validate = () => {
      const state = inspect()
      if (!state.ready || state.document !== ready.document || !nativeMatches(state)
        || (target && state.snapshot!.revision !== target.revision)) return stale()
    }
    if (!target) return await options.jump(request.page, {}, true, { signal, validate }) ? 'opened' : 'unavailable'
    const nativeSnapshot = ready.document!.snapshot
    if (nativeSnapshot.id !== request.documentId || nativeSnapshot.contentVersion !== request.contentVersion
      || nativeSnapshot.reader.bytesHash !== target.sourceDigest) return 'stale'
    const text = joinPageText((await ready.document!.text(request.page, signal)).items)
    const hash = options.hashText ?? hashText
    if (target.endUtf16 > text.length || await hash(text) !== target.pageTextDigest
      || await hash(text.slice(target.startUtf16, target.endUtf16)) !== target.textSha256) return 'stale'
    validate()
    const position = textTargetPosition(ready.snapshot!, request.page, target, ready.viewportHeight)
    return await options.jump(request.page, position, true, { signal, validate }) ? 'opened' : 'unavailable'
  } catch {
    return signal.aborted ? 'unavailable' : 'stale'
  }
}
