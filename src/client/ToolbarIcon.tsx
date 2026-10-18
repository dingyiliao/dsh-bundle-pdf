import React from 'react'

export type ToolbarIconName = 'tools' | 'back' | 'zoom' | 'undo' | 'redo' | 'save' | 'saveAs' | 'discard' | 'comment' | 'close'
  | 'copy' | 'explain' | 'translate' | 'highlight' | 'underline' | 'strike' | 'note' | 'chevronDown'

/** Compact reader controls use the same stroke weight as the sidebar rail. */
export function ToolbarIcon({ name, accent }: { name: ToolbarIconName; accent?: string }) {
  return <svg className="dsh-pdf-toolbar-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === 'back' ? <>
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
    </> : name === 'chevronDown' ? <>
      <path d="m6 9 6 6 6-6" />
    </> : name === 'tools' ? <>
      <circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.2" fill="currentColor" stroke="none" />
    </> : name === 'zoom' ? <>
      <circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.2 15.2 5 5M8 10.5h5M10.5 8v5" />
    </> : name === 'save' ? <>
      <path d="M4 4h13l3 3v13H4V4Z" /><path d="M8 4v6h8V4M8 20v-7h8v7" />
    </> : name === 'saveAs' ? <>
      <path d="M4 4h12l3 3v8M8 4v6h8V4M4 20h7M8 20v-7h7" />
      <path d="m14 20 5-5 2 2-5 5-3 1 1-3Z" />
    </> : name === 'comment' ? <>
      <path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3V6a2 2 0 0 1 1-2Z" />
      <path d="M8 9h8M8 13h6" />
    </> : name === 'close' ? <>
      <path d="M5 5l14 14M19 5 5 19" />
    </> : <>
      <path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13M10 11v6M14 11v6" />
    </>}
  </svg>
}
