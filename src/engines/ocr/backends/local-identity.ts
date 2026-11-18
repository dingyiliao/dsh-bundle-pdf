import { createHash } from 'node:crypto'
import { engineCacheIdentity } from '../../spi/index.js'
import type { OcrProducerIdentity } from '../../../layers/derived/content/index.js'

// Both Host entrances use the same pinned dispatcher, OEM 1, eng+chi_sim,
// empty initialize/recognize options, and normalizeTesseractOutput contract.
export const LOCAL_OCR_VERSION = 'tesseract.js/7.0.0;eng/1.0.0;chi_sim/1.0.0'
export const LOCAL_OCR_ATTESTATION = 'bundled-tesseract-7.0.0-eng-chi_sim-1.0.0-v1'
export const BUNDLED_LOCAL_OCR_PRODUCER: Readonly<OcrProducerIdentity> = Object.freeze({
  id: 'local-tesseract', version: LOCAL_OCR_VERSION, reusable: true,
  fingerprint: engineCacheIdentity({ id: 'local-tesseract', name: 'Local Tesseract OCR', version: LOCAL_OCR_VERSION,
    execution: 'local', capabilities: ['ocr-text'] }, {}, '', '', LOCAL_OCR_ATTESTATION,
  canonical => createHash('sha256').update(canonical).digest('hex')).fingerprint,
})
