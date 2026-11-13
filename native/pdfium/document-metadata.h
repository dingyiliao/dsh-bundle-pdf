#pragma once

#include "fpdf_signature.h"

#include "dsh_metadata.h"
#include "dsh_outlines.h"

namespace pdf_engine {

class DocumentMetadata {
 public:
  int signature_status(FPDF_DOCUMENT document) {
    if (!signature_status_) {
      signature_status_ = FPDF_DSH_GetSignatureStatus(document);
    }
    return *signature_status_;
  }

  void clear_fingerprints() {
    fingerprint_.reset();
    fingerprint_initialized_ = false;
  }

  json fingerprints(FPDF_DOCUMENT document, int start, int end) {
    if (!fingerprint_initialized_) {
      fingerprint_.reset(FPDF_DSH_CreateContentFingerprint(document));
      fingerprint_initialized_ = true;
    }
    json result = json::array();
    for (int index = start; index < end; ++index) {
      std::array<unsigned char, 32> digest{};
      if (!fingerprint_ || !FPDF_DSH_GetPageFingerprint(fingerprint_.get(), index, digest.data())) {
        result.push_back(nullptr);
        continue;
      }
      constexpr std::string_view digits = "0123456789abcdef";
      std::string encoded = "sha256:";
      encoded.reserve(71);
      for (const auto byte : digest) {
        encoded.push_back(digits[byte >> 4]);
        encoded.push_back(digits[byte & 15]);
      }
      result.push_back(std::move(encoded));
    }
    return result;
  }

 private:
  std::optional<int> signature_status_;
  bool fingerprint_initialized_ = false;
  std::unique_ptr<std::remove_pointer_t<FPDF_DSH_CONTENT_FINGERPRINT>,
    decltype(&FPDF_DSH_CloseContentFingerprint)> fingerprint_{nullptr, FPDF_DSH_CloseContentFingerprint};
};

inline std::optional<json> page_geometry(FPDF_DOCUMENT document, int index) {
  FPDF_DSH_PAGE_GEOMETRY geometry{};
  if (!FPDF_DSH_GetPageGeometry(document, index, &geometry)) return std::nullopt;
  const auto rect = [](FS_RECTF value) {
    return json::array({value.left, value.bottom, value.right, value.top});
  };
  const auto& media = geometry.media_box;
  const auto& crop = geometry.crop_box;
  // Same clipping and rotation as CPDF_Page::UpdateDimensions in the pinned
  // engine. Reading a page dictionary avoids parsing its drawing program.
  const FS_RECTF visible{
    std::max(media.left, crop.left), std::min(media.top, crop.top),
    std::min(media.right, crop.right), std::max(media.bottom, crop.bottom),
  };
  const float width = visible.right - visible.left;
  const float height = visible.top - visible.bottom;
  if (!std::isfinite(width) || !std::isfinite(height) || width <= 0 || height <= 0) return std::nullopt;
  const bool quarter_turn = geometry.rotation % 180 != 0;
  return json{{"page", index + 1}, {"mediaBox", rect(media)}, {"cropBox", rect(crop)},
    {"visibleBox", rect(visible)}, {"boxSource", "page-dictionary"}, {"rotation", geometry.rotation},
    {"renderedWidth", quarter_turn ? height : width}, {"renderedHeight", quarter_turn ? width : height},
    {"userUnit", geometry.user_unit}};
}

inline json document_outlines(FPDF_DOCUMENT document) {
  struct Visitor {
    json entries = json::array();
    bool complete = true;
    size_t size = 0;
  } state;
  const auto error = DSHPDF_VisitOutlines(document,
    [](void* context, const char* id, const char* title, size_t length, int parent, int page) {
      auto& result = *static_cast<Visitor*>(context);
      if (result.size + length + 100 > max_json / 2) { result.complete = false; return; }
      result.size += length + 100;
      result.entries.push_back({{"id", id}, {"title", std::string(title, length)},
        {"parentIndex", parent}, {"pageIndex", page}});
    }, &state);
  if (error || !state.complete) return {{"readOnlyReason", error ? error : "Outline exceeds the native response limit"}};
  return {{"entries", std::move(state.entries)}};
}

inline void apply_outlines(FPDF_DOCUMENT document, const json& entries) {
  require(entries.is_array() && entries.size() <= 20'000, "Invalid native outline edit");
  std::vector<DSHPDF_OUTLINE_EDIT> rows;
  rows.reserve(entries.size());
  for (const auto& entry : entries) {
    const auto& id = entry.at("id").get_ref<const std::string&>();
    const auto* title = entry.contains("title") ? &entry.at("title").get_ref<const std::string&>() : nullptr;
    require(!id.empty() && id.size() <= 512 && id.find('\0') == std::string::npos
      && (!title || title->find('\0') == std::string::npos), "Invalid native outline text");
    rows.push_back({id.c_str(), integer(entry, "parentIndex", -1, static_cast<int>(rows.size()) - 1),
      title ? title->c_str() : nullptr, integer(entry, "pageIndex", -1, 99'999)});
  }
  if (const auto* error = DSHPDF_ApplyOutlines(document, rows.data(), rows.size())) {
    throw Failure("pdf/native-outline", error);
  }
}

}  // namespace pdf_engine
