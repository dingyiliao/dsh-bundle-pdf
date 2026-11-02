import assert from 'node:assert/strict'
import { join, relative, resolve, sep } from 'node:path'
import test from 'node:test'
import { resolveIndexingLogDirectory, resolveRetrievalStoreDirectory } from '../../../../src/adapters/host/dsh/indexing-log-location.ts'

test('index log location follows the immutable launcher home and profile', () => {
  const home = resolve('isolated-home')
  assert.equal(resolveIndexingLogDirectory({ home, name: 'desktop' }, '/ignored', '/ignored'),
    join(home, 'logs', 'dsh-plugin-pdf', 'desktop'))
  assert.equal(resolveIndexingLogDirectory({ home, name: 'web-2.prod' }),
    join(home, 'logs', 'dsh-plugin-pdf', 'web-2.prod'))
})

test('unusual profile names remain bounded distinct directory segments', () => {
  const home = resolve('isolated-home'), root = join(home, 'logs', 'dsh-plugin-pdf')
  const names = ['..', '../desktop', '/tmp', 'a/b', 'a\\b', 'CON', 'con.txt', 'profile.', '桌面', 'x'.repeat(1000), '~x', 'Desktop']
  const locations = names.map(name => resolveIndexingLogDirectory({ home, name }))
  assert.equal(new Set(locations).size, names.length)
  for (const location of locations) {
    const child = relative(root, location)
    assert.match(child, /^~[a-f0-9]{64}$/)
    assert.equal(child.includes(sep), false)
  }
  assert.notEqual(resolveIndexingLogDirectory({ home, name: 'a_b' }), locations[names.indexOf('a/b')])
  assert.notEqual(resolveIndexingLogDirectory({ home, name: 'desktop' }).toLowerCase(), locations.at(-1)!.toLowerCase())
  assert.notEqual(resolveIndexingLogDirectory({ home, name: locations[0]!.split(sep).at(-1) }), locations[0])
})

test('standalone diagnostics use DSH_HOME with native home expansion and absolute resolution', () => {
  const userHome = resolve('user-home')
  for (const value of ['~', '~/custom', '~\\custom']) {
    const suffix = value === '~' ? '' : 'custom'
    assert.equal(resolveIndexingLogDirectory(undefined, value, userHome),
      join(userHome, suffix, 'logs', 'dsh-plugin-pdf', 'standalone'))
  }
  assert.equal(resolveIndexingLogDirectory(undefined, 'relative-home', userHome),
    join(resolve('relative-home'), 'logs', 'dsh-plugin-pdf', 'standalone'))
  assert.equal(resolveIndexingLogDirectory(undefined, '/configured-home', userHome),
    join(resolve('/configured-home'), 'logs', 'dsh-plugin-pdf', 'standalone'))
})

test('invalid launcher facts and absent environment fall back to an isolated default home', () => {
  const userHome = resolve('user-home')
  const expected = join(userHome, '.dsh', 'logs', 'dsh-plugin-pdf', 'standalone')
  for (const profile of [undefined, null, '', {}, { home: 'relative', name: 'desktop' },
    { home: '/data', name: '' }, { home: '/data', name: '  ' }, { home: '/data\0', name: 'desktop' },
    { home: 5, name: 'desktop' }, { home: '/data', name: 5 }]) {
    for (const env of ['', '  ', '\0bad']) assert.equal(resolveIndexingLogDirectory(profile, env, userHome), expected)
  }
  const previous = process.env.DSH_HOME
  try {
    delete process.env.DSH_HOME
    assert.match(resolveIndexingLogDirectory(undefined), /logs[/\\]dsh-plugin-pdf[/\\]standalone$/)
    process.env.DSH_HOME = userHome
    assert.equal(resolveIndexingLogDirectory(undefined), join(userHome, 'logs', 'dsh-plugin-pdf', 'standalone'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('durable retrieval paths share launcher resolution while isolating profiles and namespaces', () => {
  const home = resolve('isolated-home'), suffix = '0123456789abcdef'
  assert.equal(resolveRetrievalStoreDirectory({ home, name: 'desktop' }, suffix),
    join(home, 'storages', 'dsh-plugin-pdf', 'desktop', suffix, 'retrieval-v1'))
  assert.equal(resolveRetrievalStoreDirectory(undefined, suffix, '~/configured', home),
    join(home, 'configured', 'storages', 'dsh-plugin-pdf', 'standalone', suffix, 'retrieval-v1'))
  assert.notEqual(resolveRetrievalStoreDirectory({ home, name: 'desktop' }, suffix),
    resolveRetrievalStoreDirectory({ home, name: 'web' }, suffix))
  assert.notEqual(resolveRetrievalStoreDirectory({ home, name: 'desktop' }, suffix),
    resolveRetrievalStoreDirectory({ home, name: 'desktop' }, 'fedcba9876543210'))
  for (const invalid of ['', '../private', '0'.repeat(15), 'A'.repeat(16)]) {
    assert.throws(() => resolveRetrievalStoreDirectory({ home, name: 'desktop' }, invalid), /Invalid PDF storage namespace/)
  }
  const previous = process.env.DSH_HOME
  try {
    delete process.env.DSH_HOME
    assert.match(resolveRetrievalStoreDirectory(undefined, suffix), /storages[/\\]dsh-plugin-pdf[/\\]standalone[/\\]0123456789abcdef[/\\]retrieval-v1$/)
  } finally { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous }
})
