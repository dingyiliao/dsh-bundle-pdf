#include "public/dsh_forms.h"

#include <algorithm>
#include <cmath>
#include <map>
#include <optional>
#include <set>
#include <utility>
#include <vector>

#include "constants/annotation_flags.h"
#include "constants/form_flags.h"
#include "core/fpdfapi/parser/cpdf_array.h"
#include "core/fpdfapi/parser/cpdf_dictionary.h"
#include "core/fpdfapi/parser/cpdf_document.h"
#include "core/fpdfapi/parser/cpdf_name.h"
#include "core/fpdfapi/parser/cpdf_string.h"
#include "core/fpdfdoc/cpdf_bafontmap.h"
#include "core/fpdfdoc/cpdf_formcontrol.h"
#include "core/fpdfdoc/cpdf_formfield.h"
#include "core/fpdfdoc/cpdf_interactiveform.h"
#include "core/fxcrt/compiler_specific.h"
#include "core/fxcrt/utf16.h"
#include "fpdfsdk/cpdfsdk_formfillenvironment.h"
#include "fpdfsdk/cpdfsdk_helpers.h"
#include "fpdfsdk/cpdfsdk_interactiveform.h"
#include "fpdfsdk/dsh_form_font.h"
#include "public/fpdf_formfill.h"

namespace {

constexpr size_t kMaxEdits = 5000;
constexpr size_t kMaxValueBytes = 1024 * 1024;
constexpr auto kSilent = NotificationOption::kDoNotNotify;
using WidgetPages = std::map<const CPDF_Dictionary*, int>;
using FieldKey = std::pair<uint32_t, uint32_t>;

DSHPDF_FORM_KIND GetKind(const CPDF_FormField& field) {
  switch (field.GetType()) {
    case CPDF_FormField::kText: return DSHPDF_FORM_TEXT_FIELD;
    case CPDF_FormField::kCheckBox: return DSHPDF_FORM_CHECKBOX;
    case CPDF_FormField::kRadioButton: return DSHPDF_FORM_RADIO;
    case CPDF_FormField::kComboBox: return DSHPDF_FORM_DROPDOWN;
    case CPDF_FormField::kListBox: return DSHPDF_FORM_OPTION_LIST;
    default: return DSHPDF_FORM_UNSUPPORTED;
  }
}

bool IsButton(DSHPDF_FORM_KIND kind) {
  return kind == DSHPDF_FORM_CHECKBOX || kind == DSHPDF_FORM_RADIO;
}

bool IsChoice(DSHPDF_FORM_KIND kind) {
  return kind == DSHPDF_FORM_DROPDOWN || kind == DSHPDF_FORM_OPTION_LIST;
}

FieldKey GetKey(const CPDF_FormField& field) {
  const auto dictionary = field.GetFieldDict();
  return {dictionary->GetObjNum(), dictionary->GetGenNum()};
}

bool HasCanonicalControls(const CPDF_FormField& field) {
  const auto owner = field.GetFieldDict();
  const auto kids = owner->GetArrayFor("Kids");
  for (int index = 0; index < field.CountControls(); ++index) {
    const auto widget = field.GetControl(index)->GetWidgetDict();
    if (widget == owner) {
      continue;
    }
    const auto parent = widget->GetDictFor("Parent");
    if (parent ? parent != owner : !kids || !kids->Contains(widget.Get())) {
      return false;
    }
  }
  return true;
}

WidgetPages FindWidgetPages(CPDF_Document* document,
                            const std::set<const CPDF_Dictionary*>& widgets) {
  WidgetPages pages;
  for (int index = 0; index < document->GetPageCount() && pages.size() < widgets.size(); ++index) {
    const auto page = document->GetPageDictionary(index);
    const auto annotations = page ? page->GetArrayFor("Annots") : nullptr;
    if (!annotations) {
      continue;
    }
    for (size_t position = 0; position < annotations->size(); ++position) {
      const auto annotation = annotations->GetDictAt(position);
      if (widgets.contains(annotation.Get())) {
        pages.emplace(annotation.Get(), index);
      }
    }
  }
  return pages;
}

DSHPDF_FORM_TEXT Borrow(const ByteString& text) {
  return {text.c_str(), text.GetLength()};
}

std::vector<DSHPDF_FORM_TEXT> BorrowAll(const std::vector<ByteString>& texts) {
  std::vector<DSHPDF_FORM_TEXT> borrowed;
  borrowed.reserve(texts.size());
  for (const auto& text : texts) {
    borrowed.push_back(Borrow(text));
  }
  return borrowed;
}

std::vector<ByteString> ChoiceValues(const CPDF_FormField& field) {
  std::vector<ByteString> values;
  const auto value = field.GetFieldAttr("V");
  if (value && value->IsString() && !value->GetString().IsEmpty()) {
    values.push_back(value->GetUnicodeText().ToUTF8());
  } else if (value && value->IsArray()) {
    const auto* array = value->AsArray();
    for (size_t index = 0; index < array->size(); ++index) {
      const auto selected = array->GetStringAt(index);
      if (selected) {
        values.push_back(selected->GetUnicodeText().ToUTF8());
      }
    }
  }
  // The transport represents choices as printed labels. The PDF stores
  // export values, which can differ from the label displayed on the page.
  for (auto& selected : values) {
    const int index = field.FindOption(WideString::FromUTF8(selected.AsStringView()));
    if (index >= 0) {
      selected = field.GetOptionLabel(index).ToUTF8();
    }
  }
  return values;
}

const CPDF_FormControl* SelectedButton(const CPDF_FormField& field) {
  const auto value = field.GetFieldAttr("V");
  if (!value || !value->IsName() || value->GetString() == "Off") {
    return nullptr;
  }
  const auto state = value->GetString();
  const CPDF_FormControl* named_state = nullptr;
  for (int index = 0; index < field.CountControls(); ++index) {
    const auto* control = field.GetControl(index);
    if (state == control->GetCheckedAPState()) {
      return control;
    }
    if (!named_state && state == control->GetOnStateName()) {
      named_state = control;
    }
  }
  return named_state;
}

void VisitField(const CPDF_FormField& field,
                const WidgetPages& widget_pages,
                DSHPDF_FORM_VISITOR visitor,
                void* context) {
  const auto [object, generation] = GetKey(field);
  const auto kind = GetKind(field);
  const auto flags = field.GetFieldFlags();
  const auto name = field.GetFullName().ToUTF8();
  const auto hint = field.GetFieldAttr("TU");
  auto hint_text = hint && hint->IsString() ? hint->GetUnicodeText() : WideString();
  if (hint_text.GetLength() > 256) {
    // Do not split a supplementary character on 16-bit wchar_t platforms.
    hint_text = hint_text.First(pdfium::IsHighSurrogate(hint_text[255]) ? 255 : 256);
  }
  const auto description = hint_text.ToUTF8();
  const auto* checked = IsButton(kind) ? SelectedButton(field) : nullptr;
  std::vector<ByteString> values;
  std::vector<ByteString> options;
  if (kind == DSHPDF_FORM_TEXT_FIELD) {
    values.push_back(field.GetValue().ToUTF8());
  } else if (IsChoice(kind)) {
    values = ChoiceValues(field);
    for (int index = 0; index < field.CountOptions(); ++index) {
      options.push_back(field.GetOptionLabel(index).ToUTF8());
    }
  } else if (kind == DSHPDF_FORM_RADIO) {
    values.push_back(checked ? checked->GetExportValue().ToUTF8() : ByteString());
    for (int index = 0; index < field.CountControls(); ++index) {
      options.push_back(field.GetControl(index)->GetExportValue().ToUTF8());
    }
  }

  std::vector<DSHPDF_FORM_WIDGET> widgets;
  for (int index = 0; index < field.CountControls(); ++index) {
    const auto* control = field.GetControl(index);
    const auto dictionary = control->GetWidgetDict();
    const uint32_t annotation_flags = dictionary->GetIntegerFor("F");
    if (annotation_flags & (pdfium::annotation_flags::kHidden | pdfium::annotation_flags::kNoView)) {
      continue;
    }
    const auto page = widget_pages.find(dictionary.Get());
    if (page == widget_pages.end()) {
      continue;
    }
    const auto rect = control->GetRect();
    if (!std::isfinite(rect.left) || !std::isfinite(rect.bottom) ||
        !std::isfinite(rect.right) || !std::isfinite(rect.top) ||
        rect.left >= rect.right || rect.bottom >= rect.top) {
      continue;
    }
    widgets.push_back({page->second, rect.left, rect.bottom, rect.right, rect.top,
                       kind == DSHPDF_FORM_RADIO ? Borrow(options[index]) : DSHPDF_FORM_TEXT{}});
  }

  const auto borrowed_values = BorrowAll(values);
  const auto borrowed_options = BorrowAll(options);
  const DSHPDF_FORM_FIELD row{
      object, generation, kind,
      kind == DSHPDF_FORM_UNSUPPORTED || bool(flags & pdfium::form_flags::kReadOnly) ||
          !HasCanonicalControls(field),
      field.IsRequired(),
      kind == DSHPDF_FORM_TEXT_FIELD && bool(flags & pdfium::form_flags::kTextMultiline),
      kind == DSHPDF_FORM_OPTION_LIST && bool(flags & pdfium::form_flags::kChoiceMultiSelect),
      kind == DSHPDF_FORM_TEXT_FIELD ? field.GetMaxLen() : 0,
      Borrow(name), Borrow(description), borrowed_values.data(), borrowed_values.size(),
      borrowed_options.data(), borrowed_options.size(),
      kind == DSHPDF_FORM_CHECKBOX && checked,
      widgets.data(), widgets.size()};
  visitor(context, &row);
}

struct FormSession : FPDF_FORMFILLINFO {
  explicit FormSession(FPDF_DOCUMENT document_handle)
      : FPDF_FORMFILLINFO{}, document(document_handle) {
    version = 2;
    xfa_disabled = true;
    FFI_GetPage = [](FPDF_FORMFILLINFO* info, FPDF_DOCUMENT, int index) -> FPDF_PAGE {
      const auto& loaded = static_cast<FormSession*>(info)->pages;
      const auto found = loaded.find(index);
      return found == loaded.end() ? nullptr : found->second;
    };
    FFI_Invalidate = [](FPDF_FORMFILLINFO*, FPDF_PAGE, double, double, double, double) {};
    handle = FPDFDOC_InitFormFillEnvironment(document, this);
  }

  FormSession(const FormSession&) = delete;
  FormSession& operator=(const FormSession&) = delete;

  ~FormSession() {
    while (!pages.empty()) {
      const auto entry = pages.begin();
      const auto page = entry->second;
      FORM_OnBeforeClosePage(page, handle);
      pages.erase(entry);
      FPDF_ClosePage(page);
    }
    FPDFDOC_ExitFormFillEnvironment(handle);
  }

  bool LoadPage(int index) {
    if (pages.contains(index)) {
      return true;
    }
    const FPDF_PAGE page = FPDF_LoadPage(document, index);
    if (!page) {
      return false;
    }
    pages.emplace(index, page);
    FORM_OnAfterLoadPage(page, handle);
    return true;
  }

  FPDF_DOCUMENT document;
  FPDF_FORMHANDLE handle = nullptr;
  std::map<int, FPDF_PAGE> pages;
};

struct FormEdit {
  CPDF_FormField* field;
  RetainPtr<CPDF_Dictionary> dictionary;
  DSHPDF_FORM_KIND kind;
  std::vector<int> selected_indices;
  std::vector<int> checked_controls;
  WideString text;
};

std::optional<WideString> ReadInput(DSHPDF_FORM_TEXT input) {
  if (input.size > kMaxValueBytes || (!input.data && input.size != 0)) {
    return std::nullopt;
  }
  const ByteString bytes(input.data, input.size);
  auto value = WideString::FromUTF8(bytes.AsStringView());
  return value.ToUTF8() == bytes ? std::optional<WideString>(std::move(value)) : std::nullopt;
}

const char* PrepareEdit(const DSHPDF_FORM_EDIT& input, FormEdit* edit) {
  auto& field = *edit->field;
  const auto kind = edit->kind;
  if ((field.GetFieldFlags() & pdfium::form_flags::kReadOnly) || !HasCanonicalControls(field)) {
    return "The PDF form field is read-only or has ambiguous widgets.";
  }
  if (input.value_count > kMaxEdits || (input.value_count && !input.values)) {
    return "Invalid PDF form value array.";
  }
  if (kind == DSHPDF_FORM_TEXT_FIELD) {
    if (input.value_count != 1) {
      return "The PDF text field requires one string.";
    }
    auto text = ReadInput(input.values[0]);
    if (!text) {
      return "Invalid UTF-8 PDF form text.";
    }
    const auto bytes = text->ToUTF8();
    const auto length = std::count_if(bytes.begin(), bytes.end(), [](unsigned char ch) {
      return (ch & 0xc0) != 0x80;
    });
    const int limit = field.GetMaxLen();
    if (limit > 0 && length > limit) {
      return "The PDF form text exceeds its maximum length.";
    }
    edit->text = std::move(*text);
    return nullptr;
  }
  if (IsChoice(kind)) {
    if (input.value_count > 1 && (kind == DSHPDF_FORM_DROPDOWN ||
        !(field.GetFieldFlags() & pdfium::form_flags::kChoiceMultiSelect))) {
      return "The PDF choice field accepts one option.";
    }
    std::set<int> seen;
    for (size_t index = 0; index < input.value_count; ++index) {
      const auto value = ReadInput(input.values[index]);
      if (!value) {
        return "Invalid UTF-8 PDF form option.";
      }
      int selected = -1;
      for (int option = 0; option < field.CountOptions(); ++option) {
        if (field.GetOptionLabel(option) != *value) {
          continue;
        }
        if (selected >= 0) {
          return "The PDF choice label has multiple export options.";
        }
        selected = option;
      }
      if (selected < 0 || !seen.insert(selected).second) {
        return "The PDF choice value is unavailable or repeated.";
      }
    }
    edit->selected_indices.assign(seen.begin(), seen.end());
    return nullptr;
  }
  if (!IsButton(kind)) {
    return "The PDF form field type is unsupported.";
  }
  std::optional<WideString> value;
  if (kind == DSHPDF_FORM_RADIO && input.value_count == 1) {
    value = ReadInput(input.values[0]);
  }
  if ((kind == DSHPDF_FORM_CHECKBOX && input.value_count != 0) ||
      (kind == DSHPDF_FORM_RADIO && !value)) {
    return "Invalid PDF button value.";
  }
  const bool should_select = kind == DSHPDF_FORM_CHECKBOX ? input.checked : !value->IsEmpty();
  if (!should_select) {
    return nullptr;
  }
  ByteString selected_state;
  for (int index = 0; index < field.CountControls(); ++index) {
    const auto* control = field.GetControl(index);
    if (value && control->GetExportValue() != *value) {
      continue;
    }
    const auto state = control->GetOnStateName();
    if (state.IsEmpty() || (!selected_state.IsEmpty() && state != selected_state)) {
      return "The PDF button has missing or ambiguous appearance states.";
    }
    selected_state = state;
    edit->checked_controls.push_back(index);
  }
  if (edit->checked_controls.empty()) {
    return "The PDF button has no matching control.";
  }
  if (edit->checked_controls.size() > 1 &&
      ((kind == DSHPDF_FORM_RADIO &&
        !(field.GetFieldFlags() & pdfium::form_flags::kButtonRadiosInUnison)) ||
       (field.GetFieldAttr("Opt") && field.GetFieldAttr("Opt")->IsArray()))) {
    return "The PDF button selection refers to multiple independent controls.";
  }
  return nullptr;
}

bool CollectCharacters(const WideString& text, std::set<uint32_t>& characters) {
  size_t index = 0;
  while (index < text.GetLength()) {
    const auto scalar = CPDF_BAFontMap::DshNextFormScalar(text.AsStringView(), index);
    if (scalar > pdfium::kMaximumSupplementaryCodePoint ||
        pdfium::IsHighSurrogate(scalar) || pdfium::IsLowSurrogate(scalar)) {
      return false;
    }
    if (scalar > 0x7e) characters.insert(scalar);
  }
  return true;
}

bool CollectAppearanceCharacters(const FormEdit& edit, std::set<uint32_t>& characters) {
  const auto& field = *edit.field;
  if (!field.CountControls() || IsButton(edit.kind)) return true;
  if (edit.kind == DSHPDF_FORM_TEXT_FIELD) {
    return (field.GetFieldFlags() & pdfium::form_flags::kTextPassword) ||
        CollectCharacters(edit.text, characters);
  }
  if (edit.kind == DSHPDF_FORM_OPTION_LIST) {
    for (int index = 0; index < field.CountOptions(); ++index) {
      if (!CollectCharacters(field.GetOptionLabel(index), characters)) return false;
    }
  } else if (!edit.selected_indices.empty()) {
    return CollectCharacters(field.GetOptionLabel(edit.selected_indices.front()), characters);
  }
  return true;
}

void WriteEdit(FormEdit& edit) {
  auto& field = *edit.field;
  if (edit.kind == DSHPDF_FORM_TEXT_FIELD) {
    field.SetValue(edit.text, kSilent);
    return;
  }
  if (IsChoice(edit.kind)) {
    field.ClearSelection(kSilent);
    for (const int index : edit.selected_indices) {
      field.SetItemSelection(index, kSilent);
    }
    if (edit.selected_indices.empty()) {
      // Explicitly clear the field, even when /DV or inherited /V exists.
      edit.dictionary->SetNewFor<CPDF_Array>("V");
      edit.dictionary->SetNewFor<CPDF_Array>("I");
    }
    return;
  }
  for (int index = 0; index < field.CountControls(); ++index) {
    field.GetControl(index)->CheckControl(std::binary_search(
        edit.checked_controls.begin(), edit.checked_controls.end(), index));
  }
  const ByteString state = edit.checked_controls.empty()
      ? ByteString("Off")
      : field.GetControl(edit.checked_controls.front())->GetCheckedAPState();
  edit.dictionary->SetNewFor<CPDF_Name>("V", state);
}

}  // namespace

FPDF_EXPORT const char* FPDF_CALLCONV
DSHPDF_VisitFormFields(FPDF_DOCUMENT document,
                     DSHPDF_FORM_VISITOR visitor,
                     void* context) {
  auto* pdf = CPDFDocumentFromFPDFDocument(document);
  if (!pdf || !visitor) {
    return "Invalid PDF form visitor.";
  }
  CPDF_InteractiveForm form(pdf, /*distinct_fields=*/true);
  std::set<const CPDF_Dictionary*> widgets;
  const size_t count = form.CountFields(WideString());
  for (size_t index = 0; index < count; ++index) {
    const auto* field = form.GetField(index, WideString());
    if (!field || field->GetFieldDict()->IsInline()) {
      return "The PDF form contains a field without a stable object identity.";
    }
    for (int control = 0; control < field->CountControls(); ++control) {
      widgets.insert(field->GetControl(control)->GetWidgetDict().Get());
    }
  }
  const auto pages = FindWidgetPages(pdf, widgets);
  for (size_t index = 0; index < count; ++index) {
    VisitField(*form.GetField(index, WideString()), pages, visitor, context);
  }
  return nullptr;
}

FPDF_EXPORT const char* FPDF_CALLCONV
DSHPDF_ApplyFormFields(FPDF_DOCUMENT document,
                     const DSHPDF_FORM_EDIT* edits,
                     size_t count,
                     const uint8_t* font_data,
                     size_t font_size) {
  auto* pdf = CPDFDocumentFromFPDFDocument(document);
  if (!pdf || count > kMaxEdits || (count && !edits) || (font_size && !font_data)) {
    return "Invalid PDF form edits.";
  }
  if (!count) {
    return nullptr;
  }
  FormSession session(document);
  if (!session.handle) {
    return "The PDF form editing environment could not initialize.";
  }
  auto* interactive = CPDFSDKFormFillEnvironmentFromFPDFFormHandle(session.handle)->GetInteractiveForm(
      /*distinct_fields=*/true);
  auto* form = interactive->GetInteractiveForm();
  std::map<FieldKey, CPDF_FormField*> fields;
  for (size_t index = 0; index < form->CountFields(WideString()); ++index) {
    auto* field = form->GetField(index, WideString());
    if (field) {
      fields.emplace(GetKey(*field), field);
    }
  }

  std::vector<FormEdit> prepared;
  std::set<const CPDF_Dictionary*> appearance_widgets;
  for (size_t index = 0; index < count; ++index) {
    const auto& input = edits[index];
    const auto found = fields.find({input.object_number, input.generation});
    if (found == fields.end() || GetKind(*found->second) != input.kind) {
      return "The PDF form field identity or type has changed.";
    }
    auto* field = found->second;
    auto object = pdf->GetOrParseIndirectObject(input.object_number);
    auto dictionary = object ? object->GetMutableDict() : nullptr;
    if (!dictionary || field->GetFieldDict() != dictionary) {
      return "The PDF form field has no stable object identity.";
    }
    FormEdit edit{field, std::move(dictionary), input.kind, {}, {}, {}};
    if (const char* error = PrepareEdit(input, &edit)) {
      return error;
    }
    if (!IsButton(edit.kind)) {
      for (int control = 0; control < field->CountControls(); ++control) {
        appearance_widgets.insert(field->GetControl(control)->GetWidgetDict().Get());
      }
    }
    prepared.push_back(std::move(edit));
  }

  const auto pages = FindWidgetPages(pdf, appearance_widgets);
  for (const auto& [widget, page] : pages) {
    if (!session.LoadPage(page)) {
      return "A PDF form widget page could not be opened for appearance updates.";
    }
  }
  for (const auto& widget : appearance_widgets) {
    auto* control = form->GetControlByDict(widget);
    if (!pages.contains(widget) || !interactive->GetWidget(control)) {
      return "A PDF form widget could not be opened for appearance updates.";
    }
  }

  std::map<CPDF_FormField*, const FormEdit*> final_edits;
  for (const auto& edit : prepared) final_edits[edit.field] = &edit;
  std::set<uint32_t> characters;
  for (const auto& entry : final_edits) {
    if (!CollectAppearanceCharacters(*entry.second, characters)) {
      return "The PDF widget text contains unsupported Unicode characters.";
    }
  }
  ScopedDshFormFont appearance_font;
  // SAFETY: The native caller supplies the font bytes and length together.
  if (!appearance_font.Initialize(pdf, UNSAFE_BUFFERS(pdfium::span(font_data, font_size)), characters)) {
    return "The bundled PDF form font does not cover the widget text.";
  }

  std::set<CPDF_FormField*> changed;
  for (auto& edit : prepared) {
    WriteEdit(edit);
    if (!IsButton(edit.kind)) {
      changed.insert(edit.field);
    }
  }
  for (auto* field : changed) {
    interactive->ResetFieldAppearance(field, std::nullopt);
    for (int index = 0; index < field->CountControls(); ++index) {
      const auto widget = field->GetControl(index)->GetWidgetDict();
      const auto appearance = widget->GetDictFor("AP");
      if (!appearance || !appearance->GetStreamFor("N")) {
        return "A PDF form widget appearance could not be generated.";
      }
    }
  }
  return nullptr;
}
