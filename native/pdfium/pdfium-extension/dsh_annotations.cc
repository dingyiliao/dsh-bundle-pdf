#include "public/dsh_annotations.h"

#include <cmath>
#include <utility>

#include "core/fpdfapi/page/cpdf_annotcontext.h"
#include "core/fpdfapi/page/cpdf_page.h"
#include "core/fpdfapi/parser/cpdf_array.h"
#include "core/fpdfapi/parser/cpdf_boolean.h"
#include "core/fpdfapi/parser/cpdf_dictionary.h"
#include "core/fpdfapi/parser/cpdf_document.h"
#include "core/fpdfapi/parser/cpdf_name.h"
#include "core/fpdfapi/parser/cpdf_number.h"
#include "core/fpdfapi/parser/cpdf_reference.h"
#include "core/fpdfapi/parser/cpdf_stream.h"
#include "core/fpdfdoc/cpdf_color_utils.h"
#include "core/fxcrt/compiler_specific.h"
#include "core/fxge/cfx_color.h"
#include "fpdfsdk/cpdfsdk_helpers.h"
#include "public/fpdf_annot.h"

namespace {

RetainPtr<CPDF_Stream> AddForm(CPDF_Document& doc,
                               const CFX_FloatRect& bounds,
                               RetainPtr<CPDF_Dictionary> resources,
                               ByteStringView paint,
                               bool group) {
  auto dict = doc.New<CPDF_Dictionary>();
  dict->SetNewFor<CPDF_Name>("Type", "XObject");
  dict->SetNewFor<CPDF_Name>("Subtype", "Form");
  dict->SetNewFor<CPDF_Number>("FormType", 1);
  dict->SetRectFor("BBox", bounds);
  dict->SetFor("Resources", std::move(resources));
  if (group) {
    dict->SetNewFor<CPDF_Dictionary>("Group")
        ->SetNewFor<CPDF_Name>("S", "Transparency");
  }
  auto stream = doc.NewIndirect<CPDF_Stream>(std::move(dict));
  stream->SetData(paint.unsigned_span());
  return stream;
}

bool Channel(float value) {
  return std::isfinite(value) && value >= 0 && value <= 1;
}

}  // namespace

FPDF_EXPORT FPDF_BOOL FPDF_CALLCONV
FPDF_DSH_GetAnnotationDetails(FPDF_ANNOTATION annotation,
                             FPDF_DSH_ANNOTATION_DETAILS* details) {
  const auto* context = CPDFAnnotContextFromFPDFAnnotation(annotation);
  if (!context || !details)
    return false;
  const auto* dict = context->GetAnnotDict();
  *details = {};
  details->identity = dict;
  details->object_number = dict->GetObjNum();
  details->generation = dict->GetGenNum();
  if (dict->KeyExist("IRT")) {
    const auto relation = dict->GetNameFor("RT");
    details->reply_type = !dict->KeyExist("RT") || relation == "R"
        ? 1 : relation == "Group" ? 2 : -1;
    details->reply_parent = dict->GetDictFor("IRT").Get();
  }
  details->popup = dict->GetDictFor("Popup").Get();
  if (const auto action = dict->GetDictFor("A");
      action && dict->GetNameFor("Subtype") == "Link" && action->GetNameFor("S") == "Named") {
    const auto name = action->GetNameFor("N");
    details->named_action = name == "FirstPage" ? 1 : name == "LastPage" ? 2
        : name == "NextPage" ? 3 : name == "PrevPage" ? 4 : 0;
  }
  details->rich_text = dict->KeyExist("RC");
  if (auto color = dict->GetArrayFor("C"); color &&
      (color->size() == 1 || color->size() == 3 || color->size() == 4)) {
    bool valid = true;
    for (size_t index = 0; index < color->size(); ++index)
      valid = valid && !!color->GetNumberAt(index);
    if (valid) {
      const auto rgb = fpdfdoc::CFXColorFromArray(*color).ConvertColorType(CFX_Color::Type::kRGB);
      details->has_color = true;
      details->color[0] = rgb.fColor1;
      details->color[1] = rgb.fColor2;
      details->color[2] = rgb.fColor3;
    }
  }
  if (const auto opacity = dict->GetNumberFor("CA")) {
    details->opacity = opacity->GetNumber();
    details->has_opacity = std::isfinite(details->opacity);
  }
  if (const auto position = dict->GetArrayFor("DSHCommentPosition");
      position && position->size() == 2 && position->GetNumberAt(0) && position->GetNumberAt(1)) {
    details->comment_position = {position->GetFloatAt(0), position->GetFloatAt(1)};
    details->has_comment_position = std::isfinite(details->comment_position.x)
        && std::isfinite(details->comment_position.y);
  }
  return true;
}

FPDF_EXPORT int FPDF_CALLCONV
FPDF_DSH_GetPageAnnotationCount(FPDF_DOCUMENT document, int page_index) {
  auto* doc = CPDFDocumentFromFPDFDocument(document);
  const auto page = doc ? doc->GetPageDictionary(page_index) : nullptr;
  if (!page) return -1;
  const auto annotations = page->GetArrayFor("Annots");
  return annotations ? static_cast<int>(annotations->size()) : 0;
}

FPDF_EXPORT FPDF_BOOL FPDF_CALLCONV
FPDF_DSH_SetAnnotationContents(FPDF_ANNOTATION annotation, FPDF_WIDESTRING contents) {
  auto* context = CPDFAnnotContextFromFPDFAnnotation(annotation);
  if (!context || !contents || !FPDFAnnot_SetStringValue(annotation, "Contents", contents))
    return false;
  context->GetMutableAnnotDict()->RemoveFor("RC");
  return true;
}

FPDF_EXPORT FPDF_BOOL FPDF_CALLCONV
FPDF_DSH_SetAnnotationAppearance(FPDF_ANNOTATION annotation,
                                 const char* paint,
                                 size_t paint_size,
                                 const float color[3],
                                 float opacity,
                                 FPDF_BOOL multiply) {
  auto* context = CPDFAnnotContextFromFPDFAnnotation(annotation);
  if (!context || !paint || !paint_size || paint_size > 1024 * 1024 ||
      !Channel(opacity)) {
    return false;
  }
  // SAFETY: The C ABI requires paint_size bytes and either three channels
  // or a null color pointer to keep the original annotation color.
  const auto channels = color ? UNSAFE_BUFFERS(pdfium::span(color, size_t{3}))
                              : pdfium::span<const float>();
  const auto commands = UNSAFE_BUFFERS(ByteStringView(paint, paint_size));
  for (float channel : channels) {
    if (!Channel(channel))
      return false;
  }
  auto dict = context->GetMutableAnnotDict();
  auto* doc = context->GetPage()->GetDocument();
  const auto rect = dict->GetRectFor("Rect");
  if (!doc || !std::isfinite(rect.Width()) || !std::isfinite(rect.Height()) ||
      rect.Width() <= 0 || rect.Height() <= 0) {
    return false;
  }
  const CFX_FloatRect bounds(0, 0, rect.Width(), rect.Height());
  auto resources = doc->New<CPDF_Dictionary>();
  auto states = resources->SetNewFor<CPDF_Dictionary>("ExtGState");
  auto alpha = states->SetNewFor<CPDF_Dictionary>("GS0");
  alpha->SetNewFor<CPDF_Name>("Type", "ExtGState");
  alpha->SetNewFor<CPDF_Boolean>("AIS", false);
  alpha->SetNewFor<CPDF_Number>("ca", opacity);
  alpha->SetNewFor<CPDF_Number>("CA", opacity);
  ByteString appearance;
  if (multiply) {
    states->SetNewFor<CPDF_Dictionary>("GS1")
        ->SetNewFor<CPDF_Name>("BM", "Multiply");
    auto group = AddForm(*doc, bounds, doc->New<CPDF_Dictionary>(), commands, true);
    resources->SetNewFor<CPDF_Dictionary>("XObject")
        ->SetNewFor<CPDF_Reference>("Mark", doc, group->GetObjNum());
    appearance = "q\n/GS0 gs\n/GS1 gs\n/Mark Do\nQ\n";
  } else {
    appearance = "q\n/GS0 gs\n";
    appearance += commands;
    appearance += "\nQ\n";
  }
  auto stream = AddForm(*doc, bounds, std::move(resources),
                        appearance.AsStringView(), false);
  if (!channels.empty()) {
    auto array = dict->SetNewFor<CPDF_Array>("C");
    for (float channel : channels)
      array->AppendNew<CPDF_Number>(channel);
  }
  if (multiply)
    dict->SetNewFor<CPDF_Number>("CA", opacity);
  dict->SetNewFor<CPDF_Dictionary>("AP")
      ->SetNewFor<CPDF_Reference>("N", doc, stream->GetObjNum());
  dict->RemoveFor("AS");
  return true;
}

FPDF_EXPORT FPDF_BOOL FPDF_CALLCONV
FPDF_DSH_SetAnnotationReply(FPDF_PAGE handle,
                            FPDF_ANNOTATION reply,
                            FPDF_ANNOTATION parent) {
  auto* page = CPDFPageFromFPDFPage(handle);
  auto* child = CPDFAnnotContextFromFPDFAnnotation(reply);
  auto* root = CPDFAnnotContextFromFPDFAnnotation(parent);
  if (!page || !child || !root || child == root || child->GetPage() != page ||
      root->GetPage() != page || FPDFAnnot_GetSubtype(reply) != FPDF_ANNOT_TEXT) {
    return false;
  }
  auto dict = root->GetMutableAnnotDict();
  auto annotation = child->GetMutableAnnotDict();
  auto* doc = page->GetDocument();
  auto annots = page->GetOrCreateAnnotsArray();
  const auto position = annots->Find(dict.Get());
  if (!dict->GetObjNum()) {
    if (!position)
      return false;
    // Find() resolves references. Replace every direct alias before saving.
    doc->AddIndirectObject(dict);
    for (size_t index = 0; index < annots->size(); ++index) {
      if (annots->GetObjectAt(index).Get() == dict.Get())
        annots->SetNewAt<CPDF_Reference>(index, doc, dict->GetObjNum());
    }
  }
  annotation->SetNewFor<CPDF_Reference>("IRT", doc, dict->GetObjNum());
  annotation->SetNewFor<CPDF_Name>("RT", "R");
  annotation->SetNewFor<CPDF_Number>("F", FPDF_ANNOT_FLAG_NOVIEW);
  return true;
}

FPDF_EXPORT FPDF_BOOL FPDF_CALLCONV
FPDF_DSH_SetCommentPosition(FPDF_ANNOTATION annotation, const FS_POINTF* point) {
  auto* context = CPDFAnnotContextFromFPDFAnnotation(annotation);
  if (!context || (point && (!std::isfinite(point->x) || !std::isfinite(point->y))))
    return false;
  auto dict = context->GetMutableAnnotDict();
  if (!point) {
    dict->RemoveFor("DSHCommentPosition");
  } else {
    auto array = dict->SetNewFor<CPDF_Array>("DSHCommentPosition");
    array->AppendNew<CPDF_Number>(point->x);
    array->AppendNew<CPDF_Number>(point->y);
  }
  return true;
}
