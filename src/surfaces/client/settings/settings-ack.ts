import type { ConfigForm, ConfigFormSnapshot } from './Settings.js'

export const SETTINGS_ACK_TIMEOUT_MS = 10_000

/** ConfigForm can accept a superseded write before publishing its newer view. */
export function waitForSettingsAcknowledgement(form: ConfigForm, previousRevision: number): Promise<ConfigFormSnapshot> {
  return new Promise((resolve, reject) => {
    let completed = false, unsubscribe = () => {}
    const finish = (snapshot?: ConfigFormSnapshot, error?: unknown) => {
      if (completed) return
      completed = true; clearTimeout(timer); unsubscribe()
      if (error) reject(error)
      else resolve(snapshot!)
    }
    const inspect = () => {
      try {
        const snapshot = form.getSnapshot()
        if (snapshot.status === 'unavailable') throw new Error('The settings connection is unavailable. Reconnect and retry saving.')
        if (snapshot.status === 'ready' && snapshot.value !== undefined
          && snapshot.revision !== undefined && snapshot.revision > previousRevision) finish(snapshot)
      } catch (error) { finish(undefined, error) }
    }
    const timer = setTimeout(() => finish(undefined,
      new Error('The accepted settings have not synchronized. Reconnect and retry saving.')), SETTINGS_ACK_TIMEOUT_MS)
    inspect()
    if (completed) return
    try {
      unsubscribe = form.subscribe(inspect)
      // subscribe may publish synchronously; recheck also closes the gap
      // between the first snapshot read and installing the temporary watch.
      if (completed) unsubscribe()
      else inspect()
    } catch (error) { finish(undefined, error) }
  })
}
