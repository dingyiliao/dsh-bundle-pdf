/** Compatibility with official Desktop builds whose update admission check expires in 10 seconds.
 * Read-only subscriptions yield with 5 seconds of headroom; events still wake them immediately.
 * This budget never bounds writes or active tool work. */
export const PASSIVE_POLL_TIMEOUT_MS = 5_000
