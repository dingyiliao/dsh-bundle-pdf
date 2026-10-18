import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { NativeProcessRuntime } from '../src/engine/native-worker.ts'

/** Test-only local adapter; production receives the Host's ctx.subprocess. */
export class NativeTestSubprocess implements NativeProcessRuntime {
  private latest?: ChildProcessWithoutNullStreams

  async resolveExecutable(command: string): Promise<string> {
    if (!isAbsolute(command)) throw new Error('Test helper path must be absolute')
    await access(command, constants.X_OK)
    return command
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    if (spec.stdio.stdin !== 'pipe' || spec.stdio.stdout !== 'pipe' || spec.stdio.stderr !== 'pipe') {
      throw new Error('Native test subprocess requires raw pipes')
    }
    const child = spawn(spec.argv[0]!, spec.argv.slice(1), {
      cwd: spec.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
    // Coverage profiles flush on normal process exit. Keep the production
    // termination path and intentional crash tests unchanged; only the
    // instrumented helper in the dedicated coverage run receives stdin EOF.
    const coverageExit = process.env.DSH_PDF_NATIVE_COVERAGE === '1'
      && spec.argv[0] === process.env.DSH_PDF_NATIVE_HELPER
    this.latest = child
    const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (exitCode, signal) => { resolve({ exitCode, signal }) })
    })
    return {
      stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, control: undefined, collected: {}, done,
      terminate: () => {
        if (!coverageExit) { child.kill('SIGKILL'); return }
        child.stdin.end()
        const fallback = setTimeout(() => { child.kill('SIGKILL') }, 5000)
        fallback.unref()
        child.once('close', () => { clearTimeout(fallback) })
      },
      waitForExit: async () => { await done.catch(() => undefined); return true },
    }
  }

  crashLatest(): void {
    if (!this.latest?.pid) throw new Error('No running native test helper')
    this.latest.kill('SIGKILL')
  }
}

export const nativeTestSubprocess = new NativeTestSubprocess()
