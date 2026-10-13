import { deflate } from 'node:zlib'
import { promisify } from 'node:util'
const compress = promisify(deflate)
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1
  return value >>> 0
})
function chunk(type: string, data: Uint8Array): Buffer {
  const output = Buffer.alloc(12 + data.length)
  output.writeUInt32BE(data.length); output.write(type, 4, 4, 'ascii'); output.set(data, 8)
  let crc = 0xffffffff
  for (let index = 4; index < output.length - 4; index++) crc = crcTable[(crc ^ output[index]) & 255] ^ crc >>> 8
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4)
  return output
}
export async function encodePng(rgba: Uint8Array, width: number, height: number): Promise<Buffer> {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 1026 || height > 1026
    || rgba.length !== width * height * 4) throw new RangeError('Invalid native raster')
  const scanlines = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) scanlines.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1)
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', await compress(scanlines, { level: 1 })), chunk('IEND', new Uint8Array())])
}
