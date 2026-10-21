/** The item slot is structural: it preserves the order of text and verified images. */
export const defaultExplanationPromptTemplate = '{{instruction}}\n\n{{document}}\n\n{{items}}'
export const MAX_EXPLANATION_PROMPT_TEMPLATE_LENGTH = 8192
export const MAX_EXPLANATION_INSTRUCTION_LENGTH = 2000

// Settings sends this schema to the Client as JSON. Keep its validation rule
// serializable: a transform callback that closes over a helper fails there.
export const explanationTemplatePattern =
  /^(?=[\s\S]*{{\s*items\s*}})(?![\s\S]*{{\s*items\s*}}[\s\S]*{{\s*items\s*}})(?:(?!{{|}})[\s\S]|{{\s*(?:instruction|document|count|items)\s*}})+$/

export type ExplanationTemplateIssue = 'empty' | 'tooLong' | 'itemsRequired' | 'itemsRepeated' | 'unknownPlaceholder'
const allowed = new Set(['instruction', 'document', 'count', 'items'])
const placeholder = /{{([\s\S]*?)}}/g

export function explanationTemplateIssue(template: string): ExplanationTemplateIssue | null {
  if (!template.trim()) return 'empty'
  if (template.length > MAX_EXPLANATION_PROMPT_TEMPLATE_LENGTH) return 'tooLong'
  const matches = [...template.matchAll(placeholder)]
  if (matches.some(match => !allowed.has(match[1].trim()))
    || template.replace(placeholder, '').includes('{{')
    || template.replace(placeholder, '').includes('}}')) return 'unknownPlaceholder'
  const itemCount = matches.filter(match => match[1].trim() === 'items').length
  if (itemCount === 0) return 'itemsRequired'
  if (itemCount > 1) return 'itemsRepeated'
  return null
}
