import { fileURLToPath } from 'node:url'
import { createNativeDocumentPort } from '../../src/adapters/host/pdfium/document-port.ts'
import type { PdfWorkingCopyOperation } from '../../src/core/pdf-types.ts'
import type { PdfDocumentPort } from '../../src/modules/working-copy/index.ts'
import { NativeTestSubprocess } from '../native-test-subprocess.ts'

export const fixtureDocumentExecutable = process.env.DSH_PDF_NATIVE_HELPER
  ?? fileURLToPath(new URL(`../../dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url))

export function createFixtureDocumentPort() {
  return createNativeDocumentPort(fixtureDocumentExecutable, new NativeTestSubprocess())
}

async function withDocument<T>(use: (port: PdfDocumentPort) => Promise<T>): Promise<T> {
  const port = createFixtureDocumentPort()
  try { return await use(port) }
  finally { await port.dispose() }
}

export function inspectFixturePdf(bytes: Uint8Array) {
  return withDocument(port => port.inspect(bytes))
}

export function materializeFixturePdf(bytes: Uint8Array, operations: readonly PdfWorkingCopyOperation[],
  dates: readonly string[] = operations.map(() => '2026-11-09T00:00:00Z')) {
  return withDocument(port => port.materialize(bytes, operations, dates))
}

export const fixturePdfDocument: PdfDocumentPort = { inspect: inspectFixturePdf, materialize: materializeFixturePdf }
