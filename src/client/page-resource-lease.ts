import type { ReaderPage } from './reader-document.js'

interface LeaseState {
  owners: number
  timer?: ReturnType<typeof setTimeout>
  attempts: number
}

const leases = new WeakMap<ReaderPage, LeaseState>()

/** Keep PDF.js operator lists and decoded page objects only while a view uses them. */
export function leasePageResources(page: ReaderPage): () => void {
  let state = leases.get(page)
  if (!state) {
    state = { owners: 0, attempts: 0 }
    leases.set(page, state)
  }
  if (state.timer !== undefined) clearTimeout(state.timer)
  state.timer = undefined
  state.attempts = 0
  state.owners++
  const current = state
  let released = false
  return () => {
    if (released) return
    released = true
    if (--current.owners > 0) return
    // A cancelled render can still be settling when the view unmounts.
    // Delay cleanup so a quick scroll back can reuse its decoded resources.
    const attempt = () => {
      current.timer = undefined
      if (current.owners > 0) return
      try {
        if (page.cleanup()) { leases.delete(page); return }
      } catch { leases.delete(page); return } // The document may already be destroyed.
      if (++current.attempts < 8) current.timer = setTimeout(attempt, 100)
      else leases.delete(page)
    }
    current.timer = setTimeout(attempt, 250)
  }
}
