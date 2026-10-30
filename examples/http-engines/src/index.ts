import type { Context } from '@deepseek-ai/cordis'
import type { HostOcrService } from '@dylanl1/dsh-plugin-pdf/ocr-host'
import type { HostImageUnderstandingService } from '@dylanl1/dsh-plugin-pdf/image-host'
import { createHttpOcrBackend, createHttpVisionBackend } from './backends.js'

export const name = 'example-pdf-http-engines'
export const inject = ['ocr', 'imageUnderstanding']

/** Register in the existing Host services; unload disposes both registrations. */
export function apply(ctx: Context & { ocr: HostOcrService; imageUnderstanding: HostImageUnderstandingService }): void {
  ctx.effect(() => ctx.ocr.register(createHttpOcrBackend()))
  ctx.effect(() => ctx.imageUnderstanding.register(createHttpVisionBackend()))
}
