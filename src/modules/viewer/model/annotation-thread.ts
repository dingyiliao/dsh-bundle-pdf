import type { PdfAnnotation } from '../../../core/pdf-types.js'

/** A markup is the page target; PDF /IRT annotations are messages attached to it. */
export interface AnnotationThread {
  root: PdfAnnotation
  comments: PdfAnnotation[]
}

function parentOf(annotation: PdfAnnotation, byId: ReadonlyMap<string, PdfAnnotation>): PdfAnnotation | undefined {
  if (!annotation.replyToId || annotation.replyType === 'Group') return undefined
  const parent = byId.get(annotation.replyToId)
  return parent?.page === annotation.page ? parent : undefined
}

/** Resolve nested replies without trusting malformed or cyclic external PDFs. */
export function annotationRoot(annotation: PdfAnnotation, byId: ReadonlyMap<string, PdfAnnotation>): PdfAnnotation {
  const visited = new Map<string, number>()
  const path: PdfAnnotation[] = []
  let current = annotation
  while (true) {
    const cycle = visited.get(current.id)
    if (cycle !== undefined) {
      // Malformed cycles must resolve consistently from every member.
      return path.slice(cycle).sort((left, right) => left.id.localeCompare(right.id))[0]!
    }
    visited.set(current.id, path.length)
    path.push(current)
    const parent = parentOf(current, byId)
    if (!parent) return current
    current = parent
  }
}

/** One indexed projection per annotation snapshot; roots are path-compressed. */
export function createAnnotationThreadIndex(annotations: readonly PdfAnnotation[]) {
  const byId = new Map(annotations.map(annotation => [annotation.id, annotation]))
  const roots = new Map<string, PdfAnnotation>()
  const children = new Map<string, PdfAnnotation[]>()
  for (const annotation of annotations) {
    const parent = parentOf(annotation, byId)
    if (!parent) continue
    const group = children.get(parent.id)
    if (group) group.push(annotation)
    else children.set(parent.id, [annotation])
  }
  const rootOf = (annotation: PdfAnnotation): PdfAnnotation => {
    const known = roots.get(annotation.id)
    if (known) return known
    const visited = new Map<string, number>()
    const path: PdfAnnotation[] = []
    let current = annotation
    let root: PdfAnnotation
    while (true) {
      const cached = roots.get(current.id)
      if (cached) { root = cached; break }
      const cycle = visited.get(current.id)
      if (cycle !== undefined) {
        root = path.slice(cycle).sort((left, right) => left.id.localeCompare(right.id))[0]!
        break
      }
      visited.set(current.id, path.length)
      path.push(current)
      const parent = parentOf(current, byId)
      if (!parent) { root = current; break }
      current = parent
    }
    for (const member of path) roots.set(member.id, root)
    return root
  }
  const thread = (root: PdfAnnotation): AnnotationThread => {
    if (isStandaloneNote(root)) return { root, comments: [] }
    const comments: PdfAnnotation[] = []
    const visited = new Set<string>([root.id])
    // Explicit stack avoids overflowing JS call frames on hostile long chains.
    const stack: PdfAnnotation[] = [root]
    while (stack.length) {
      const current = stack.pop()!
      if (current.contents?.trim()) comments.push(current)
      const direct = children.get(current.id) ?? []
      for (let index = direct.length - 1; index >= 0; index--) {
        const child = direct[index]!
        if (visited.has(child.id) || rootOf(child).id !== root.id) continue
        visited.add(child.id)
        stack.push(child)
      }
    }
    return { root, comments }
  }
  return { byId, rootOf, thread }
}

/** Parent-first conversation order, independent of PDF /Annots array order. */
export function annotationThread(root: PdfAnnotation, annotations: readonly PdfAnnotation[]): AnnotationThread {
  return createAnnotationThreadIndex(annotations).thread(root)
}

export function isReply(annotation: PdfAnnotation): boolean {
  return !!annotation.replyToId && annotation.replyType !== 'Group'
}

/** A standalone PDF Text annotation is a sticky note, not a comment thread. */
export function isStandaloneNote(annotation: PdfAnnotation): boolean {
  return annotation.subtype === 'Text' && !annotation.replyToId
}
