import type { NativeReply, NativeRequest } from '../protocol/commands.js'

type RequestFor<C extends NativeRequest['command'], R> = R extends { command: infer K }
  ? C extends K ? R : never
  : never
export type NativeRequestFor<C extends NativeRequest['command']> = RequestFor<C, NativeRequest>
type PayloadFor<R> = R extends unknown ? Omit<R, 'command'> : never
export type NativePayloadFor<C extends NativeRequest['command']> = PayloadFor<NativeRequestFor<C>>

/**
 * Host-facing PDF port. Domain services depend on this contract rather than
 * the worker process implementation, so a patched PDFium backend or another
 * NativePdfPort can be substituted without changing document logic.
 */
export interface NativePdfPort {
  readonly generation: number
  readonly encryptedOpen: boolean
  readonly encryptedAnnotationEdit: boolean
  readonly selectionGeometry: boolean
  readonly documentExtensions: boolean
  ready(): Promise<void>
  openDocument(documentId: string, bytes: Uint8Array, options?: { password?: string; metadataOnly?: true }): Promise<NativeReply<'open'>>
  closeDocument(documentId: string): Promise<void>
  inspectSecurity(request: NativePayloadFor<'security'>, signal?: AbortSignal, priority?: number): Promise<NativeReply<'security'>>
  inspectDocument(request: NativePayloadFor<'documentInfo'>, signal?: AbortSignal, priority?: number): Promise<NativeReply<'documentInfo'>>
  getPageFingerprints(request: NativePayloadFor<'fingerprints'>, signal?: AbortSignal, priority?: number): Promise<NativeReply<'fingerprints'>>
  readOutlines(request: NativePayloadFor<'documentOutlines'>, signal?: AbortSignal, priority?: number): Promise<NativeReply<'documentOutlines'>>
  readOutlineTree(request: NativePayloadFor<'outline'>, signal?: AbortSignal, priority?: number): Promise<NativeReply<'outline'>>
  listAnnotationPages(request: NativePayloadFor<'annotationPages'>, signal?: AbortSignal, priority?: number): Promise<NativeReply<'annotationPages'>>
  inspectFormFields(request: NativePayloadFor<'formFields'>, signal?: AbortSignal, priority?: number): Promise<NativeReply<'formFields'>>
  writeOutlines(request: NativePayloadFor<'applyOutlines'>, signal?: AbortSignal, priority?: number): Promise<NativeReply<'applyOutlines'>>
  writeFormFields(request: NativePayloadFor<'applyFormFields'>, bytes: Uint8Array, signal?: AbortSignal, priority?: number): Promise<NativeReply<'applyFormFields'>>
  readAnnotations(request: NativePayloadFor<'annotations'>, signal?: AbortSignal, priority?: number): Promise<NativeReply<'annotations'>>
  editAnnotation(request: NativePayloadFor<'annotationEdit'>, signal?: AbortSignal, priority?: number): Promise<NativeReply<'annotationEdit'>>
  readText(request: NativePayloadFor<'text'>, signal?: AbortSignal, priority?: number): Promise<NativeReply<'text'>>
  readLinks(request: NativePayloadFor<'links'>, signal?: AbortSignal, priority?: number): Promise<NativeReply<'links'>>
  readSelectionGeometry(request: NativePayloadFor<'selectionGeometry'>, signal?: AbortSignal, priority?: number): Promise<NativeReply<'selectionGeometry'>>
  resolveDestination(request: NativePayloadFor<'destination'>, signal?: AbortSignal, priority?: number): Promise<NativeReply<'destination'>>
  renderPage(request: NativePayloadFor<'render'>, signal?: AbortSignal, priority?: number): Promise<NativeReply<'render'>>
  inspectPage(request: NativePayloadFor<'inspect'>, signal?: AbortSignal, priority?: number): Promise<NativeReply<'inspect'>>
  materializeCopy(request: NativePayloadFor<'saveCopy'>, signal?: AbortSignal, priority?: number): Promise<NativeReply<'saveCopy'>>
  readMaterializedChunk(request: NativePayloadFor<'saveChunk'>, signal?: AbortSignal, priority?: number): Promise<NativeReply<'saveChunk'>>
  request<T extends NativeRequest>(request: T, bytes?: Uint8Array, signal?: AbortSignal,
    priority?: number): Promise<NativeReply<T['command']>>
  dispose(): Promise<void>
}

