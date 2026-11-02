import { indexingDiagnosticsRequestSchema, indexingDiagnosticsResultSchema } from '../../../contracts/indexing-diagnostics.js'
import type { createIndexingDiagnostics } from './indexing-diagnostics.js'

interface DesktopPaths {
  canOpenWorkspacePath?(): boolean
  openWorkspacePath?(request: { path: string }, signal: AbortSignal): Promise<unknown>
}

/** Authenticated UI diagnostics can only open the Host-owned log directory. */
export function createIndexingDiagnosticRoute(ports: {
  diagnostics: Pick<ReturnType<typeof createIndexingDiagnostics>, 'read'>
  directory: string
  documents(): readonly { sessionId: string; id: string }[]
  flush(): Promise<void>
  desktop: DesktopPaths
  authorize(sessionId: string, signal: AbortSignal): Promise<void>
}) {
  return async (sessionId: string, input: unknown, signal: AbortSignal) => {
    const request = indexingDiagnosticsRequestSchema.parse(input)
    signal.throwIfAborted()
    if (request.sessionId !== sessionId) throw Object.assign(new Error('Session identity mismatch.'), { code: 'pdf/session-mismatch' })
    if (!ports.documents().some(document => document.sessionId === sessionId && document.id === request.documentId)) {
      throw Object.assign(new Error('Open this PDF before reading its indexing diagnostics.'), { code: 'pdf/unknown-document' })
    }
    const value = request.action === 'report' ? ports.diagnostics.read(sessionId, request.documentId, request.occurrence)
      : { version: 1, logDirectory: ports.directory }
    const canOpen = !!ports.desktop.openWorkspacePath && ports.desktop.canOpenWorkspacePath?.() === true
    if (request.action === 'open') {
      if (!canOpen) throw Object.assign(new Error('Opening the Host log directory is unavailable on this deployment.'), { code: 'pdf/log-directory-unavailable' })
      await ports.flush()
      signal.throwIfAborted()
      await ports.authorize(sessionId, signal)
      await ports.desktop.openWorkspacePath!({ path: value.logDirectory }, signal)
    }
    await ports.authorize(sessionId, signal)
    signal.throwIfAborted()
    return indexingDiagnosticsResultSchema.parse({ directory: value.logDirectory, report: JSON.stringify(value, null, 2), canOpen })
  }
}
