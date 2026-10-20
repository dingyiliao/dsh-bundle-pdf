import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

const root = new URL('../../', import.meta.url)

async function declarations(directory: string): Promise<string[]> {
  const entries = await readdir(new URL(directory, root), { withFileTypes: true })
  const result: string[] = []
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) result.push(...await declarations(path))
    else if (entry.name.endsWith('.d.ts')) result.push(path)
  }
  return result
}

test('published declaration graph contains no stale TypeScript import extensions', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as {
    exports: Record<string, string | { types?: string }>
  }
  for (const target of Object.values(manifest.exports)) {
    if (typeof target === 'object' && target.types) {
      const entry = new URL(target.types, root)
      assert.match(await readFile(entry, 'utf8'), /export|declare/)
    }
  }
  const paths = await declarations('dist/types')
  assert.ok(paths.length > 0, 'declaration build must produce public SDK types')
  for (const path of paths) {
    const source = await readFile(new URL(path, root), 'utf8')
    assert.doesNotMatch(source, /\b(?:from|import)\s*\(?\s*['"][^'"]+\.tsx?['"]/, `${join(path)} has a source-only import`)
  }
  assert.equal(paths.some(path => path.startsWith('dist/types/client/native/')), false,
    'removed Client native shims must not survive in the package')
})
