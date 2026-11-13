#ifndef PUBLIC_DSH_OUTLINES_H_
#define PUBLIC_DSH_OUTLINES_H_

#include <stddef.h>

#include "fpdfview.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef void (*DSHPDF_OUTLINE_VISITOR)(void* context,
                                       const char* id,
                                       const char* title,
                                       size_t title_length,
                                       int parent_index,
                                       int page_index);

typedef struct DSHPDF_OUTLINE_EDIT_ {
  const char* id;
  int parent_index;
  const char* title;
  int page_index;
} DSHPDF_OUTLINE_EDIT;

// Visits an unambiguous outline in preorder. Parent and page indices are zero
// based, with -1 indicating no parent or local destination. Callback strings
// use UTF-8 and are borrowed for the duration of the callback.
// Returns NULL on success, otherwise a static diagnostic. No rows are visited
// when validation fails.
FPDF_EXPORT const char* FPDF_CALLCONV
DSHPDF_VisitOutlines(FPDF_DOCUMENT document,
                     DSHPDF_OUTLINE_VISITOR visitor,
                     void* context);

// Applies a complete projected outline with stable IDs. NULL title and -1 page
// keep an existing item's title and destination. New items need both values.
// Validation precedes mutation. Call on the document being prepared for save.
// Returns NULL on success, otherwise a static diagnostic.
FPDF_EXPORT const char* FPDF_CALLCONV
DSHPDF_ApplyOutlines(FPDF_DOCUMENT document,
                      const DSHPDF_OUTLINE_EDIT* edits,
                      size_t count);

#ifdef __cplusplus
}
#endif

#endif  // PUBLIC_DSH_OUTLINES_H_
