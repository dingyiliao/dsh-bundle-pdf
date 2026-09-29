/** Minimal public Host surfaces used by this external plugin, pinned to DSH 0.2.0-rc.1.
 * Runtime implementations are supplied by the installed Harness profile.
 */
declare module '@deepseek-ai/schemastery' {
  interface Schema {
    default(value: unknown): Schema
    volatile(): Schema
    min(value: number): Schema
    max(value: number): Schema
    pattern(value: RegExp): Schema
  }
  const schema: {
    string(): Schema
    natural(): Schema
    object(shape: Record<string, Schema>): Schema
  }
  export default schema
}
declare module '@deepseek-ai/dsh-storage-domain' {
  import type { ZodType } from 'zod'
  export interface DomainSpec {
    name: string; version: number; layout: 'per-record'
    tables: Record<string, { valueSchema: ZodType }>
  }
  export function defineDomain<T extends DomainSpec>(spec: T): T
  export function domainTable<T>(schema: ZodType<T>): { valueSchema: ZodType<T> }
}
declare module '*.css' { const value: string; export default value }
