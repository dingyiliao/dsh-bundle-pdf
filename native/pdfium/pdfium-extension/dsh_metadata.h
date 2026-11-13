// DSH extension to PDFium's public C API.
#ifndef PUBLIC_DSH_METADATA_H_
#define PUBLIC_DSH_METADATA_H_

#include "fpdfview.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  FS_RECTF media_box;
  FS_RECTF crop_box;
  int rotation;
  double user_unit;
} FPDF_DSH_PAGE_GEOMETRY;

// Reads inherited page boxes and rotation in degrees, and the page's UserUnit.
// CropBox defaults to MediaBox. It is reported before clipping to MediaBox.
FPDF_EXPORT FPDF_BOOL FPDF_CALLCONV
FPDF_DSH_GetPageGeometry(FPDF_DOCUMENT document,
                        int page_index,
                        FPDF_DSH_PAGE_GEOMETRY* geometry);

// Returns 1 for signature data, 0 for none, and -1 if inspection is incomplete.
// This does not validate a signature's cryptographic authenticity.
FPDF_EXPORT int FPDF_CALLCONV
FPDF_DSH_GetSignatureStatus(FPDF_DOCUMENT document);

typedef struct fpdf_dsh_content_fingerprint_t__* FPDF_DSH_CONTENT_FINGERPRINT;

// The fingerprint context is valid while its document stays open and unchanged.
// Page digests include shared resources and exclude page annotation objects.
// Returns NULL if the document's shared state cannot be fingerprinted.
FPDF_EXPORT FPDF_DSH_CONTENT_FINGERPRINT FPDF_CALLCONV
FPDF_DSH_CreateContentFingerprint(FPDF_DOCUMENT document);

// A false result leaves the output untouched. The caller may inspect other pages.
FPDF_EXPORT FPDF_BOOL FPDF_CALLCONV
FPDF_DSH_GetPageFingerprint(FPDF_DSH_CONTENT_FINGERPRINT fingerprint,
                           int page_index,
                           unsigned char digest[32]);

FPDF_EXPORT void FPDF_CALLCONV
FPDF_DSH_CloseContentFingerprint(FPDF_DSH_CONTENT_FINGERPRINT fingerprint);

#ifdef __cplusplus
}
#endif

#endif  // PUBLIC_DSH_METADATA_H_
