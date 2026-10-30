export { addExplanationExcerpt, addExplanationRegion, explanationPages, updateExplanationExcerptQuestion,
  MAX_EXPLANATION_CHARACTERS, MAX_EXPLANATION_EXCERPTS, MAX_EXPLANATION_ITEM_QUESTION_CHARACTERS,
  MAX_EXPLANATION_REGION_IMAGE_BYTES, MAX_EXPLANATION_REGION_IMAGES,
  type AddExcerptResult, type ExplanationExcerpt, type ExplanationSelection,
  type RegionExplanationExcerpt, type TextExplanationExcerpt } from './model.js'
export { buildMixedExplanationPrompt, type ExplanationImageReferencePreparation,
  type ExplanationImageReferenceRequest, type MixedExplanationPromptOptions,
  type PromptContentPart } from './prompt.js'
export { encodeExplanationImageBytes } from './image.js'
export { explanationSourceIdentity, sameExplanationSource, type ExplanationSourceIdentity } from './source.js'
