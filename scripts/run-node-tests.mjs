import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { nodeTestFiles } from './node-test-files.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const coverage = process.argv.slice(2).includes('--coverage')
const tests = await nodeTestFiles(root)
if (tests.length === 0) throw new Error('No Node tests found below tests/.')

const args = coverage
  ? ['--enable-source-maps', '--experimental-test-coverage', '--test-coverage-include-all',
      '--test-coverage-include=src/**/*.ts', '--test-coverage-include=src/**/*.tsx']
  : []
args.push('--import', 'tsx', '--test', '--test-concurrency=1', ...tests)

const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true })
child.once('error', error => { throw error })
child.once('close', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0)
})
