import type { Buffer } from 'node:buffer'
import { z } from 'zod'
import { nativeFormsSchema, type NativeFormEdit } from './forms.js'
import { selectionGeometryChunkLimit, selectionGeometryChunkSchema, type SelectionGeometryChunk } from './selection.js'

type DocumentRequest = { documentId: string }
type PageRequest = DocumentRequest & { pageIndex: number }
type BatchRequest = { offset: number; limit: number }
type AnnotationPatch = {
  id?: string
  contents?: string
  color?: readonly number[]
  rect?: readonly number[]
  modifiedAt?: string
  commentPosition?: readonly number[]
}
type NewAnnotation = AnnotationPatch & {
  id: string
  subtype: string
  quadPoints?: readonly number[]
  author?: string
  createdAt?: string
  opacity?: number
  replyParentIndex?: number
}

export type NativeRequest =
  | { command: 'hello' }
  | (DocumentRequest & { command: 'open'; password?: string; metadataOnly?: true })
  | (DocumentRequest & { command: 'close' | 'security' | 'outline' })
  | (DocumentRequest & Partial<BatchRequest> & { command: 'documentInfo' })
  | (DocumentRequest & BatchRequest & { command: 'fingerprints' })
  | (DocumentRequest & { command: 'documentOutlines' })
  | (DocumentRequest & BatchRequest & { command: 'annotationPages' })
  | (DocumentRequest & { command: 'applyOutlines'; entries: readonly {
    id: string; parentIndex: number; title?: string; pageIndex: number
  }[] })
  | (DocumentRequest & Partial<BatchRequest> & { command: 'formFields' })
  | (DocumentRequest & { command: 'applyFormFields'; edits: readonly NativeFormEdit[] })
  | (PageRequest & { command: 'text' | 'links' })
  | (PageRequest & Partial<BatchRequest> & { command: 'selectionGeometry' })
  | (DocumentRequest & { command: 'destination'; name: string })
  | (PageRequest & BatchRequest & { command: 'inspect' | 'annotations' })
  | (PageRequest & { command: 'render'; rotation: number; rasterWidth: number; rasterHeight: number;
    x: number; y: number; width: number; height: number; annotations?: boolean; forms?: boolean })
  | (PageRequest & { command: 'annotationEdit' } & (
    | { action: 'add'; annotation: NewAnnotation }
    | { action: 'update'; annotationIndex: number; patch: AnnotationPatch }
    | { action: 'delete'; annotationIndex: number; associatedPopup?: true }
  ))
  | (DocumentRequest & { command: 'saveCopy'; maxBytes?: number })
  | (DocumentRequest & { command: 'saveChunk'; offset: number; length: number })

const integer = z.number().int()
const nonnegative = integer.min(0)
const positive = integer.min(1)
const coordinate = z.number()
const rect = z.tuple([coordinate, coordinate, coordinate, coordinate])
const rotation = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])
const permissionMask = nonnegative.max(0xffffffff)
const cursor = nonnegative.nullable()
const destination = z.tuple([nonnegative, z.object({ name: z.string() })], coordinate.nullable()).nullable()
type NativeDestination = z.infer<typeof destination>

type OutlineItem = {
  title: string
  dest?: NativeDestination
  url?: string
  items: OutlineItem[]
}
const outlineItem: z.ZodType<OutlineItem> = z.object({
  title: z.string(), dest: destination.optional(), url: z.string().optional(),
  get items() { return z.array(outlineItem) },
})

export const nativeOpenProbeSchema = z.object({ pageCount: positive.max(100_000), formType: integer, signatureCount: integer,
  signatureStatus: z.union([z.literal(-1), z.literal(0), z.literal(1)]).optional(),
})
export const nativeSecuritySchema = z.object({
  securityRevision: integer, permissions: permissionMask, userPermissions: permissionMask.optional(),
})
export const nativeDocumentInfoSchema = z.object({
  securityRevision: integer,
  permissions: permissionMask,
  title: z.string().optional(),
  pages: z.array(z.object({
    page: positive, mediaBox: rect, cropBox: rect, visibleBox: rect,
    boxSource: z.enum(['page-dictionary', 'effective-bounds']), rotation,
    renderedWidth: coordinate.positive(), renderedHeight: coordinate.positive(),
    userUnit: coordinate.positive().nullable(),
  })),
})
export const nativeTextContentSchema = z.object({
  items: z.array(z.object({
    str: z.string(), transform: z.tuple([coordinate, coordinate, coordinate, coordinate, coordinate, coordinate]),
    width: coordinate, height: coordinate, dir: z.string(), fontName: z.string(), hasEOL: z.boolean(),
    glyphs: z.array(z.tuple([coordinate, coordinate, coordinate.positive()])).max(200_000).optional(),
  })).max(10_000),
  styles: z.record(z.string(), z.object({
    fontFamily: z.string(), ascent: coordinate, descent: coordinate, vertical: z.boolean(),
  })),
  lang: z.string().nullable(),
  quality: z.object({ unmappedCharacters: nonnegative }).optional(),
})
export const nativeAnnotationBatchSchema = z.object({
  annotations: z.array(z.object({
    index: nonnegative, subtype: z.string().min(1).max(128),
    rect: rect.optional(), quadPoints: z.array(coordinate).max(32_000).optional(),
    color: z.tuple([coordinate, coordinate, coordinate]).optional(),
    opacity: coordinate.optional(), flags: nonnegative, editable: z.boolean(), id: z.string().max(512).optional(),
    contents: z.string().optional(), author: z.string().optional(),
    createdAt: z.string().optional(), modifiedAt: z.string().optional(),
    object: nonnegative.optional(), referenceId: z.string().regex(/^ref:\d+:\d+$/).optional(),
    replyType: z.union([z.literal(-1), z.literal(1), z.literal(2)]).optional(),
    replyParent: nonnegative.optional(), popup: nonnegative.optional(), hasRichText: z.literal(true).optional(),
    commentPosition: z.tuple([coordinate, coordinate]).optional(),
    linkAction: z.enum(['FirstPage', 'LastPage', 'NextPage', 'PrevPage']).optional(),
  })).max(64),
  nextOffset: cursor,
})

const savedSize = positive.max(128 * 1024 * 1024)
const outlineEntries = z.array(z.object({
  id: z.string().min(1).max(512), title: z.string(), parentIndex: integer.min(-1), pageIndex: integer.min(-1).max(99_999),
})).max(20_000)
const responseSchemas = {
  hello: z.object({
    protocolVersion: integer, build: z.string(), engine: z.literal('pdfium').optional(),
    encryptedOpen: z.boolean().optional(), encryptedAnnotationEdit: z.boolean().optional(), selectionGeometry: z.boolean().optional(),
    documentExtensions: z.boolean().optional(),
  }),
  open: nativeOpenProbeSchema,
  close: z.object({ closed: z.literal(true) }),
  security: nativeSecuritySchema,
  documentInfo: nativeDocumentInfoSchema,
  fingerprints: z.object({ digests: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable()).max(512) }),
  documentOutlines: z.union([z.object({ entries: outlineEntries }), z.object({ readOnlyReason: z.string().min(1) })]),
  annotationPages: z.object({ pageIndices: z.array(nonnegative.max(99_999)).max(2048) }),
  applyOutlines: z.object({ changed: z.literal(true) }),
  formFields: nativeFormsSchema,
  applyFormFields: z.object({ changed: z.literal(true) }),
  text: nativeTextContentSchema,
  selectionGeometry: selectionGeometryChunkSchema,
  outline: z.array(outlineItem).nullable(),
  destination,
  links: z.array(z.object({
    id: z.string(), subtype: z.literal('Link'), rect, quadPoints: z.array(coordinate).max(32_000).optional(),
    dest: destination.optional(), url: z.string().optional(),
  })).max(10_000),
  inspect: z.object({
    objects: z.array(z.object({ index: nonnegative, type: integer, bounds: rect, editable: z.literal(false) })).max(100),
    nextOffset: cursor,
  }),
  render: z.object({ width: positive.max(1026), height: positive.max(1026), format: z.literal('rgba') }),
  annotations: nativeAnnotationBatchSchema,
  annotationEdit: z.object({ changed: z.literal(true), index: nonnegative.optional() }),
  saveCopy: z.object({ size: savedSize }),
  saveChunk: z.object({ offset: nonnegative, size: savedSize }),
} satisfies Record<NativeRequest['command'], z.ZodType>

type Command = keyof typeof responseSchemas
export interface NativeReply<C extends Command = Command> {
  value: z.infer<(typeof responseSchemas)[C]>
  bytes: Buffer
}

/** The native worker may be a separately installed binary. Reject mismatches at the IPC boundary. */
export function decodeNativeReply<T extends NativeRequest>(request: T, value: unknown, bytes: Buffer): NativeReply<T['command']> {
  const result = responseSchemas[request.command].parse(value) as NativeReply<T['command']>['value']
  switch (request.command) {
    case 'render': {
      const tile = result as NativeReply<'render'>['value']
      if (tile.width !== request.width || tile.height !== request.height
        || bytes.byteLength !== tile.width * tile.height * 4) throw new Error('Invalid native tile payload')
      break
    }
    case 'saveChunk': {
      const chunk = result as NativeReply<'saveChunk'>['value']
      if (chunk.offset !== request.offset || bytes.byteLength !== request.length
        || chunk.offset + bytes.byteLength > chunk.size) throw new Error('Invalid native save payload')
      break
    }
    case 'selectionGeometry': {
      const chunk = result as SelectionGeometryChunk
      const offset = request.offset ?? 0
      const end = chunk.nextOffset ?? chunk.charCount
      if (chunk.offset !== offset || end > offset + (request.limit ?? selectionGeometryChunkLimit) + 1) {
        throw new Error('Invalid native selection cursor')
      }
      if (bytes.byteLength) throw new Error('Unexpected native binary payload')
      break
    }
    default:
      if (bytes.byteLength) throw new Error('Unexpected native binary payload')
  }
  return { value: result, bytes }
}
