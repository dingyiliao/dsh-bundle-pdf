import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const root = fileURLToPath(new URL('../', import.meta.url))
const vitest = join(root, 'node_modules/vitest/vitest.mjs')
const config = join(root, 'vitest.web.config.ts')
const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: npm run test:web -- [file filters] [-t pattern] [--list]\nEach complete test runs in a fresh Vitest process. --list prints the collected JSON inventory.\nVitest test/hook timeouts are unchanged; an external 10-minute limit stops a frozen process.')
  process.exit(0)
}
const listOnly = args.includes('--list') || args[0] === 'list'
const filters = []
for (let index = 0; index < args.length; index++) {
  const arg = args[index]
  if (arg === '--list' || index === 0 && arg === 'list') continue
  if (arg === '-t' || arg === '--testNamePattern') {
    const pattern = args[++index]
    if (!pattern || pattern.startsWith('--')) throw new Error(`${arg} requires a test name pattern`)
    filters.push('--testNamePattern', pattern)
  } else if (arg.startsWith('--testNamePattern=')) filters.push(arg)
  else if (arg.startsWith('-')) throw new Error(`Unsupported option ${arg}; use file filters, -t/--testNamePattern, --list or --help`)
  else filters.push(arg)
}
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const outputRoot = join(root, '.test-output')
await mkdir(outputRoot, { recursive: true })
const output = await mkdtemp(join(outputRoot, 'web-tests-'))
console.log(`Isolated Web artifacts: ${output}`)

// Only the process tree launched for this test is eligible for termination.
// This timer runs outside Vitest, so a synchronous loader loop cannot starve it.
async function stopTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    await promisify(execFile)('taskkill', ['/PID', String(child.pid), '/T', '/F'])
    return
  }
  const { stdout } = await promisify(execFile)('ps', ['-A', '-o', 'pid=,ppid='])
  if (child.exitCode !== null || child.signalCode !== null) return
  const rows = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number))
  const owned = new Set([child.pid])
  for (let prior = -1; prior !== owned.size;) {
    prior = owned.size
    for (const [pid, parent] of rows) if (owned.has(parent)) owned.add(pid)
  }
  for (const pid of [...owned].reverse()) {
    try { process.kill(pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
}

async function run(label, argv, logfile) {
  const log = createWriteStream(logfile)
  const child = spawn(process.execPath, [vitest, ...argv], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let tail = '', stopped
  const record = chunk => { log.write(chunk); tail = (tail + chunk).slice(-32_768) }
  child.stdout.on('data', record)
  child.stderr.on('data', record)
  const stop = () => {
    stopped ??= stopTree(child).catch(error => {
      console.error(`Could not terminate the whole test tree: ${error.message}`)
      try { child.kill('SIGKILL') } catch (failure) { console.error(`Could not stop the test process: ${failure.message}`) }
    })
    return stopped
  }
  const timer = setTimeout(() => { console.error(`${label}: process exceeded its 10-minute safety limit`); void stop() }, 600_000)
  const interrupt = () => { void stop() }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  try {
    const code = await new Promise((done, fail) => { child.once('error', fail); child.once('close', done) })
    await stopped
    if (code !== 0 || stopped) throw new Error(`${label} failed (exit ${code}); ${logfile}\n${tail}`)
  } finally {
    clearTimeout(timer)
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
    await new Promise(done => log.end(done))
  }
}

const manifestPath = join(output, 'manifest.json')
await run('Web discovery', ['list', '--config', config, '--allowOnly=false', '--includeTaskLocation', `--json=${manifestPath}`, ...filters], join(output, 'discovery.log'))
const inventory = JSON.parse(await readFile(manifestPath, 'utf8'))
if (!Array.isArray(inventory) || !inventory.length) throw new Error('Web discovery selected no tests')
const identities = new Set()
for (const test of inventory) {
  if (typeof test.file !== 'string' || typeof test.name !== 'string' || !test.name) throw new Error('Malformed Web test inventory')
  const identity = JSON.stringify([test.file, test.name])
  if (identities.has(identity)) throw new Error(`Duplicate Web test identity: ${identity}`)
  identities.add(identity)
}
if (listOnly) {
  console.log(JSON.stringify(inventory, null, 2))
} else {
  const completed = []
  for (const [index, test] of inventory.entries()) {
    const prefix = join(output, String(index + 1).padStart(3, '0'))
    const reportPath = `${prefix}.json`
    console.log(`[web ${index + 1}/${inventory.length}] ${relative(root, test.file)} > ${test.name}`)
    // Reported suite names use " > "; the runner matches ancestor names with
    // spaces. Retain the literal variant for a title containing those symbols.
    const patterns = [...new Set([test.name, test.name.replaceAll(' > ', ' ')])].map(escapeRegex)
    await run(test.name, ['run', '--config', config, '--allowOnly=false', test.file,
      '--testNamePattern', `^(?:${patterns.join('|')})$`, '--reporter=json', `--outputFile=${reportPath}`], `${prefix}.log`)
    const report = JSON.parse(await readFile(reportPath, 'utf8'))
    const executed = (report.testResults ?? []).flatMap(file => (file.assertionResults ?? [])
      .filter(result => !['pending', 'skipped', 'todo'].includes(result.status)).map(result => ({ file: file.name, ...result })))
    const actual = executed[0]
    const actualName = actual ? [...actual.ancestorTitles, actual.title].join(' > ') : undefined
    if (!report.success || report.numPassedTests !== 1 || report.numFailedTests !== 0 || executed.length !== 1
      || actual.status !== 'passed' || resolve(actual.file) !== resolve(test.file) || actualName !== test.name) {
      throw new Error(`Expected exactly one passing execution of ${test.name}; inspect ${reportPath}`)
    }
    completed.push({ file: test.file, name: test.name, status: actual.status, duration: actual.duration, reportPath })
    await writeFile(join(output, 'results.json'), JSON.stringify(completed, null, 2))
  }
  console.log(`Web tests: ${completed.length}/${inventory.length} passed in isolated processes`)
}
