export interface SaveOptions {
  path?: string
  overwrite?: boolean
  expectedTargetVersion?: string | null
}

function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }) }

/**
 * Preserve Save versus Save As compare-and-swap semantics. An explicit same-path
 * Save As can recreate a deleted file or replace only the observed version.
 */
export function expectedSaveVersion(sourceHash: string, samePath: boolean, options: SaveOptions): string | null {
  let expected = samePath ? sourceHash : options.expectedTargetVersion ?? null
  if (samePath && options.path !== undefined && options.expectedTargetVersion === null
    && options.overwrite !== true) {
    expected = null
  }
  if (samePath && options.path !== undefined && options.overwrite === true) {
    if (!options.expectedTargetVersion) {
      fail('pdf/overwrite-required', 'Observe the current PDF version before replacing it')
    }
    expected = options.expectedTargetVersion
  }
  if (!samePath && expected !== null && options.overwrite !== true) {
    fail('pdf/overwrite-required', 'Explicit replacement confirmation is required')
  }
  return expected
}
