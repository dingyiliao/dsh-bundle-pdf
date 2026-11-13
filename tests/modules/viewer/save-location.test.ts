import assert from 'node:assert/strict'
import test from 'node:test'
import { createSaveLocation, resolveSaveLocation } from '../../../src/client/viewer/model/save-location.ts'

test('copy suggestions preserve source directories and the existing annotated-PDF naming convention', () => {
  for (const [source, directory, name] of [
    ['/reading/book.pdf', '/reading/', 'book-annotated.pdf'],
    ['/book.PDF', '/', 'book-annotated.pdf'],
    ['C:\\Reading\\book.pdf', 'C:\\Reading\\', 'book-annotated.pdf'],
    ['C:/Reading\\Mixed/book.pdf', 'C:/Reading\\Mixed/', 'book-annotated.pdf'],
    ['\\\\server\\share\\book.pdf', '\\\\server\\share\\', 'book-annotated.pdf'],
    ['//server/share/book.pdf', '//server/share/', 'book-annotated.pdf'],
    ['/reading/chapter', '/reading/', 'chapter-annotated.pdf'],
    ['relative.pdf', '', 'relative-annotated.pdf'],
  ]) assert.deepEqual(createSaveLocation(source!), { directory, name })
})

test('absolute POSIX, drive and UNC directories resolve without guessing a working directory', () => {
  for (const [directory, name, path] of [
    ['/', 'copy', '/copy.pdf'],
    ['/reading///', 'copy.pdf', '/reading/copy.pdf'],
    ['/资料/章节', '阅读副本.PDF', '/资料/章节/阅读副本.PDF'],
    ['C:\\', 'copy', 'C:\\copy.pdf'],
    ['C:/Reading/', 'copy', 'C:/Reading/copy.pdf'],
    ['C:/Reading\\Mixed/', 'copy.pdf', 'C:/Reading\\Mixed\\copy.pdf'],
    ['\\\\server\\share', 'copy', '\\\\server\\share\\copy.pdf'],
    ['//server/share/', 'copy', '//server/share/copy.pdf'],
    ['\\\\server/share\\Folder', 'copy', '\\\\server/share\\Folder\\copy.pdf'],
  ]) assert.deepEqual(resolveSaveLocation(directory!, name!), { path })
})

test('legal POSIX names and directory spaces remain unchanged instead of being sanitized', () => {
  for (const [directory, name, path] of [
    ['/ reading /saved ', ' copy.pdf', '/ reading /saved / copy.pdf'],
    ['/reading', 'why: now?.pdf', '/reading/why: now?.pdf'],
    ['/reading', 'CON.pdf', '/reading/CON.pdf'],
    ['/reading\\', 'copy.pdf', '/reading\\/copy.pdf'],
    ['/reading', 'copy ', '/reading/copy .pdf'],
    ['/reading', 'copy.', '/reading/copy..pdf'],
    ['/reading', '.hidden', '/reading/.hidden.pdf'],
  ]) assert.deepEqual(resolveSaveLocation(directory!, name!), { path })
})

test('relative, malformed UNC and unsafe directory inputs cannot be turned into a target path', () => {
  for (const directory of ['', ' ', '.', '..', 'Downloads', './Downloads', 'C:Downloads', '\\Downloads',
    '//server', '//server/', '\\\\server\\', '//./share', '//server/..', '//server/share ',
    'C:/Bad?Folder', 'C:/Bad:Folder', '/reading\u0000', '/reading\n']) {
    assert.deepEqual(resolveSaveLocation(directory, 'copy.pdf'), { error: 'directory' }, JSON.stringify(directory))
  }
  assert.deepEqual(resolveSaveLocation('relative', ''), { error: 'directory' }, 'an absent absolute location takes precedence')
})

test('filenames stay one nonempty segment and reject explicit non-PDF formats on every platform', () => {
  for (const directory of ['/reading', 'C:\\Reading']) {
    for (const name of ['', ' ', '.', '..', '../copy.pdf', 'sub/copy.pdf', 'sub\\copy.pdf',
      'copy\u0000.pdf', 'copy\n.pdf', 'copy\u007f.pdf', 'copy.txt', 'copy.pdf.zip']) {
      assert.deepEqual(resolveSaveLocation(directory, name), { error: 'name' }, `${directory}: ${JSON.stringify(name)}`)
    }
  }
})

test('Windows rejects device names, forbidden symbols and ambiguous trailing spaces or dots', () => {
  for (const directory of ['C:\\Reading', 'D:/', '\\\\server\\share', '//server/share']) {
    for (const name of ['CON', 'con.PDF', 'PRN.pdf', 'aux', 'NUL.pdf', 'COM1.pdf', 'LPT9.pdf', 'COM¹.pdf', 'LPT².pdf',
      'CONIN$.pdf', 'conout$', 'bad:name.pdf', 'bad<name.pdf', 'bad>name.pdf', 'bad"name.pdf', 'bad|name.pdf',
      'bad?name.pdf', 'bad*name.pdf', 'copy.pdf ', 'copy.pdf.']) {
      assert.deepEqual(resolveSaveLocation(directory, name), { error: 'name' }, `${directory}: ${name}`)
    }
    assert.deepEqual(resolveSaveLocation(directory, 'COM10.pdf'), { path: `${directory.replace(/[/\\]+$/, '')}${directory.includes('\\') ? '\\' : '/'}COM10.pdf` })
    assert.ok('path' in resolveSaveLocation(directory, 'CON-current.pdf'))
  }
})
