/** Host-authenticated caller identity passed from the RPC surface into PDF operations. */
export interface PdfAgent {
  readonly session: { readonly id: string; readonly header: { readonly cwd?: string } }
}

/** One domain operation dispatched through the authenticated PDF RPC endpoint. */
export type PdfDispatch = (
  sessionId: string,
  input: Record<string, unknown>,
  agent: PdfAgent,
  signal: AbortSignal,
) => Promise<unknown>
