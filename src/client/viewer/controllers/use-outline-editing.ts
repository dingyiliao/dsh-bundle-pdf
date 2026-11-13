import { useEffect, useMemo, useRef, useState } from 'react'
import type { PdfOutlineOperation } from '../../../core/pdf-types.js'
import type { OutlineAccess } from '../ports/outline.js'
import { outlineDrop, outlineKeyboardMove, outlineLocations, type OutlinePlacement } from '../model/outline-editing.js'

export interface OutlineNameEdit {
  kind: 'create' | 'rename'
  id: string
  title: string
  page: number
  parentId?: string
  index?: number
  revision: number
}
export interface OutlinePopup { id: string; kind: 'menu' | 'target' | 'delete'; anchor: HTMLElement; revision: number }

export function useOutlineEditing(access: OutlineAccess | undefined, currentPage: number, t: (key: string) => string) {
  const [editor, setEditor] = useState<OutlineNameEdit>()
  const [popup, setPopup] = useState<OutlinePopup>()
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const lock = useRef(false)
  const latest = useRef(access)
  latest.current = access
  const locations = useMemo(() => outlineLocations(access?.items ?? []), [access?.items])
  const editable = !!access?.editable && !access.readOnlyReason && !!access.items
  const busy = pending || !!access?.busy

  useEffect(() => { setEditor(undefined); setPopup(undefined); setError('') }, [access?.documentId])

  const change = async (operations: PdfOutlineOperation[], revision = access?.revision): Promise<boolean> => {
    if (!access || !editable || busy || lock.current || revision === undefined) return false
    const documentId = access.documentId
    if (revision !== access.revision) { setError(t('reader.sidebar.outlineChanged')); return false }
    lock.current = true
    setPending(true)
    setError('')
    try {
      const success = await access.change(operations, revision)
      if (latest.current?.documentId !== documentId) return false
      if (!success) setError(t('reader.sidebar.outlineChangeFailed'))
      return success
    } catch (cause) {
      if (latest.current?.documentId === documentId) setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally { lock.current = false; setPending(false) }
  }
  const closePopup = (focus = false) => {
    if (focus && popup?.anchor.isConnected) popup.anchor.focus()
    setPopup(undefined)
  }
  const beginCreate = (parentId?: string, index?: number) => {
    if (!access || !editable || busy || editor) return
    setError(''); setPopup(undefined)
    setEditor({ kind: 'create', id: crypto.randomUUID(), title: `${t('reader.page')} ${currentPage}`,
      page: currentPage, parentId, index, revision: access.revision })
  }
  const beginRename = (id: string) => {
    const item = locations.get(id)?.item
    if (!access || !editable || busy || editor || !item) return
    setError(''); setPopup(undefined)
    setEditor({ kind: 'rename', id, title: item.title, page: item.page ?? currentPage, revision: access.revision })
  }
  const submitName = async () => {
    if (!editor) return
    const title = editor.title.trim()
    if (!title) { setError(t('reader.sidebar.bookmarkNameRequired')); return }
    if (editor.kind === 'rename' && title === locations.get(editor.id)?.item.title) {
      setEditor(undefined); return { id: editor.id, parentId: locations.get(editor.id)?.parentId, revision: access?.revision }
    }
    const operation: PdfOutlineOperation = editor.kind === 'create'
      ? { type: 'outline-add', id: editor.id, title, page: editor.page, parentId: editor.parentId, index: editor.index }
      : { type: 'outline-update', id: editor.id, patch: { title } }
    if (await change([operation], editor.revision)) {
      setEditor(value => value === editor ? undefined : value)
      return { id: editor.id, parentId: editor.parentId ?? locations.get(editor.id)?.parentId, revision: editor.revision + 1 }
    }
  }
  const move = async (id: string, direction: 'up' | 'down' | 'indent' | 'outdent') => {
    const operation = outlineKeyboardMove(locations, access?.items ?? [], id, direction)
    if (!operation || editor) return undefined
    closePopup()
    return await change([operation]) ? operation : undefined
  }
  const drop = async (id: string, target: string, placement: OutlinePlacement, revision: number) => {
    const operation = outlineDrop(locations, id, target, placement)
    return !editor && operation ? change([operation], revision) : false
  }
  return { editor, popup, error, locations, editable, busy, change, beginCreate, beginRename, submitName, move, drop,
    closePopup, clearError: () => setError(''),
    cancelEditor: () => { setEditor(undefined); setError('') },
    setTitle: (title: string) => setEditor(value => value && { ...value, title }),
    openPopup: (id: string, anchor: HTMLElement) => {
      if (!access || !editable || busy || editor) return
      setError(''); setPopup(value => value?.id === id ? undefined : { id, anchor, kind: 'menu', revision: access.revision })
    },
    setPopupKind: (kind: OutlinePopup['kind']) => setPopup(value => value && { ...value, kind }),
  }
}
export type OutlineEditing = ReturnType<typeof useOutlineEditing>
