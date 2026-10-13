/** Version 1: two little-endian u32 lengths, UTF-8 JSON, then binary bytes. */
export interface NativeFrame { metadata: unknown; bytes: Buffer }
export const MAX_NATIVE_JSON = 2 * 1024 * 1024
export const MAX_NATIVE_REPLY = 8 * 1024 * 1024

export function encodeFrame(metadata: object, bytes: Uint8Array = new Uint8Array()): Buffer[] {
  const json = Buffer.from(JSON.stringify(metadata))
  if (!json.length || json.length > MAX_NATIVE_JSON || bytes.byteLength > 256 * 1024 * 1024) throw new RangeError('Native input exceeds frame limits')
  const prefix = Buffer.alloc(8)
  prefix.writeUInt32LE(json.length, 0); prefix.writeUInt32LE(bytes.byteLength, 4)
  return [prefix, json, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)]
}

/** Allocates once per frame, even when stdout delivers one byte at a time. */
export class FrameDecoder {
  private prefix = Buffer.alloc(8)
  private prefixOffset = 0
  private body: Buffer | undefined
  private offset = 0
  private jsonLength = 0
  constructor(private readonly onFrame: (frame: NativeFrame) => void) {}
  feed(chunk: Uint8Array): void {
    let cursor = 0
    while (cursor < chunk.length) {
      if (!this.body) {
        const count = Math.min(8 - this.prefixOffset, chunk.length - cursor)
        this.prefix.set(chunk.subarray(cursor, cursor + count), this.prefixOffset)
        this.prefixOffset += count; cursor += count
        if (this.prefixOffset < 8) continue
        this.jsonLength = this.prefix.readUInt32LE(0)
        const binaryLength = this.prefix.readUInt32LE(4)
        if (!this.jsonLength || this.jsonLength > MAX_NATIVE_JSON || binaryLength > MAX_NATIVE_REPLY) throw new RangeError('Invalid native reply length')
        this.body = Buffer.allocUnsafe(this.jsonLength + binaryLength)
        this.offset = 0
      }
      const count = Math.min(this.body.length - this.offset, chunk.length - cursor)
      this.body.set(chunk.subarray(cursor, cursor + count), this.offset)
      this.offset += count; cursor += count
      if (this.offset === this.body.length) {
        const body = this.body, length = this.jsonLength
        this.body = undefined; this.prefixOffset = 0; this.offset = 0
        this.onFrame({ metadata: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(0, length))), bytes: body.subarray(length) })
      }
    }
  }
  get incomplete(): boolean { return this.prefixOffset !== 0 || this.body !== undefined }
}
