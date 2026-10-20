import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { createPdfService } from '../pdfium/index.js'
import type { WorkingCopyReadPort } from '../../../modules/working-copy/index.js'
import type { PdfDispatch } from './transport.js'

const identity = z.string().min(1).max(512)
const pdfRect = z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()])
const request = z.discriminatedUnion('action', [
  z.object({ action: z.literal('availability'), sessionId: identity }).strict(),
  z.object({ action: z.literal('recognize'), sessionId: identity, documentId: identity,
    page: z.number().int().min(1).max(100_000), region: pdfRect.optional(),
    maxEdge: z.number().int().min(256).max(1024).optional() }).strict(),
])

function unavailable(reason: string): never {
  throw Object.assign(new Error(reason), { code: 'pdf/ocr-unavailable' })
}

/** Session-authorized PDF OCR: Host alone chooses the backend and model route. */
export function createPdfOcrDispatch(ctx: Pick<Context, 'get'>,
  workspaces: WorkingCopyReadPort,
  pdf: Pick<ReturnType<typeof createPdfService>, 'renderOcrImage'>,
  timeoutMs: () => number): PdfDispatch {
  return async (sessionId, input, agent, signal) => {
    const args = request.parse(input)
    if (args.sessionId !== sessionId || agent.session.id !== sessionId) {
      throw Object.assign(new Error('Session identity mismatch'), { code: 'pdf/session-mismatch' })
    }
    signal.throwIfAborted()
    const ocr = ctx.get('ocr')
    if (!ocr) {
      if (args.action === 'availability') return { status: 'unavailable', reason: 'The OCR plugin is not installed.' }
      return unavailable('The OCR plugin is not installed.')
    }
    const availability = await ocr.availability(sessionId, signal)
    signal.throwIfAborted()
    if (args.action === 'availability') {
      const descriptor = ocr.selectedDescriptor()
      return { ...availability, ...(descriptor ? { descriptor } : {}) }
    }
    if (availability.status !== 'available') return unavailable(availability.reason ?? `OCR is ${availability.status}.`)

    const rendered = await pdf.renderOcrImage(sessionId, args.documentId, args.page,
      args.region, args.maxEdge ?? 1024, signal)
    signal.throwIfAborted()
    const supported = ocr.selectedDescriptor()?.languages
    const result = await ocr.recognize({ sessionId, image: rendered.png, mediaType: 'image/png',
      width: rendered.width, height: rendered.height,
      languages: supported?.length ? [...supported.slice(0, 4)] : ['auto'],
      timeoutMs: timeoutMs(), signal })
    signal.throwIfAborted()
    const latest = workspaces.readSnapshot(sessionId, args.documentId)
    if (latest.contentVersion !== rendered.snapshot.contentVersion || latest.revision !== rendered.snapshot.revision) {
      throw Object.assign(new Error('PDF changed during OCR; retry'), { code: 'pdf/stale-reader' })
    }
    const parts = [...result.blocks, ...result.lines, ...result.words]
    const positionedParts = parts.filter(part => part.box !== null).length
    const geometry = positionedParts === 0 ? 'none' : positionedParts === parts.length ? 'complete' : 'partial'
    const response = {
      documentId: rendered.snapshot.id, page: args.page,
      revision: rendered.snapshot.revision, contentVersion: rendered.snapshot.contentVersion,
      text: result.text, status: result.status, source: result.source,
      image: { width: rendered.width, height: rendered.height, pdfRegion: rendered.pdfRegion },
      geometry: { status: geometry, coordinateSpace: 'rendered-image-pixels',
        positionedParts, totalParts: parts.length, pdfCoordinatesAvailable: false },
      blocks: result.blocks, lines: result.lines, words: result.words,
      coverage: result.coverage, warnings: result.warnings,
    }
    if (Buffer.byteLength(JSON.stringify(response)) > 1_048_576) {
      throw Object.assign(new Error('OCR response exceeds its size limit'), { code: 'pdf/ocr-result-too-large' })
    }
    return response
  }
}
