import type { PdfPageInfo } from '../../core/pdf-types.ts'

/** PDF user space to CSS pixels; crop, UserUnit, rotation and Y inversion occur once. */
export class NativeViewport {
  readonly viewBox: number[]
  readonly userUnit: number
  readonly width: number
  readonly height: number
  readonly transform: number[]
  readonly rawDims: { pageWidth: number; pageHeight: number; pageX: number; pageY: number }
  constructor(readonly geometry: PdfPageInfo, readonly scale: number, readonly rotation = geometry.rotation,
    readonly offsetX = 0, readonly offsetY = 0, readonly dontFlip = false) {
    if (!(scale > 0) || !Number.isFinite(scale)) throw new RangeError('Invalid viewport scale')
    const angle = (rotation % 360 + 360) % 360
    if (angle % 90) throw new RangeError('Rotation must be a multiple of 90 degrees')
    this.rotation = angle
    const [left, bottom, right, top] = geometry.cropBox
    this.viewBox = [...geometry.cropBox]; this.userUnit = geometry.userUnit
    this.rawDims = { pageWidth: right - left, pageHeight: top - bottom, pageX: left, pageY: bottom }
    const s = scale * this.userUnit
    const matrices: Record<number, number[]> = {
      0: [s, 0, 0, -s, -left * s, top * s],
      90: [0, s, s, 0, -bottom * s, -left * s],
      180: [-s, 0, 0, s, right * s, -bottom * s],
      270: [0, -s, -s, 0, top * s, right * s],
    }
    this.transform = matrices[angle]
    if (dontFlip) {
      // Reflect the PDF Y coefficient around the crop-box center, preserving offsets.
      const t = this.transform
      t[4] += t[2] * (bottom + top); t[5] += t[3] * (bottom + top)
      t[2] *= -1; t[3] *= -1
    }
    this.transform[4] += offsetX; this.transform[5] += offsetY
    this.width = (angle % 180 ? top - bottom : right - left) * s
    this.height = (angle % 180 ? right - left : top - bottom) * s
  }
  clone(options: { scale?: number; rotation?: number; offsetX?: number; offsetY?: number; dontFlip?: boolean } = {}): NativeViewport {
    return new NativeViewport(this.geometry, options.scale ?? this.scale, options.rotation ?? this.rotation,
      options.offsetX ?? this.offsetX, options.offsetY ?? this.offsetY, options.dontFlip ?? false)
  }
  convertToViewportPoint(x: number, y: number): [number, number] {
    const [a, b, c, d, e, f] = this.transform
    return [a * x + c * y + e, b * x + d * y + f]
  }
  convertToPdfPoint(x: number, y: number): [number, number] {
    const [a, b, c, d, e, f] = this.transform, det = a * d - b * c
    return [(d * (x - e) - c * (y - f)) / det, (-b * (x - e) + a * (y - f)) / det]
  }
  convertToViewportRectangle(rect: number[]): number[] {
    return [...this.convertToViewportPoint(rect[0], rect[1]), ...this.convertToViewportPoint(rect[2], rect[3])]
  }
}
