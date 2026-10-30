import { execFileSync } from 'node:child_process'
import { appendFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const main = 'refs/heads/main'
const commitId = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const version = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const skip = reason => ({ publish: false, reason })
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const manifest = (root, revision) => {
  const metadata = JSON.parse(git(root, 'show', `${revision}:package.json`))
  if (typeof metadata.name !== 'string' || !metadata.name || typeof metadata.version !== 'string' || !version.test(metadata.version)) {
    throw new Error('The release requires a named package with an exact semantic version.')
  }
  return metadata
}

/** A push compares its entire before/after range, never just HEAD's parent. */
export function planNpmRelease({ eventName, ref, sha, event }, root = process.cwd()) {
  if (ref !== main || !['push', 'workflow_dispatch'].includes(eventName)) return skip('Only trusted main events can publish.')
  if (eventName === 'workflow_dispatch' && ![true, 'true'].includes(event.inputs?.publish)) return skip('Manual publishing was not requested.')
  if (!commitId.test(sha ?? '') || git(root, 'rev-parse', 'HEAD') !== sha) throw new Error('Release checkout does not match the workflow commit.')
  if (eventName === 'push' && (event.ref !== main || event.after !== sha || !commitId.test(event.before ?? ''))) {
    throw new Error('Push release boundaries do not match the workflow context.')
  }
  const current = manifest(root, sha)
  if (current.private === true) throw new Error('A private package cannot be published.')
  if (!stableVersion.test(current.version)) return skip('This workflow publishes stable versions only; prereleases require an explicit dist-tag policy.')
  if (eventName === 'workflow_dispatch') return { publish: true, version: current.version, reason: 'Explicit main release or retry.' }
  if (/^0+$/.test(event.before)) return skip('No previous main baseline exists. Use a manual main release for the first publication.')
  try { git(root, 'cat-file', '-e', `${event.before}^{commit}`) } catch {
    // Force-push baselines may no longer be reachable from a full branch fetch.
    try { git(root, 'fetch', '--no-tags', '--depth=1', 'origin', event.before) }
    catch { throw new Error('Cannot obtain the previous main commit. Use a manual main release after verification.') }
  }
  const previous = manifest(root, event.before)
  if (previous.name !== current.name) throw new Error('Renaming a published package requires an explicit manual release.')
  if (previous.version === current.version) return skip('The package version did not change.')
  const before = version.exec(previous.version), after = stableVersion.exec(current.version)
  let comparison = 0
  for (let index = 1; index <= 3 && !comparison; index++) {
    comparison = BigInt(after[index]) > BigInt(before[index]) ? 1 : BigInt(after[index]) < BigInt(before[index]) ? -1 : 0
  }
  if (comparison < 0 || comparison === 0 && !before[4]) throw new Error('Automatic publication requires a version increase.')
  return { publish: true, version: current.version, reason: `Version increased from ${previous.version} to ${current.version}.` }
}

/** Called while holding the publishing lock, immediately before registry writes. */
export function confirmCurrentMainRelease(plan, root = process.cwd()) {
  if (!plan.publish) return plan
  const current = manifest(root, 'HEAD')
  git(root, 'fetch', '--no-tags', '--depth=1', 'origin', main)
  const latest = manifest(root, git(root, 'rev-parse', 'FETCH_HEAD'))
  return current.name === latest.name && plan.version === current.version && current.version === latest.version
    ? plan : skip('A different main package version superseded this run; no packages will be published.')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let result = planNpmRelease({ eventName: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF,
      sha: process.env.GITHUB_SHA, event: JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')) })
    if (process.argv.includes('--current-main')) result = confirmCurrentMainRelease(result)
    if (!process.env.GITHUB_OUTPUT) throw new Error('The GitHub Actions output file is required.')
    await appendFile(process.env.GITHUB_OUTPUT, `publish=${result.publish}\nversion=${result.version ?? ''}\n`)
    console.log(result.reason)
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
