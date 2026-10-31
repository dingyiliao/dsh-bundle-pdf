
export type ToolbarIconName = 'tools' | 'back' | 'zoom' | 'undo' | 'redo' | 'save' | 'saveAs' | 'discard' | 'edit' | 'comment' | 'commentedMark' | 'move' | 'close'
  | 'copy' | 'explain' | 'translate' | 'highlight' | 'underline' | 'strike' | 'note' | 'crop' | 'chevronDown' | 'activity' | 'send' | 'ocr' | 'file' | 'reload' | 'check' | 'lock' | 'warning' | 'selectText' | 'materials'

/** Compact reader controls use the same stroke weight as the sidebar rail. */
export function ToolbarIcon({ name, accent }: { name: ToolbarIconName; accent?: string }) {
  return <svg className="dsh-pdf-toolbar-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" data-icon={name}>
    {name === 'selectText' ? <>
      <path d="M4 8V4h4m8 0h4v4m0 8v4h-4M8 20H4v-4M8 9h8M12 9v7M9 16h6" />
    </> : name === 'materials' ? <>
      <path d="M9 6h11M9 12h11M9 18h11M3 5h1v3M3 8h2M3 11h2l-2 3h2M3 17h2v3H3" />
    </> : name === 'check' ? <>
      <path d="m5 12 4 4L19 6" />
    </> : name === 'lock' ? <>
      <rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
    </> : name === 'warning' ? <>
      <path d="m12 3 10 18H2L12 3ZM12 9v5M12 17v.1" />
    </> : name === 'ocr' ? <>
      <path d="M4 8V4h4m8 0h4v4m0 8v4h-4M8 20H4v-4M8 8h8M12 8v8M9 16h6" />
    </> : name === 'file' ? <>
      <path d="M5 3h9l5 5v13H5V3Zm9 0v5h5" /><path d="M8 13h8M8 17h8" />
    </> : name === 'back' ? <>
      <path d="M19 12H5m7-7-7 7 7 7" />
    </> : name === 'undo' ? <>
      <path d="m9 4-5 5 5 5" />
      <path d="M4 9h9a7 7 0 0 1 7 7v3" />
    </> : name === 'redo' ? <>
      <path d="m15 4 5 5-5 5" />
      <path d="M20 9h-9a7 7 0 0 0-7 7v3" />
    </> : name === 'highlight' ? <>
      {/* The highlighter's own bar is the mark, so `accent` colours it in place
          instead of stacking a second bar under the glyph. */}
      <path d="m4 17 9-9 3 3-9 9H4v-3ZM11 10l6-6 3 3-6 6" />
      {/* The bar sits on the same baseline as the underline icon's, so the two
          text-mark icons read as one set. */}
      <path d="M3 21h14" stroke={accent ?? 'currentColor'} />
    </> : name === 'copy' ? <>
      <rect x="8" y="8" width="12" height="13" rx="1.5" />
      <path d="M5 17H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v1" />
    </> : name === 'explain' ? <>
      <path d="M7 14c-1.2-1-1.8-2.3-1.8-4a4.8 4.8 0 0 1 9.6 0c0 1.7-.6 3-1.8 4-.6.5-.9 1.2-.9 2.1H7.9c0-.9-.3-1.6-.9-2.1Z" />
      <path d="M8 18h4M9 21h2" />
      <path d="M19 2.5c.4 1.9.9 2.4 2.8 2.8-1.9.4-2.4.9-2.8 2.8-.4-1.9-.9-2.4-2.8-2.8 1.9-.4 2.4-.9 2.8-2.8Z" />
    </> : name === 'translate' ? <>
      <path d="M3 5h12M9 3v2M5 8c1.8 3.4 4.6 6 8 7M12 8c-1.4 4-4 6.5-8 8M13 21l4-9 4 9M14.5 18h5" />
    </> : name === 'underline' ? <>
      <path d="M6 4v8a6 6 0 0 0 12 0V4M4 21h16" />
    </> : name === 'strike' ? <>
      <path d="M17 5c-1.4-1-3.2-1.5-5-1.5-3.3 0-5.5 1.6-5.5 4 0 1.9 1.5 2.9 5.5 4 4 1.1 5.5 2.1 5.5 4.1S15.3 20 12 20c-2.2 0-4.2-.6-5.5-1.7M3 12h18" />
    </> : name === 'note' ? <>
      <path d="M4 3h16v13l-5 5H4V3ZM15 21v-5h5M8 8h8M8 12h5" />
    </> : name === 'crop' ? <>
      <path d="M7 3v12a2 2 0 0 0 2 2h12M3 7h12a2 2 0 0 1 2 2v12" />
      <path d="M10 10h4v4h-4z" strokeDasharray="1 2" />
    </> : name === 'reload' ? <>
      <path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 17.9 17" />
    </> : name === 'chevronDown' ? <>
      <path d="m6 9 6 6 6-6" />
    </> : name === 'activity' ? <>
      <path d="M4 6h12M4 12h16M4 18h12" /><circle cx="19" cy="6" r="1.5" fill="currentColor" stroke="none" />
    </> : name === 'send' ? <>
      <path d="m4 19 16-7L4 5l2 7-2 7ZM6 12h8" />
    </> : name === 'tools' ? <>
      <rect x="3" y="8" width="18" height="12" rx="2" />
      <path d="M8 8V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h7m4 0h7" />
      <rect x="10" y="12" width="4" height="3" rx=".5" fill="var(--pdf-panel)" />
    </> : name === 'zoom' ? <>
      <circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.2 15.2 5 5M8 10.5h5M10.5 8v5" />
    </> : name === 'save' ? <>
      <path d="M4 4h13l3 3v13H4V4Z" /><path d="M8 4v6h8V4M8 20v-7h8v7" />
    </> : name === 'saveAs' ? <>
      <path d="M4 4h12l3 3v8M8 4v6h8V4M4 20h7M8 20v-7h7" />
      <path d="m14 20 5-5 2 2-5 5-3 1 1-3Z" />
    </> : name === 'edit' ? <>
      {/* Match the trash glyph's 4–20 vertical footprint, not just its canvas. */}
      <path d="m15 4 5 5L9 20H4v-5L15 4ZM12.5 6.5l5 5" />
    </> : name === 'comment' ? <>
      <path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3V6a2 2 0 0 1 1-2Z" />
      <path d="M8 9h8M8 13h6" />
    </> : name === 'commentedMark' ? <>
      {/* Keep the document's top edge and folded corner explicit. Without that
          silhouette the text strokes read like a clipped glyph at small sizes. */}
      <path d="M5 3.5h8l4 4V12M5 3.5v17h8" />
      <path d="M13 3.5v4h4" />
      <path d="M8 10h6M8 13h3" />
      <path d="M8 16h3.5" stroke={accent ?? 'currentColor'} strokeWidth="2.4" />
      <path d="M13 13h5a1.5 1.5 0 0 1 1.5 1.5v2.5a1.5 1.5 0 0 1-1.5 1.5h-2l-2.5 2v-2H13v-5.5Z" fill="var(--pdf-panel)" />
    </> : name === 'move' ? <>
      <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="16" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="16" r="1" fill="currentColor" stroke="none" />
      <circle cx="16" cy="16" r="1" fill="currentColor" stroke="none" />
    </> : name === 'close' ? <>
      <path d="M5 5l14 14M19 5 5 19" />
    </> : <>
      <path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13M10 11v6M14 11v6" />
    </>}
  </svg>
}
