#ifndef PUBLIC_DSH_ANNOTATIONS_H_
#define PUBLIC_DSH_ANNOTATIONS_H_

#include <stddef.h>
#include <stdint.h>

#include "fpdfview.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  // Borrowed dictionary identities. Compare inside the same open document.
  // Do not serialize these pointers or dereference them in the caller.
  const void* identity;
  const void* reply_parent;
  const void* popup;
  uint32_t object_number;
  uint32_t generation;
  int reply_type;  // 0 absent, 1 ordinary reply, 2 group, -1 malformed.
  FPDF_BOOL rich_text;
  FPDF_BOOL has_color;
  float color[3];
  FPDF_BOOL has_opacity;
  float opacity;
  FPDF_BOOL has_comment_position;
  FS_POINTF comment_position;
  int named_action;  // 0 absent, then FirstPage, LastPage, NextPage, PrevPage.
} FPDF_DSH_ANNOTATION_DETAILS;

FPDF_EXPORT FPDF_BOOL FPDF_CALLCONV
FPDF_DSH_GetAnnotationDetails(FPDF_ANNOTATION annotation,
                             FPDF_DSH_ANNOTATION_DETAILS* details);

FPDF_EXPORT int FPDF_CALLCONV
FPDF_DSH_GetPageAnnotationCount(FPDF_DOCUMENT document, int page_index);

FPDF_EXPORT FPDF_BOOL FPDF_CALLCONV
FPDF_DSH_SetAnnotationContents(FPDF_ANNOTATION annotation, FPDF_WIDESTRING contents);

// Replace the normal appearance of a markup annotation. The caller provides
// the local-coordinate paint operators. PDFium owns the form and its resources.
// A null color keeps the original annotation's color entry.
FPDF_EXPORT FPDF_BOOL FPDF_CALLCONV
FPDF_DSH_SetAnnotationAppearance(FPDF_ANNOTATION annotation,
                                 const char* paint,
                                 size_t paint_size,
                                 const float color[3],
                                 float opacity,
                                 FPDF_BOOL multiply);

// Store a reply to another annotation on the same page using a PDF reference.
FPDF_EXPORT FPDF_BOOL FPDF_CALLCONV
FPDF_DSH_SetAnnotationReply(FPDF_PAGE page,
                            FPDF_ANNOTATION reply,
                            FPDF_ANNOTATION parent);

// Update the reader-only comment anchor. A null point clears it.
FPDF_EXPORT FPDF_BOOL FPDF_CALLCONV
FPDF_DSH_SetCommentPosition(FPDF_ANNOTATION annotation, const FS_POINTF* point);

#ifdef __cplusplus
}
#endif

#endif  // PUBLIC_DSH_ANNOTATIONS_H_
