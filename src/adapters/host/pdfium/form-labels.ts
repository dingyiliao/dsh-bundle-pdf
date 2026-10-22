import type { FormControlMarker } from '../../../modules/forms/index.js'

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

/** Decorate only the detached native raster; never add annotations to the PDF. */
export function paintFormLabels(rgba: Uint8Array, width: number, height: number,
  markers: readonly FormControlMarker[]): void {
  if (rgba.length !== width * height * 4) throw new RangeError('Invalid form raster')
  const blue = [24, 83, 201], white = [255, 255, 255]
  function fill(left: number, top: number, right: number, bottom: number, color: number[]) {
    for (let y = Math.max(0, Math.floor(top)); y < Math.min(height, Math.ceil(bottom)); y++) {
      for (let x = Math.max(0, Math.floor(left)); x < Math.min(width, Math.ceil(right)); x++) {
        const offset = (y * width + x) * 4
        rgba[offset] = color[0]; rgba[offset + 1] = color[1]; rgba[offset + 2] = color[2]; rgba[offset + 3] = 255
      }
    }
  }
  for (const marker of markers) {
    const [left, top, right, bottom] = marker.rectImage
    fill(left, top, right, top + 2, blue); fill(left, bottom - 2, right, bottom, blue)
    fill(left, top, left + 2, bottom, blue); fill(right - 2, top, right, bottom, blue)
  }
  for (const marker of markers) {
    const [left, top, right, bottom] = marker.labelRect
    fill(left, top, right, bottom, blue)
    for (const [position, character] of [...marker.label].entries()) {
      glyphs[character]?.forEach((row, y) => {
        for (let x = 0; x < row.length; x++) {
          if (row[x] === '1') fill(left + 4 + position * 12 + x * 2, top + 3 + y * 2,
            left + 6 + position * 12 + x * 2, top + 5 + y * 2, white)
        }
      })
    }
  }
}
