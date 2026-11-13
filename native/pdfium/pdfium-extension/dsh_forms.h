#ifndef PUBLIC_DSH_FORMS_H_
#define PUBLIC_DSH_FORMS_H_

#include <stddef.h>
#include <stdint.h>

#include "fpdfview.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum DSHPDF_FORM_KIND_ {
  DSHPDF_FORM_UNSUPPORTED = 0,
  DSHPDF_FORM_TEXT_FIELD = 1,
  DSHPDF_FORM_CHECKBOX = 2,
  DSHPDF_FORM_RADIO = 3,
  DSHPDF_FORM_DROPDOWN = 4,
  DSHPDF_FORM_OPTION_LIST = 5,
} DSHPDF_FORM_KIND;

typedef struct DSHPDF_FORM_TEXT_ {
  const char* data;
  size_t size;
} DSHPDF_FORM_TEXT;

typedef struct DSHPDF_FORM_WIDGET_ {
  int page_index;
  float left;
  float bottom;
  float right;
  float top;
  DSHPDF_FORM_TEXT radio_option;
} DSHPDF_FORM_WIDGET;

typedef struct DSHPDF_FORM_FIELD_ {
  uint32_t object_number;
  uint32_t generation;
  DSHPDF_FORM_KIND kind;
  FPDF_BOOL read_only;
  FPDF_BOOL required;
  FPDF_BOOL multiline;
  FPDF_BOOL multiple;
  int max_length;
  DSHPDF_FORM_TEXT name;
  DSHPDF_FORM_TEXT description;
  const DSHPDF_FORM_TEXT* values;
  size_t value_count;
  const DSHPDF_FORM_TEXT* options;
  size_t option_count;
  FPDF_BOOL checked;
  const DSHPDF_FORM_WIDGET* widgets;
  size_t widget_count;
} DSHPDF_FORM_FIELD;

typedef struct DSHPDF_FORM_EDIT_ {
  uint32_t object_number;
  uint32_t generation;
  DSHPDF_FORM_KIND kind;
  const DSHPDF_FORM_TEXT* values;
  size_t value_count;
  FPDF_BOOL checked;
} DSHPDF_FORM_EDIT;

typedef void (*DSHPDF_FORM_VISITOR)(void* context,
                                    const DSHPDF_FORM_FIELD* field);

// Visits AcroForm fields with their native identities and visible widgets.
// All strings are UTF-8 and borrowed for the duration of the callback.
// Choices are exposed using display labels, with page indices zero based.
// Returns NULL on success, otherwise a static diagnostic.
FPDF_EXPORT const char* FPDF_CALLCONV
DSHPDF_VisitFormFields(FPDF_DOCUMENT document,
                       DSHPDF_FORM_VISITOR visitor,
                       void* context);

// Applies canonical AcroForm changes to an isolated document without executing
// actions or JavaScript. Text and radio take one string, checkbox uses checked,
// and choice fields take display labels (zero to clear). The caller must
// discard the isolated document on error and save only on success.
// Optional CID-keyed OpenType bytes provide portable glyphs for widget text.
// Returns NULL on success, otherwise a static diagnostic.
FPDF_EXPORT const char* FPDF_CALLCONV
DSHPDF_ApplyFormFields(FPDF_DOCUMENT document,
                       const DSHPDF_FORM_EDIT* edits,
                       size_t count,
                       const uint8_t* font_data,
                       size_t font_size);

#ifdef __cplusplus
}
#endif

#endif  // PUBLIC_DSH_FORMS_H_
