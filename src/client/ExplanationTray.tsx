import React from 'react'
import { explanationPages, MAX_EXPLANATION_EXCERPTS, type ExplanationExcerpt } from './explain-mode.js'

export interface ExplanationTrayProps {
  excerpts: readonly ExplanationExcerpt[]
  question: string
  error: string
  sending: boolean
  t(key: string): string
  onQuestionChange(value: string): void
  onRemove(id: string): void
  onSend(): void
  onCancel(): void
}

/** An ephemeral reading draft; nothing here mutates the PDF or its annotation list. */
export function ExplanationTray({ excerpts, question, error, sending, t,
  onQuestionChange, onRemove, onSend, onCancel }: ExplanationTrayProps) {
  return <section className="dsh-pdf-explanation-tray" aria-label={t('reader.explain.title')}>
    <div className="dsh-pdf-explanation-heading">
      <strong>{t('reader.explain.title')} <span>{excerpts.length}/{MAX_EXPLANATION_EXCERPTS}</span></strong>
      <button type="button" disabled={sending} onClick={onCancel}>{t('reader.cancel')}</button>
    </div>
    {excerpts.length ? <ol className="dsh-pdf-explanation-excerpts">
      {excerpts.map((excerpt, index) => <li key={excerpt.id}>
        <div><span>{index + 1}. {t('reader.explain.pages')} {explanationPages(excerpt).join(', ')}</span>
          <button type="button" disabled={sending} aria-label={`${t('reader.explain.remove')} ${index + 1}`}
            onClick={() => onRemove(excerpt.id)}>×</button></div>
        <p>{excerpt.text}</p>
      </li>)}
    </ol> : <p className="dsh-pdf-explanation-empty">{t('reader.explain.empty')}</p>}
    <label>{t('reader.explain.optionalQuestion')}
      <textarea rows={2} maxLength={2000} value={question} disabled={sending}
        placeholder={t('reader.explain.questionPlaceholder')}
        onChange={event => onQuestionChange(event.target.value)} />
    </label>
    {error && <p className="dsh-pdf-explanation-error" role="alert">{error}</p>}
    <button type="button" className="dsh-pdf-primary" disabled={!excerpts.length || sending} onClick={onSend}>
      {t(sending ? 'reader.explain.sending' : 'reader.explain.send')}
    </button>
  </section>
}
