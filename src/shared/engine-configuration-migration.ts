import type { EngineConfiguration, EngineConfigurations } from '../modules/engines/index.js'

function hasExplicitVisionRoute(config: EngineConfiguration | undefined): boolean {
  return typeof config?.provider === 'string' && !!config.provider.trim()
    && typeof config.model === 'string' && !!config.model.trim()
}

/** Retired built-in settings are removed at configuration boundaries, not sent to providers. */
export function migrateEngineConfigurations(input: EngineConfigurations = {}, imageEngine?: string): EngineConfigurations {
  if (imageEngine && migrateImageEngine(imageEngine, input) === 'dsh-vision' && imageEngine !== 'dsh-vision') {
    const image = { ...input.image }
    // Explicit new settings win. Otherwise preserve the selected legacy route;
    // a session choice must never inherit an unrelated auxiliary model.
    image['dsh-vision'] = hasExplicitVisionRoute(image['dsh-vision'])
      ? image['dsh-vision']! : image[imageEngine] ?? image['dsh-vision'] ?? {}
    delete image['session-vision']; delete image['auxiliary-vision']
    input = { ...input, image }
  }
  const vision = input.image?.['dsh-vision']
  if (vision) {
    const configuration = { ...vision }
    for (const key of ['provider', 'model', 'reasoningEffort']) {
      if (typeof configuration[key] !== 'string') continue
      const value = configuration[key].trim()
      if (value) configuration[key] = value
      else delete configuration[key]
    }
    // Following a conversation inherits its complete route, including effort.
    if (configuration.provider === undefined && configuration.model === undefined) delete configuration.reasoningEffort
    if (JSON.stringify(configuration) !== JSON.stringify(vision)) {
      input = { ...input, image: { ...input.image, 'dsh-vision': configuration } }
    }
  }
  const service = input.embedding?.['local-qwen3-embedding']
  if (!service || !Object.hasOwn(service, 'modelRevision')) return input
  const { modelRevision: _retired, ...configuration } = service
  return { ...input, embedding: { ...input.embedding, 'local-qwen3-embedding': configuration } }
}

/** Keep unavailable legacy choices when their previous model cannot be proven. */
export function migrateImageEngine(imageEngine: string, configurations: EngineConfigurations = {}): string {
  if (imageEngine === 'session-vision') return 'dsh-vision'
  if (imageEngine === 'auxiliary-vision' && (hasExplicitVisionRoute(configurations.image?.['auxiliary-vision'])
    || hasExplicitVisionRoute(configurations.image?.['dsh-vision']))) return 'dsh-vision'
  return imageEngine
}
