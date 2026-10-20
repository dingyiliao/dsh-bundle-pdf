import React, { memo, useCallback } from 'react'
import { Page, type PageProps } from './Page.js'

/** Bind a page number without recreating all page handlers on every Reader render. */
export const ReaderPage = memo(function ReaderPage(props: Omit<PageProps, 'onNamedAction'> & {
  onAction(page: number, action: string): void
}) {
  const { onAction, ...page } = props
  const onNamedAction = useCallback((action: string) => onAction(page.geometry.page, action), [onAction, page.geometry.page])
  return <Page {...page} onNamedAction={onNamedAction} />
})
