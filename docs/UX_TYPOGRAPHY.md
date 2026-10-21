# PDF Reader typography

This is the typography contract for the PDF reader UI. PDF page content is rendered from the document and must keep its source typography; these rules apply to reader chrome, sidebars, toolbars, comments, and plugin-owned result cards. The PDF settings section follows DSH's settings typography and controls instead of the reader's panel scale.

## Typeface and language

- Inherit the application font from DSH so the reader stays aligned with the host UI. Let the operating system provide native Chinese glyph fallback; do not hard-code a second font stack in the plugin.
- Chinese and English use the same semantic size and weight. Do not add locale-specific size overrides or tracking: mixed-language controls should remain aligned.
- Keep tracking at the platform default for body text and Chinese. Only introduce display tracking after checking both scripts together.
- Use a monospace face only for code or machine-readable data whose character alignment matters. Page numbers, dates, and counts stay in the UI font with tabular numerals.

## Semantic scale

| Token | Size / leading | Use |
| --- | --- | --- |
| `caption` | 12px / 1.35 | Author, date, helper text, compact counters, secondary metadata |
| `label` | 13px / 1.4 | Compact controls, field labels, sidebar section headings |
| `body-compact` | 13px / 1.5 | Dense result summaries, dictionary meanings, and examples |
| `body` | 14px / 1.5 | Default reader UI, buttons, inputs, and comment text |
| `section` | 16px / 1.4 | Translation terms and prominent section headings |
| `title` | 20px / 1.3 | Major dialog or panel title only |

Use regular (400) for reading, medium (500) for quiet emphasis, semibold (600) for headings and primary actions, and bold (700) only for strong status emphasis. Avoid intermediate weights such as 550 or 650; use the closest supported semantic weight.

Long explanatory/helper copy may use 1.6 leading for easier reading; the compact scale uses 1.5 to conserve sidebar space. UI labels and one-line metadata use the tighter leading in the table.

## Application rules

- The PDF settings section uses DSH's settings hierarchy: an 18px section title, 13px group headings and field labels, and 12px helper text. Its input and button colors, radii, and spacing use the host settings tokens.
- Prefer hierarchy through size, weight, spacing, and semantic color rather than shrinking text. Routine metadata should not fall below 12px.
- Body and comment text should wrap; labels may truncate only when the full value is available through a tooltip or accessible name.
- Use tabular numerals for page numbers, counts, and timestamps so changing values do not shift adjacent controls.
- Keep interactive text at least as large as the body token. Icons may use their own geometry and are not typography tokens.
- Preserve DSH color tokens and contrast in light and dark themes. Do not encode meaning by font color alone.
- Keep browser zoom and app scaling effective; avoid fixed-height text containers that clip larger text. Revisit line wrapping when typography changes.

## Source of truth

The semantic CSS variables live in the plugin stylesheet's `:root` in `src/client/reader.css` so both the reader and its evidence cards can consume them. Component styles should use those variables instead of introducing new pixel sizes. When adding a new text role, choose an existing token first; extend the scale only for a demonstrated need.
