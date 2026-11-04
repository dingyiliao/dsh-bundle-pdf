import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveSessionModel, SessionModelRouteError, type SessionModelRouteContext } from '../../../src/adapters/host/dsh/session-model-route.js'

const signal = () => new AbortController().signal

function context(options: {
  pending?: { provider: string; model: string; reasoningEffort?: string } | null
  header?: { config: { provider: string; model: string; reasoningEffort?: string }; adapterDefaults?: { reasoningEffort?: boolean } }
  fallback?: { provider: string; model: string; reasoningEffort?: string }
  projection?: boolean
} = {}): SessionModelRouteContext {
  const session = { requestHeader: () => options.header }
  return {
    sessionController: { async resolveAgent() { return { agent: { session } } } },
    get(key: 'sessionProjections' | 'agentDefaultModel'): any {
      if (key === 'sessionProjections') {
        return options.projection === false ? undefined : { stateOf: () => ({ pending: options.pending ?? null }) }
      }
      return options.fallback ? { currentSelection: () => options.fallback } : undefined
    },
  }
}

test('session model route copies the pending selection ahead of request-header and default models', async () => {
  const pending = { provider: 'pending', model: 'm1', reasoningEffort: 'high' }
  const route = await resolveSessionModel(context({ pending,
    header: { config: { provider: 'header', model: 'm2' } },
    fallback: { provider: 'default', model: 'm3' },
  }), 'session-a', signal())
  assert.deepEqual(route, pending)
  assert.notEqual(route, pending)
})

test('session model route uses request-header reasoning only when the adapter does not supply it', async () => {
  const header = { config: { provider: 'header', model: 'm1', reasoningEffort: 'high' } }
  assert.deepEqual(await resolveSessionModel(context({ header }), 'session-a', signal()),
    { provider: 'header', model: 'm1', reasoningEffort: 'high' })
  assert.deepEqual(await resolveSessionModel(context({
    header: { ...header, adapterDefaults: { reasoningEffort: true } },
  }), 'session-a', signal()), { provider: 'header', model: 'm1' })
  assert.deepEqual(await resolveSessionModel(context({
    header: { config: { provider: 'header', model: 'm1' } },
  }), 'session-a', signal()), { provider: 'header', model: 'm1' })
})

test('session model route falls back to the configured default when the session has no selection', async () => {
  const fallback = { provider: 'default', model: 'm1' }
  const route = await resolveSessionModel(context({ fallback, projection: false }), 'session-a', signal())
  assert.deepEqual(route, fallback)
  assert.notEqual(route, fallback)
})

test('session model route reports unavailable sessions and absent or broken defaults with neutral routing errors', async () => {
  await assert.rejects(resolveSessionModel({
    ...context(), sessionController: { async resolveAgent() { return { error: new Error('gone') } } },
  }, 'missing', signal()), (error: unknown) => error instanceof SessionModelRouteError && error.code === 'session-unavailable')
  await assert.rejects(resolveSessionModel(context(), 'session-a', signal()),
    (error: unknown) => error instanceof SessionModelRouteError && error.code === 'model-unavailable'
      && error.cause instanceof Error && error.cause.message === 'No default model is available.')
  const broken = context({ fallback: { provider: 'x', model: 'y' } })
  broken.get = ((key: string) => key === 'agentDefaultModel'
    ? { currentSelection() { throw new Error('selection failed') } } : undefined) as typeof broken.get
  await assert.rejects(resolveSessionModel(broken, 'session-a', signal()),
    (error: unknown) => error instanceof SessionModelRouteError && error.code === 'model-unavailable'
      && error.cause instanceof Error && error.cause.message === 'selection failed')
})

test('session model route propagates cancellation before and after resolving the session', async () => {
  const already = new AbortController()
  const reason = new Error('stop now')
  already.abort(reason)
  let calls = 0
  const ctx = context({ fallback: { provider: 'x', model: 'y' } })
  ctx.sessionController.resolveAgent = async () => { calls++; return { agent: { session: {} } } }
  await assert.rejects(resolveSessionModel(ctx, 's', already.signal), error => error === reason)
  assert.equal(calls, 0)

  const during = new AbortController()
  ctx.sessionController.resolveAgent = async () => {
    calls++
    during.abort(reason)
    return { agent: { session: {} } }
  }
  await assert.rejects(resolveSessionModel(ctx, 's', during.signal), error => error === reason)
  assert.equal(calls, 1)
})
