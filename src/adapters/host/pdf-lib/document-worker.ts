import { parentPort } from 'node:worker_threads'
import { PdfDocumentError } from '../../../core/pdf-types.js'
import { applyPdfOperations, loadPdfDocument } from './pdf-document.js'
import type { PdfDocumentWorkerReply, PdfDocumentWorkerRequest } from './document-worker-protocol.js'

const port = parentPort
if (!port) throw new Error('The PDF document worker requires a parent port.')

port.on('message', async (request: PdfDocumentWorkerRequest) => {
  try {
    if (request.action === 'inspect') {
      const document = await loadPdfDocument(request.bytes)
      port.postMessage({ ok: true, document } satisfies PdfDocumentWorkerReply)
    } else {
      const result = await applyPdfOperations(request.bytes, request.operations, request.operationDates)
      const transfer = result.bytes.buffer instanceof ArrayBuffer ? [result.bytes.buffer] : []
      port.postMessage({ ok: true, ...result } satisfies PdfDocumentWorkerReply, transfer)
    }
  } catch (error) {
    port.postMessage({ ok: false, error: {
      message: error instanceof Error ? error.message : 'The PDF document could not be processed.',
      ...(error instanceof PdfDocumentError ? { code: error.code } : {}),
    } } satisfies PdfDocumentWorkerReply)
  }
})
