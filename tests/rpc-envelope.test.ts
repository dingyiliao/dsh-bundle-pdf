import assert from 'node:assert/strict'
import test from 'node:test'
import { rpcResponseSchema } from '../src/contracts/rpc/envelope.ts'
import { z } from 'zod'

test('typed RPC response schemas share one error envelope', () => {
  const response = rpcResponseSchema(z.object({ revision: z.number().int() }))
  assert.deepEqual(response.parse({ ok: true, value: { revision: 3 } }), { ok: true, value: { revision: 3 } })
  assert.deepEqual(response.parse({ ok: false, error: { code: 'pdf/failure', message: 'failed' } }), {
    ok: false, error: { code: 'pdf/failure', message: 'failed' },
  })
  assert.throws(() => response.parse({ ok: false, error: { message: 'missing code' } }))
})

test('typed RPC response schemas can preserve a legacy route error shape explicitly', () => {
  const response = rpcResponseSchema(
    z.object({ revision: z.number().int() }),
    z.object({ message: z.string() }),
  )
  assert.deepEqual(response.parse({ ok: false, error: { message: 'Catalog is disconnected' } }), {
    ok: false, error: { message: 'Catalog is disconnected' },
  })
  assert.equal(response.safeParse({ ok: false, error: { message: 12 } }).success, false)
})
