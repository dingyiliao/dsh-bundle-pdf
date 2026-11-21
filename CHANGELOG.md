# Changelog

All notable user-visible changes to this project are documented here. Versions follow the package version in `package.json`; DSH compatibility follows `engines.dsh`.

## [Unreleased]

## [0.1.10] - 2026-11-21

### Added

- A baseline-backed Working Copy model shared by the Reader and agent tools, with explicit baseline mismatch choices instead of silently discarding operations.
- Background model opening of protected PDFs through the same Host baseline provider used by the Reader.
- Signature-risk reporting for files whose signature structures cannot be conclusively inspected.

### Changed

- Signed and possibly signed PDFs remain editable. Saving rewrites the PDF and invalidates any existing signature instead of treating the file as read-only.
- Reader feedback that does not block reading now lives in the activity rail: read-only, encrypted, signature, conflict, position and error notices, including the unlock-editing action. Password, reload and Save As prompts remain dialogs.
- Certification signatures with DocMDP permission 1 require an additional explicit confirmation before saving.
- Working Copy identity, baseline resources, operation sets and rendered content contexts now have separate lifecycle contracts.

### Compatibility

- DSH `>=0.2.2-rc.1 <0.3.0-0`.
- Existing V1 draft records remain readable; the persisted draft format number is unchanged.

### Breaking

- None.

### Migration

- No stored-data migration is required. Applications that assumed every signed PDF was read-only should use the reported signature state and save warning instead.

### Known issues

- Encrypted PDFs that are also signed remain on the stricter protected-document path and are not made editable by the ordinary signed-PDF policy.

## [0.1.9] - 2026-11-21

Native packages only; the plugin package did not reach the registry. Superseded by 0.1.10.

## [0.1.8] - 2026-11-13

### Added

- Public OCR, image-understanding, translation and embedding extension SDKs.
- Native PDFium packages for the supported platforms and clean-install package verification.
- Shared Reader/agent drafts, built-in bookmark editing, AcroForm filling and persistent semantic indexes.

### Compatibility

- Validated with DSH `0.2.2-rc.2`.
