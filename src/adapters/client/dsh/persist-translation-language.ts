/** Keep a rejected settings write from leaving a translation picker pending. */
export async function persistTranslationLanguage(mutate: () => Promise<boolean>): Promise<boolean> {
  try {
    return await mutate()
  } catch (cause) {
    console.error('[pdf] Failed to save translation target language', cause)
    return false
  }
}
