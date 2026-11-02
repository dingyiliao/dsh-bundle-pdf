import { isAbsoluteWorkspacePath, pathPartsOf, resolveWorkspacePath } from '../../../shared/address.js'

export interface SaveLocation { directory: string; name: string }
export type SaveLocationResult = { path: string } | { error: 'name' | 'directory' }

const controls = /[\u0000-\u001f\u007f]/u
const windowsPath = (path: string) => /^[a-z]:[/\\]/i.test(path) || /^[/\\]{2}[^/\\]/.test(path)
const reservedWindowsName = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu

/** Suggest a PDF copy beside the source, without inferring the Host's cwd. */
export function createSaveLocation(sourcePath: string): SaveLocation {
  const { directory, name } = pathPartsOf(sourcePath)
  return { directory, name: /\.pdf$/i.test(name) ? name.replace(/\.pdf$/i, '-annotated.pdf') : `${name}-annotated.pdf` }
}

/** Resolve the user's directory and single filename. Host permissions, target
 * existence and canonical paths remain the responsibility of the save API. */
export function resolveSaveLocation(directory: string, name: string): SaveLocationResult {
  if (!directory || controls.test(directory) || !isAbsoluteWorkspacePath(directory)) return { error: 'directory' }
  const windows = windowsPath(directory)
  if (windows) {
    const normalized = directory.replace(/\\/g, '/')
    const body = /^[a-z]:\//i.test(normalized) ? normalized.slice(3) : normalized.slice(2)
    if (/[<>:"|?*]/.test(body)) return { error: 'directory' }
    if (normalized.startsWith('//')) {
      const [server, share] = body.split('/')
      if (!server || !share || [server, share].some(part => part === '.' || part === '..' || /[ .]$/.test(part))) return { error: 'directory' }
    }
  }
  if (!name.trim() || name === '.' || name === '..' || /[/\\]/.test(name) || controls.test(name)) return { error: 'name' }
  if (windows && (/[<>:"|?*]/.test(name) || /[ .]$/.test(name) || reservedWindowsName.test(name))) return { error: 'name' }
  // Keep explicit extensions meaningful: a mistyped format must not silently
  // become a different file. A name without an extension gains the PDF suffix.
  const dot = name.lastIndexOf('.')
  if (!/\.pdf$/i.test(name) && dot > 0 && dot < name.length - 1) return { error: 'name' }
  const filename = /\.pdf$/i.test(name) ? name : `${name}.pdf`
  return { path: windows ? resolveWorkspacePath(directory, filename) : `${directory.replace(/\/+$/, '')}/${filename}` }
}
