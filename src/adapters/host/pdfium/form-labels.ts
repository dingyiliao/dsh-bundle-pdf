import type { FormPageInspection } from '../../../modules/forms/index.js'

// Tiny fixed glyphs keep the native raster overlay platform/font independent.
const glyphs: Record<string, string[]> = {
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
}

/** Paint small, background-free IDs inside controls on a detached base-page raster. */
export function paintFormLabels(rgba: Uint8Array, width: number, height: number,
  inspection: FormPageInspection): Uint8Array {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || rgba.length !== width * height * 4 || inspection.width !== width || inspection.height !== height
    || !inspection.pageRect.every((value, index) => value === [0, 0, width, height][index])
    || width > 2048 || height > 2048) throw new RangeError('Invalid form raster')
  const output = rgba.slice()
  const markers = inspection.fields.flatMap(field => field.controls)
  const blue = [24, 83, 201]
  for (const marker of markers) {
    const [left, top, right, bottom] = marker.labelRect
    const [l, t, r, b] = marker.rectImage
    if (![...marker.labelRect, ...marker.rectImage].every(Number.isFinite)
      || left < Math.max(0, l) || top < Math.max(0, t) || right > Math.min(width, r) || bottom > Math.min(height, b)
      || right <= left || bottom <= top || !/^F\d{2,3}$/.test(marker.label)) throw new RangeError('Invalid form label')
    const scale = (right - left) / (marker.label.length * 6 - 1)
    const x0 = Math.floor(left), y0 = Math.floor(top), span = Math.ceil(right) - x0
    const coverage = new Float32Array(span * (Math.ceil(bottom) - y0))
    for (const [position, character] of [...marker.label].entries()) {
      glyphs[character].forEach((row, y) => {
        for (let x = 0; x < row.length; x++) {
          if (row[x] !== '1') continue
          const gx = left + (position * 6 + x) * scale, gy = top + y * scale
          for (let py = Math.floor(gy); py < Math.ceil(gy + scale); py++) {
            for (let px = Math.floor(gx); px < Math.ceil(gx + scale); px++) {
              coverage[(py - y0) * span + px - x0] += Math.max(0, Math.min(px + 1, gx + scale) - Math.max(px, gx))
                * Math.max(0, Math.min(py + 1, gy + scale) - Math.max(py, gy))
            }
          }
        }
      })
    }
    for (let index = 0; index < coverage.length; index++) {
      const offset = ((y0 + Math.floor(index / span)) * width + x0 + index % span) * 4
      const opacity = .8 * Math.min(1, coverage[index])
      // Multiply preserves printed ink even if a document prints text inside a widget.
      for (let channel = 0; channel < 3; channel++) {
        output[offset + channel] = Math.round(output[offset + channel] * (1 - opacity + opacity * blue[channel] / 255))
      }
    }
  }
  return output
}
