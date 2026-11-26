import { EMBEDDING_TEST_METHOD, embeddingTestResultSchema } from '../../../../contracts/embedding-test.js'
import { rpcResponseSchema } from '../../../../contracts/rpc/index.js'
import type { PdfConnection } from './pdf-api.js'

const response = rpcResponseSchema(embeddingTestResultSchema)

export function createEmbeddingTestApi(connection: PdfConnection, lifetime: AbortSignal) {
  return {
    async test(signal?: AbortSignal) {
      const active = signal ? AbortSignal.any([signal, lifetime]) : lifetime
      const result = response.parse(await connection.rpc.call('/api', EMBEDDING_TEST_METHOD, {}, active))
      if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
      return result.value
    },
  }
}
