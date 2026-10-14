import React from 'react'

export type ToolbarIconName = 'tools' | 'zoom' | 'save' | 'saveAs' | 'discard'

/** Compact reader controls use the same stroke weight as the sidebar rail. */
export function ToolbarIcon({ name }: { name: ToolbarIconName }) {
  return <svg className="dsh-pdf-toolbar-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === 'tools' ? <>
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
    </> : <>
      <path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13M10 11v6M14 11v6" />
    </>}
  </svg>
}
