const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Rebase local edits over a Host view, acknowledging only the submitted values. */
export function mergeSettingsValue(base: unknown, local: unknown, remote: unknown,
  acknowledged?: { value: unknown; accepted?: unknown }): { value: unknown; conflict: boolean } {
  const acceptedValue = acknowledged && Object.hasOwn(acknowledged, 'accepted') ? acknowledged.accepted : acknowledged?.value
  if (acknowledged && same(local, acknowledged.value)) return { value: remote, conflict: false }
  if (!acknowledged && same(local, base)) return { value: remote, conflict: false }
  if (same(local, remote) || same(remote, acknowledged ? acceptedValue : base)) return { value: local, conflict: false }
  if (record(local) && record(remote)) {
    const value: Record<string, unknown> = {}, previous = record(base) ? base : {}
    const accepted = acknowledged && record(acknowledged.value) ? acknowledged.value : undefined
    const committed = record(acceptedValue) ? acceptedValue : undefined
    let conflict = false
    for (const key of new Set([...Object.keys(previous), ...Object.keys(local), ...Object.keys(remote)])) {
      const merged = mergeSettingsValue(previous[key], local[key], remote[key],
        acknowledged ? { value: accepted?.[key], accepted: committed?.[key] } : undefined)
      if (merged.value !== undefined) value[key] = merged.value
      conflict ||= merged.conflict
    }
    return { value, conflict }
  }
  // A change made after submission is still pending, even if it restores the
  // old value. The accepted response must never overwrite that later intent.
  return { value: local, conflict: true }
}
