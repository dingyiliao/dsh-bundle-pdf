import type { Buffer } from 'node:buffer'
import { z } from 'zod'
import { decodeNativeReply, type NativeReply, type NativeRequest } from './commands.js'

/**
 * The JSON part of the native IPC contract. The command payload stays flat so
 * existing PDFium workers remain wire-compatible; this module owns only the
 * correlation and reply envelope.
 */
export type NativeRequestEnvelope<T extends NativeRequest = NativeRequest> = T & { requestId: string }

const nativeReplyEnvelope = z.discriminatedUnion('ok', [
  z.object({ requestId: z.string().min(1), ok: z.literal(true), value: z.unknown() }),
  z.object({ requestId: z.string().min(1), ok: z.literal(false), error: z.object({
    code: z.string().optional(), message: z.string().optional(),
  }).optional() }),
])

export type NativeReplyEnvelope = z.infer<typeof nativeReplyEnvelope>

export function createNativeRequestEnvelope<T extends NativeRequest>(request: T, requestId: string): NativeRequestEnvelope<T> {
  if (!requestId) throw new Error('Native request id is required')
  return { ...request, requestId }
}

export function decodeNativeReplyEnvelope<T extends NativeRequest>(request: T, requestId: string,
  metadata: unknown, bytes: Buffer): NativeReply<T['command']> | { error?: { code?: string; message?: string } } {
  const envelope = nativeReplyEnvelope.parse(metadata)
  if (envelope.requestId !== requestId) throw new Error('Native reply correlation failed')
  if (!envelope.ok) {
    if (bytes.byteLength) throw new Error('Unexpected native error payload')
    return { error: envelope.error }
  }
  return decodeNativeReply(request, envelope.value, bytes)
}

