#pragma once

#include "dsh_forms.h"

namespace pdf_engine {

constexpr size_t max_form_fields = 5000;

inline std::string form_text(DSHPDF_FORM_TEXT value) {
  return value.size ? std::string(value.data, value.size) : std::string();
}

inline const char* form_kind(DSHPDF_FORM_KIND kind) {
  switch (kind) {
    case DSHPDF_FORM_TEXT_FIELD: return "text";
    case DSHPDF_FORM_CHECKBOX: return "checkbox";
    case DSHPDF_FORM_RADIO: return "radio";
    case DSHPDF_FORM_DROPDOWN: return "dropdown";
    case DSHPDF_FORM_OPTION_LIST: return "option-list";
    default: return "unsupported";
  }
}

inline DSHPDF_FORM_KIND form_kind(std::string_view kind) {
  if (kind == "text") return DSHPDF_FORM_TEXT_FIELD;
  if (kind == "checkbox") return DSHPDF_FORM_CHECKBOX;
  if (kind == "radio") return DSHPDF_FORM_RADIO;
  if (kind == "dropdown") return DSHPDF_FORM_DROPDOWN;
  if (kind == "option-list") return DSHPDF_FORM_OPTION_LIST;
  throw Failure("pdf/native-request", "Invalid native form field type");
}

inline json form_strings(const DSHPDF_FORM_TEXT* values, size_t count) {
  auto result = json::array();
  for (size_t index = 0; index < count; ++index) result.push_back(form_text(values[index]));
  return result;
}

inline json document_forms(FPDF_DOCUMENT document, size_t offset, size_t limit) {
  struct Visitor {
    size_t offset;
    size_t limit;
    json fields = json::array();
    size_t seen = 0;
    size_t bytes = 32;
    bool full = false;
  } state{offset, limit};
  const auto* error = DSHPDF_VisitFormFields(document,
    [](void* context, const DSHPDF_FORM_FIELD* field) {
      auto& result = *static_cast<Visitor*>(context);
      if (result.seen++ < result.offset || result.full || result.fields.size() == result.limit) return;
      const auto kind = field->kind;
      json widgets = json::array();
      for (size_t index = 0; index < field->widget_count; ++index) {
        const auto& widget = field->widgets[index];
        json row{{"page", widget.page_index + 1},
          {"rect", {widget.left, widget.bottom, widget.right, widget.top}}};
        if (kind == DSHPDF_FORM_RADIO) row["option"] = form_text(widget.radio_option);
        widgets.push_back(std::move(row));
      }
      json row{{"objectNumber", field->object_number}, {"generation", field->generation},
        {"type", form_kind(kind)}, {"name", form_text(field->name)},
        {"readOnly", bool(field->read_only)}, {"required", bool(field->required)},
        {"widgets", std::move(widgets)}};
      if (field->description.size) row["description"] = form_text(field->description);
      switch (kind) {
        case DSHPDF_FORM_TEXT_FIELD:
          row["multiline"] = bool(field->multiline);
          if (field->max_length > 0) row["maxLength"] = field->max_length;
          row["value"] = field->value_count ? form_text(field->values[0]) : std::string();
          break;
        case DSHPDF_FORM_RADIO:
          row["options"] = form_strings(field->options, field->option_count);
          row["value"] = field->value_count ? form_text(field->values[0]) : std::string();
          break;
        case DSHPDF_FORM_DROPDOWN:
        case DSHPDF_FORM_OPTION_LIST:
          if (kind == DSHPDF_FORM_OPTION_LIST) row["multiple"] = bool(field->multiple);
          row["options"] = form_strings(field->options, field->option_count);
          row["value"] = form_strings(field->values, field->value_count);
          break;
        case DSHPDF_FORM_CHECKBOX:
          row["value"] = bool(field->checked);
          break;
        default:
          row["value"] = "";
      }
      result.bytes += row.dump().size() + 1;
      if (result.bytes > max_json / 2) { result.full = true; return; }
      result.fields.push_back(std::move(row));
    }, &state);
  if (error || offset > state.seen || (state.full && state.fields.empty())) {
    throw Failure("pdf/native-form", error ? error : "Form exceeds the native response limit");
  }
  const auto end = offset + state.fields.size();
  return {{"fields", std::move(state.fields)}, {"nextOffset", end < state.seen ? json(end) : json(nullptr)}};
}

inline uint32_t form_identity(const json& edit, const char* key, uint32_t minimum) {
  require(edit.contains(key) && edit[key].is_number_integer(), "Native form identity is required");
  const int64_t identity = edit[key].get<int64_t>();
  require(identity >= minimum && identity < UINT32_MAX, "Invalid native form identity");
  return static_cast<uint32_t>(identity);
}

inline void apply_forms(FPDF_DOCUMENT document, const json& entries, const std::vector<unsigned char>& font) {
  require(entries.is_array() && entries.size() <= max_form_fields, "Invalid native form edit array");
  std::vector<std::vector<DSHPDF_FORM_TEXT>> values;
  std::vector<DSHPDF_FORM_EDIT> edits;
  values.reserve(entries.size());
  edits.reserve(entries.size());
  for (const auto& entry : entries) {
    const auto kind = form_kind(entry.at("type").get_ref<const std::string&>());
    const auto& value = entry.at("value");
    auto& strings = values.emplace_back();
    const auto add = [&strings](const json& item) {
      const auto& str = item.get_ref<const std::string&>();
      strings.push_back({str.data(), str.size()});
    };
    bool checked = false;
    if (kind == DSHPDF_FORM_CHECKBOX) {
      require(value.is_boolean(), "Native checkbox edit requires a boolean");
      checked = value.get<bool>();
    } else if (kind == DSHPDF_FORM_DROPDOWN || kind == DSHPDF_FORM_OPTION_LIST) {
      require(value.is_array() && value.size() <= max_form_fields, "Native choice edit requires an array");
      for (const auto& item : value) add(item);
    } else {
      add(value);
    }
    edits.push_back({form_identity(entry, "objectNumber", 1), form_identity(entry, "generation", 0),
      kind, strings.data(), strings.size(), checked});
  }
  if (const auto* error = DSHPDF_ApplyFormFields(document, edits.data(), edits.size(), font.data(), font.size())) {
    throw Failure("pdf/native-form", error);
  }
}

}  // namespace pdf_engine
