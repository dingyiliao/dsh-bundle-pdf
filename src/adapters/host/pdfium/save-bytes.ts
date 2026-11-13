import { MAX_NATIVE_REPLY } from '../../../engine/host/framing.js'
import type { NativePdfPort } from '../../../engine/host/native-port.js'

export async function readNativeSavedBytes(worker: Pick<NativePdfPort, 'materializeCopy' | 'readMaterializedChunk'>, documentId: string,
  signal: AbortSignal): Promise<Uint8Array> {
  const { value: { size } } = await worker.materializeCopy({ documentId }, signal)
  const bytes = Buffer.allocUnsafe(size)
  for (let offset = 0; offset < size; offset += MAX_NATIVE_REPLY) {
    const length = Math.min(MAX_NATIVE_REPLY, size - offset)
    const chunk = await worker.readMaterializedChunk({ documentId, offset, length }, signal)
    if (chunk.value.size !== size) throw Object.assign(new Error('Native PDF save output is incomplete'), { code: 'pdf/native-protocol' })
    bytes.set(chunk.bytes, offset)
  }
  return bytes
}
