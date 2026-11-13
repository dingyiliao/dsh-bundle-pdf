import { resolve } from 'node:path'
import { createNativeDocumentPort } from '../src/adapters/host/pdfium/document-port.ts'
import { NativeTestSubprocess } from '../tests/native-test-subprocess.ts'

export function benchmarkDocumentPort() {
  const executable = process.env.DSH_PDF_NATIVE_HELPER ?? resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
  return createNativeDocumentPort(executable, new NativeTestSubprocess())
}

export { plainPdf as benchmarkPdf } from '../tests/fixtures/plain-pdf.ts'
