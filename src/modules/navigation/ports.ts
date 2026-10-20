import type { HostWorkspaceSnapshot } from '../working-copy/index.js'

export interface NavigationWorkspaces {
  readSnapshot(sessionId: string, documentId: string): HostWorkspaceSnapshot
  bytesHash(bytes: Uint8Array): string
}

export interface NavigationAgent {
  readonly session: { readonly id: string; readonly header: { readonly cwd?: string } }
}

export type NavigationDispatch = (sessionId: string, raw: Record<string, unknown>,
  agent: NavigationAgent, signal: AbortSignal) => Promise<unknown>

export interface NavigationTable<T> {
  get(key: string): T | undefined
  put(key: string, record: T): Promise<unknown>
  delete(key: string): Promise<unknown>
}

/** V1 path-key algorithm remains an adapter concern, not a feature assumption. */
export interface NavigationStore<T> extends NavigationTable<T> {
  key(path: string): string
  samePath(left: string, right: string): boolean
}
