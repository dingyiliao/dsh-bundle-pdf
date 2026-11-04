import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Context } from '@deepseek-ai/cordis'
import { type ToolExecutionInput, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { expect } from 'vitest'

export { assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole, webSnapshotMode } from '../../../../deepseek-harness/apps/web/tests/scaffold.ts'
export { expandOwningTurnProcess, newEnglishPage, openSettings, saveFailureShot } from '../../../../deepseek-harness/apps/web/tests/support.ts'

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

export const DSH_ROOT = join(ROOT, '..', 'deepseek-harness')

export const SESSION = join(DSH_ROOT, 'snapshots', 'web', 'seeded-history', 'session.v3.jsonl')

export const EXPECTED = join(ROOT, 'tests', 'expected', 'web-pdf')

/** The released SDK dispatches one call; newer source test hosts dispatch batches. */
export async function executeScaffoldTool(tools: Context['tools'], input: ToolExecutionInput): Promise<ToolExecutionResult> {
  if (!('setExecutor' in tools)) return tools.execute(input)
  const batchTools = tools as unknown as {
    execute(input: { signal: AbortSignal; agent?: ToolExecutionInput['agent'];
      calls: Array<{ type: 'tool-call'; id: ToolExecutionInput['callId']; name: string; arguments: string }> }):
      Promise<{ results: Array<{ callId: ToolExecutionInput['callId']; result: ToolExecutionResult }> }>
  }
  const batch = await batchTools.execute({ signal: input.signal, agent: input.agent,
    calls: [{ type: 'tool-call', id: input.callId, name: input.name, arguments: JSON.stringify(input.arguments) }] })
  expect(batch.results).toHaveLength(1)
  expect(batch.results[0]!.callId).toBe(input.callId)
  return batch.results[0]!.result
}

export const MODEL_FIXTURE = join(DSH_ROOT, 'apps/web/tests/fixtures/deepseek-model-label-1017/session.v4.jsonl')
