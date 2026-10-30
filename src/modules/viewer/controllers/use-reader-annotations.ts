import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { NewPdfAnnotation, PdfAnnotation, PdfAnnotationOperation, PdfRect } from '../../../core/pdf-types.js'
import type { WorkspaceSnapshot } from '../../../shared/contracts.js'
import type { ReaderSelection } from '../model/reader-selection.js'
import { colorFromHex, colorToHex } from '../model/reader-selection.js'
import { createAnnotationThreadIndex, isReply, isStandaloneNote } from '../model/annotation-thread.js'

const noAnnotations: PdfAnnotation[] = []
const initialColor = '#ffff00'

function groupAnnotations(annotations: readonly PdfAnnotation[]): Map<number, PdfAnnotation[]> {
  const grouped = new Map<number, PdfAnnotation[]>()
  for (const annotation of annotations) {
    const page = grouped.get(annotation.page)
    if (page) page.push(annotation)
    else grouped.set(annotation.page, [annotation])
  }
  return grouped
}

export interface ReaderAnnotationsOptions {
  snapshot: WorkspaceSnapshot | null
  pdfAnnotations: readonly PdfAnnotation[]
  selection: ReaderSelection | null
  setSelection: Dispatch<SetStateAction<ReaderSelection | null>>
  setMode: Dispatch<SetStateAction<'text' | 'region' | 'note'>>
  ownerSequence: MutableRefObject<number>
  operationLock: MutableRefObject<boolean>
  currentSnapshot(): WorkspaceSnapshot | null
  change(operations: PdfAnnotationOperation[]): Promise<WorkspaceSnapshot | undefined>
  t(key: string): string
}

/** Owns optimistic mark previews, note/comment drafts and serialized color edits. */
export function useReaderAnnotations(options: ReaderAnnotationsOptions) {
  const { snapshot, pdfAnnotations, selection, setSelection, setMode, ownerSequence,
    operationLock, currentSnapshot, change, t } = options
  const [color, setColor] = useState(initialColor)
  const [selectedAnnotation, setSelectedAnnotation] = useState<string>()
  const selectedAnnotationRef = useRef(selectedAnnotation)
  selectedAnnotationRef.current = selectedAnnotation
  const [pendingAnnotations, setPendingAnnotations] = useState<PdfAnnotation[]>(noAnnotations)
  const [pendingNote, setPendingNote] = useState<NewPdfAnnotation | null>(null)
  const [commentCardOpen, setCommentCardOpen] = useState(false)
  const [noteCardOpen, setNoteCardOpen] = useState(false)
  const [noteMode, setNoteMode] = useState<'read' | 'new' | 'edit'>('read')
  const [noteText, setNoteText] = useState('')
  const [noteColor, setNoteColor] = useState('#ffd900')
  const [commentMode, setCommentMode] = useState<'read' | 'new' | 'edit'>('read')
  const [editingCommentId, setEditingCommentId] = useState<string>()
  const [comment, setComment] = useState('')
  const [annotationColor, setAnnotationColor] = useState(initialColor)
  const [commentFocusRequest, setCommentFocusRequest] = useState(0)
  const handledCommentFocus = useRef(0)
  const commentTextarea = useRef<HTMLTextAreaElement>(null)
  const [noteFocusRequest, setNoteFocusRequest] = useState(0)
  const handledNoteFocus = useRef(0)
  const noteTextarea = useRef<HTMLTextAreaElement>(null)
  const [colorPending, setColorPending] = useState(false)
  const colorChanges = useRef(new Map<string, { owner: number; documentId: string; annotationId: string; color: string }>())
  const colorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const colorFlush = useRef<() => Promise<void>>(async () => {})
  const lastColorWrite = useRef(0)

  const displayAnnotations = useMemo(() => {
    if (!pendingAnnotations.length) return snapshot?.document.annotations ?? noAnnotations
    const combined = new Map((snapshot?.document.annotations ?? []).map(annotation => [annotation.id, annotation]))
    for (const annotation of pendingAnnotations) if (!combined.has(annotation.id)) combined.set(annotation.id, annotation)
    return [...combined.values()]
  }, [snapshot?.document.annotations, pendingAnnotations])
  const threadIndex = useMemo(() => createAnnotationThreadIndex(displayAnnotations), [displayAnnotations])
  const annotationsById = threadIndex.byId
  const selected = selectedAnnotation ? annotationsById.get(selectedAnnotation) : undefined
  const selectedNote = selected && isStandaloneNote(selected) ? selected : undefined
  const thread = useMemo(() => selected && !isStandaloneNote(selected) ? threadIndex.thread(selected) : undefined,
    [selected, threadIndex])
  const blockedCommentDeleteIds = useMemo(() => new Set(displayAnnotations.filter(isReply)
    .map(annotation => annotation.replyToId!)), [displayAnnotations])
  const editingComment = editingCommentId ? annotationsById.get(editingCommentId) : undefined
  const hasUnappliedAnnotation = !!(pendingNote && noteText.trim())
    || (noteCardOpen && noteMode === 'edit' && noteText !== (selectedNote?.contents ?? ''))
    || (commentCardOpen && (commentMode === 'new' ? !!comment.trim()
      : commentMode === 'edit' && comment !== (editingComment?.contents ?? '')))
  const annotationItems = useMemo(() => {
    const items = snapshot?.document.annotations ?? noAnnotations
    const index = createAnnotationThreadIndex(items)
    const commentedRoots = new Set(items.filter(annotation => isReply(annotation) && annotation.contents?.trim())
      .map(annotation => index.rootOf(annotation).id))
    return items.filter(annotation => index.rootOf(annotation).id === annotation.id
      && (annotation.supported || commentedRoots.has(annotation.id)
        || (annotation.contents && annotation.subtype !== 'Popup')))
  }, [snapshot?.document.annotations])
  const annotationsByPage = useMemo(() => groupAnnotations(displayAnnotations), [displayAnnotations])
  const renderedAnnotationsByPage = useMemo(() => groupAnnotations(pdfAnnotations), [pdfAnnotations])

  useLayoutEffect(() => {
    if (commentFocusRequest === handledCommentFocus.current || !commentCardOpen || commentMode === 'read') return
    const textarea = commentTextarea.current
    if (!textarea || textarea.closest<HTMLElement>('.dsh-pdf-page-comment-card')?.dataset.visible !== 'true') return
    handledCommentFocus.current = commentFocusRequest
    if (!textarea.disabled) textarea.focus()
  }, [commentFocusRequest, commentCardOpen, commentMode, selected?.id, pendingNote?.id])
  useLayoutEffect(() => {
    if (noteFocusRequest === handledNoteFocus.current || !noteCardOpen || noteMode === 'read') return
    const textarea = noteTextarea.current
    if (!textarea || textarea.closest<HTMLElement>('.dsh-pdf-page-comment-card')?.dataset.visible !== 'true') return
    handledNoteFocus.current = noteFocusRequest
    if (!textarea.disabled) textarea.focus()
  }, [noteFocusRequest, noteCardOpen, noteMode, selectedNote?.id, pendingNote?.id])
  useEffect(() => {
    if (commentMode === 'edit' && editingComment) setComment(editingComment.contents ?? '')
  }, [editingComment?.id, editingComment?.contents])
  useEffect(() => {
    if (noteMode === 'read' && selectedNote) setNoteText(selectedNote.contents ?? '')
  }, [noteMode, selectedNote?.id, selectedNote?.contents])
  useEffect(() => {
    if (!selectedNote) return
    const key = `${ownerSequence.current}:${snapshot?.id}:${selectedNote.id}`
    if (!colorChanges.current.has(key)) setNoteColor(colorToHex(selectedNote.color))
  }, [selectedNote?.id, selectedNote?.color?.join(',')])
  useEffect(() => {
    if (!selected || selected.subtype === 'Text') return
    const key = `${ownerSequence.current}:${snapshot?.id}:${selected.id}`
    if (!colorChanges.current.has(key)) setAnnotationColor(colorToHex(selected.color))
  }, [selected?.id, selected?.color?.join(',')])
  useEffect(() => {
    if (selectedAnnotation && snapshot && !selected) setSelectedAnnotation(undefined)
  }, [snapshot, selected, selectedAnnotation])
  useEffect(() => {
    // Host draft edits are durable. Only a queued local color needs an unload guard.
    if (!colorPending) return
    const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', leave)
    return () => window.removeEventListener('beforeunload', leave)
  }, [colorPending])
  useEffect(() => () => { if (colorTimer.current !== null) clearTimeout(colorTimer.current) }, [])

  const resetResource = () => {
    setSelectedAnnotation(undefined)
    setPendingNote(null)
    setCommentCardOpen(false)
    setNoteCardOpen(false)
    setNoteMode('read')
    setNoteText('')
    setCommentMode('read')
    setEditingCommentId(undefined)
    setPendingAnnotations(noAnnotations)
    setComment('')
    colorChanges.current.clear()
    if (colorTimer.current !== null) clearTimeout(colorTimer.current)
    colorTimer.current = null
    lastColorWrite.current = 0
    setColorPending(false)
  }
  const resetContent = () => {
    setSelectedAnnotation(undefined); setPendingNote(null); setCommentCardOpen(false)
    setNoteCardOpen(false); setNoteMode('read'); setNoteText('')
    setCommentMode('read'); setEditingCommentId(undefined)
  }
  const clearPending = () => setPendingAnnotations(noAnnotations)

  const scheduleColorFlush = (delay: number) => {
    if (colorTimer.current !== null) clearTimeout(colorTimer.current)
    colorTimer.current = setTimeout(() => { colorTimer.current = null; void colorFlush.current() }, delay)
  }
  colorFlush.current = async () => {
    if (operationLock.current) { scheduleColorFlush(50); return }
    const entry = colorChanges.current.entries().next().value
    if (!entry) return
    const [key, queued] = entry
    const current = currentSnapshot()
    const annotation = current?.document.annotations.find(item => item.id === queued.annotationId)
    if (queued.owner !== ownerSequence.current || current?.id !== queued.documentId || !annotation?.editable) {
      colorChanges.current.delete(key)
    } else if (colorToHex(annotation.color) === queued.color) {
      colorChanges.current.delete(key)
    } else {
      const appliedColor = queued.color
      lastColorWrite.current = Date.now()
      const next = await change([{ type: 'update', id: queued.annotationId, patch: { color: colorFromHex(appliedColor) } }])
      if (!next) {
        if (colorChanges.current.get(key) === queued) {
          colorChanges.current.delete(key)
          if (selectedAnnotationRef.current === queued.annotationId && queued.owner === ownerSequence.current
            && currentSnapshot()?.id === queued.documentId) {
            if (isStandaloneNote(annotation)) setNoteColor(colorToHex(annotation.color))
            else setAnnotationColor(colorToHex(annotation.color))
          }
        }
      } else if (colorChanges.current.get(key)?.color === appliedColor) colorChanges.current.delete(key)
    }
    setColorPending(colorChanges.current.size > 0)
    if (colorChanges.current.size) scheduleColorFlush(200)
  }

  const updateColor = (nextColor: string) => {
    if (!selected || selected.subtype === 'Text'
      || !snapshot || snapshot.document.readOnly || !selected.editable) return
    setAnnotationColor(nextColor)
    setColor(nextColor)
    const firstChange = colorChanges.current.size === 0
    const key = `${ownerSequence.current}:${snapshot.id}:${selected.id}`
    colorChanges.current.set(key, { owner: ownerSequence.current, documentId: snapshot.id, annotationId: selected.id, color: nextColor })
    setColorPending(true)
    scheduleColorFlush(firstChange && Date.now() - lastColorWrite.current > 300 ? 0 : 200)
  }

  const updateNoteColor = (nextColor: string) => {
    if (!/^#[0-9a-f]{6}$/i.test(nextColor) || !selectedNote?.editable || !snapshot
      || snapshot.document.readOnly) return
    setNoteColor(nextColor)
    const firstChange = colorChanges.current.size === 0
    const key = `${ownerSequence.current}:${snapshot.id}:${selectedNote.id}`
    colorChanges.current.set(key, { owner: ownerSequence.current, documentId: snapshot.id,
      annotationId: selectedNote.id, color: nextColor })
    setColorPending(true)
    scheduleColorFlush(firstChange && Date.now() - lastColorWrite.current > 300 ? 0 : 200)
  }

  const showCommentEditor = useCallback(() => {
    setComment('')
    setCommentMode('new')
    setEditingCommentId(undefined)
    setCommentCardOpen(true)
    setCommentFocusRequest(current => current + 1)
  }, [])
  const openCommentEditor = () => {
    if (snapshot?.document.readOnly || !selected?.editable) {
      if (thread?.comments.length) {
        setCommentMode('read')
        setCommentCardOpen(true)
      }
      return
    }
    if (commentCardOpen && commentMode !== 'read') { commentTextarea.current?.focus(); return }
    showCommentEditor()
  }
  const editComment = (id: string) => {
    const entry = thread?.comments.find(item => item.id === id)
    if (!entry?.editable || snapshot?.document.readOnly) return
    setEditingCommentId(id)
    setComment(entry.contents ?? '')
    setCommentMode('edit')
    setCommentCardOpen(true)
    setCommentFocusRequest(current => current + 1)
  }
  const onCommentCardVisible = () => {
    if (handledCommentFocus.current !== commentFocusRequest) setCommentFocusRequest(current => current + 1)
  }
  const closeCommentEditor = () => {
    if (commentMode !== 'read') {
      setCommentCardOpen(!!thread?.comments.length)
      setComment('')
      setCommentMode('read')
      setEditingCommentId(undefined)
      return
    }
    setCommentCardOpen(false)
    setSelectedAnnotation(undefined)
  }
  const dismissCommentCard = () => {
    if (commentCardOpen && commentMode !== 'read' && comment.trim()
      && !window.confirm(t('reader.discardCommentDraft'))) return
    setCommentCardOpen(false)
    setSelectedAnnotation(undefined)
    setComment('')
    setCommentMode('read')
    setEditingCommentId(undefined)
  }
  const applyComment = async () => {
    if (!comment.trim() || operationLock.current) return
    if (commentMode === 'edit' && editingComment?.hasRichText
      && !window.confirm(t('reader.richTextConversionConfirm'))) return
    const next = commentMode === 'edit' && editingComment ? await change([{
      type: 'update', id: editingComment.id, patch: { contents: comment.trim() },
    }]) : selected && thread?.comments.length ? await change([{ type: 'add', annotation: {
      id: crypto.randomUUID(), page: selected.page, subtype: 'Text', rect: selected.rect ?? [0, 0, 16, 16],
      replyToId: selected.id, contents: comment.trim(), author: 'DSH',
    } }]) : selected ? await change([{ type: 'update', id: selected.id, patch: { contents: comment.trim() } }]) : undefined
    if (!next) return
    setCommentMode('read')
    setEditingCommentId(undefined)
    setComment('')
    setCommentCardOpen(true)
  }

  const editNote = () => {
    if (!selectedNote?.editable || snapshot?.document.readOnly) return
    setNoteText(selectedNote.contents ?? '')
    setNoteMode('edit')
    setNoteFocusRequest(current => current + 1)
  }
  const onNoteCardVisible = () => {
    if (handledNoteFocus.current !== noteFocusRequest) setNoteFocusRequest(current => current + 1)
  }
  const cancelNoteEdit = () => {
    if (noteMode === 'new') {
      if (noteText.trim() && !window.confirm(t('reader.discardNoteDraft'))) return
      setPendingNote(null)
      setNoteCardOpen(false)
      setSelectedAnnotation(undefined)
      setNoteText('')
    } else if (noteMode === 'edit') {
      setNoteText(selectedNote?.contents ?? '')
      setNoteMode('read')
    }
  }
  const dismissNoteCard = () => {
    if (((pendingNote && noteText.trim()) || (noteMode === 'edit' && noteText !== (selectedNote?.contents ?? '')))
      && !window.confirm(t('reader.discardNoteDraft'))) return
    setPendingNote(null)
    setNoteCardOpen(false)
    setNoteMode('read')
    setNoteText('')
    setSelectedAnnotation(undefined)
  }
  const applyNote = async () => {
    if (!noteText.trim() || operationLock.current) return
    const next = pendingNote ? await change([{ type: 'add', annotation: {
      ...pendingNote, contents: noteText.trim(), author: 'DSH',
    } }]) : noteMode === 'edit' && selectedNote ? await change([{
      type: 'update', id: selectedNote.id, patch: { contents: noteText.trim() },
    }]) : undefined
    if (!next) return
    if (pendingNote) { setSelectedAnnotation(pendingNote.id); setPendingNote(null) }
    setNoteMode('read')
    setNoteText(noteText.trim())
    setNoteCardOpen(true)
  }
  const moveNote = async (rect: PdfRect): Promise<boolean> => {
    if (operationLock.current || snapshot?.document.readOnly) return false
    if (pendingNote) {
      setPendingNote(current => current ? { ...current, rect: [...rect] } : current)
      return true
    }
    if (!selectedNote?.editable) return false
    return !!await change([{ type: 'update', id: selectedNote.id, patch: { rect } }])
  }
  const moveNoteMarker = async (id: string, rect: PdfRect): Promise<boolean> => {
    const document = currentSnapshot()?.document
    const note = document?.annotations.find(annotation => annotation.id === id)
    if (operationLock.current || document?.readOnly || !note?.editable || !isStandaloneNote(note)) return false
    return !!await change([{ type: 'update', id, patch: { rect } }])
  }
  const canPersistCommentPosition = !!selected && selected.subtype !== 'Text' && selected.subtype !== 'Popup'
    && !selected.replyToId && !!selected.editable && !snapshot?.document.readOnly
    && !!snapshot?.document.annotations.some(annotation => annotation.id === selected.id)
  const moveCommentCard = async (position: [number, number]): Promise<boolean> => {
    if (!canPersistCommentPosition || !selected || operationLock.current) return false
    return !!await change([{ type: 'update', id: selected.id, patch: { commentPosition: position } }])
  }
  const deleteNote = async () => {
    if (!selectedNote?.editable || snapshot?.document.readOnly || operationLock.current) return
    const next = await change([{ type: 'delete', id: selectedNote.id }])
    if (!next) return
    setSelectedAnnotation(undefined)
    setNoteCardOpen(false)
    setNoteMode('read')
    setNoteText('')
  }
  const deleteComment = async (id: string) => {
    const entry = thread?.comments.find(item => item.id === id)
    if (!entry?.editable || !selected || snapshot?.document.readOnly) return
    if (entry.replyToId && blockedCommentDeleteIds.has(id)) return
    const operation: PdfAnnotationOperation = id === selected.id
      ? { type: 'update', id, patch: { contents: '' } }
      : { type: 'delete', id }
    const next = await change([operation])
    if (next) {
      setCommentMode('read'); setEditingCommentId(undefined); setComment('')
      const nextRoot = next.document.annotations.find(item => item.id === selected.id)
      if (nextRoot) setCommentCardOpen(createAnnotationThreadIndex(next.document.annotations).thread(nextRoot).comments.length > 0)
    }
  }

  const mark = async (subtype: 'Highlight' | 'Underline' | 'StrikeOut', selectedColor = color) => {
    if (!snapshot || operationLock.current || snapshot.document.readOnly || !selection
      || selection.revision !== snapshot.revision || selection.kind !== 'text') return
    const annotations: NewPdfAnnotation[] = selection.fragments.map(fragment => ({
      id: crypto.randomUUID(), page: fragment.page, subtype, rect: fragment.rect,
      quadPoints: fragment.quadPoints, color: colorFromHex(selectedColor),
    }))
    const operations: PdfAnnotationOperation[] = annotations.map(annotation => ({ type: 'add', annotation }))
    setPendingAnnotations(annotations.map(annotation => ({ ...annotation, flags: 4, supported: true, editable: true })))
    setSelection(null)
    window.getSelection()?.removeAllRanges()
    setSelectedAnnotation(annotations[0]?.id)
    setCommentCardOpen(false)
    setCommentMode('read')
    const changed = await change(operations)
    setPendingAnnotations(noAnnotations)
    if (changed) {
      setPendingNote(null)
      if (operations[0]?.type === 'add') setSelectedAnnotation(operations[0].annotation.id)
    }
  }

  const beginNote = (page: number, point: number[]) => {
    if (!snapshot || snapshot.document.readOnly) return
    const bounds = snapshot.document.pages[page - 1].cropBox
    const width = Math.min(20, bounds[2] - bounds[0]), height = Math.min(20, bounds[3] - bounds[1])
    const x = Math.max(bounds[0], Math.min(bounds[2] - width, point[0]))
    const y = Math.max(bounds[1] + height, Math.min(bounds[3], point[1]))
    setPendingNote({ id: crypto.randomUUID(), page, subtype: 'Text', rect: [x, y - height, x + width, y] })
    setSelectedAnnotation(undefined)
    setCommentCardOpen(false)
    setComment('')
    setCommentMode('read')
    setEditingCommentId(undefined)
    setNoteText('')
    setNoteColor('#ffd900')
    setNoteMode('new')
    setNoteCardOpen(true)
    setNoteFocusRequest(current => current + 1)
    setMode('text')
  }

  const selectAnnotation = useCallback((id: string, intent: 'select' | 'comment' | 'note' = 'select') => {
    const target = annotationsById.get(id)
    if (!target) return
    const root = threadIndex.rootOf(target)
    if (selectedAnnotationRef.current === root.id && hasUnappliedAnnotation) return
    if (selectedAnnotationRef.current !== root.id && hasUnappliedAnnotation
      && !window.confirm(t(pendingNote || noteMode !== 'read' ? 'reader.discardNoteDraft' : 'reader.discardCommentDraft'))) return
    const isNote = isStandaloneNote(root)
    const hasComments = !isNote && threadIndex.thread(root).comments.length > 0
    setPendingNote(null)
    setSelection(null)
    window.getSelection()?.removeAllRanges()
    setSelectedAnnotation(root.id)
    if (isNote) {
      setCommentCardOpen(false)
      setNoteText(root.contents ?? '')
      setNoteMode('read')
      setNoteCardOpen(true)
      return
    }
    setNoteCardOpen(false)
    setNoteMode('read')
    setComment('')
    setCommentMode('read')
    setEditingCommentId(undefined)
    setCommentCardOpen(hasComments)
    if (!hasComments && intent === 'comment') showCommentEditor()
  }, [annotationsById, threadIndex, hasUnappliedAnnotation, pendingNote, noteMode, t, setSelection, showCommentEditor])
  const clearAnnotation = useCallback(() => {
    if (hasUnappliedAnnotation) return
    setSelectedAnnotation(undefined); setPendingNote(null); setCommentCardOpen(false)
    setNoteCardOpen(false); setNoteMode('read'); setNoteText('')
    setCommentMode('read'); setEditingCommentId(undefined)
  }, [hasUnappliedAnnotation])
  const deleteAnnotation = async () => {
    if (selected?.editable && await change([{ type: 'delete', id: selected.id }])) clearAnnotation()
  }

  return { color, setColor, selectedAnnotation, setSelectedAnnotation, selected, pendingAnnotations,
    selectedNote, pendingNote, setPendingNote, commentCardOpen, setCommentCardOpen, commentMode, editingCommentId,
    thread, editingComment, blockedCommentDeleteIds, editComment, deleteComment, comment, setComment,
    annotationColor, setAnnotationColor, commentFocusRequest, setCommentFocusRequest, commentTextarea,
    noteCardOpen, noteMode, noteText, setNoteText, noteColor, updateNoteColor, noteTextarea, noteFocusRequest,
    colorPending, displayAnnotations, annotationItems, annotationsByPage, renderedAnnotationsByPage,
    hasUnappliedAnnotation, resetResource, resetContent, clearPending, updateColor, openCommentEditor,
    onCommentCardVisible, closeCommentEditor, dismissCommentCard, applyComment,
    editNote, onNoteCardVisible, cancelNoteEdit, dismissNoteCard, applyNote, moveNote, moveNoteMarker, deleteNote,
    canPersistCommentPosition, moveCommentCard,
    mark, beginNote, selectAnnotation, clearAnnotation, deleteAnnotation }
}
