#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <optional>
#include <string>
#include "fpdf_text.h"
#include "fpdfview.h"
#include "json.hpp"

namespace pdf_engine {

constexpr int max_selection_characters = 200000;
constexpr int max_selection_chunk = 2048;

inline bool high_surrogate(uint32_t value) { return value >= 0xd800 && value <= 0xdbff; }
inline bool low_surrogate(uint32_t value) { return value >= 0xdc00 && value <= 0xdfff; }
inline bool line_break(uint32_t value) { return value == '\r' || value == '\n'; }

inline bool joined_characters(uint32_t first, uint32_t second) {
  return (first == '\r' && second == '\n') || (high_surrogate(first) && low_surrogate(second));
}

struct SelectionTextPage {
  FPDF_PAGE page;
  FPDF_TEXTPAGE text;
  int count;
  int cursor = 0;
  int line = 0;

  explicit SelectionTextPage(FPDF_PAGE source)
    : page(source), text(FPDFText_LoadPage(source)), count(text ? FPDFText_CountChars(text) : -1) {}
  SelectionTextPage(const SelectionTextPage&) = delete;
  SelectionTextPage& operator=(const SelectionTextPage&) = delete;
  ~SelectionTextPage() { if (text) FPDFText_ClosePage(text); }

  bool is_boundary(int offset) const {
    return offset == 0 || offset == count
      || !joined_characters(FPDFText_GetUnicode(text, offset - 1), FPDFText_GetUnicode(text, offset));
  }

  int line_at(int offset) const {
    if (offset == cursor) return line;
    for (int i = offset; i > 0; --i) if (line_break(FPDFText_GetUnicode(text, i - 1))) return i;
    return 0;
  }
};

struct TextBox {
  double left, bottom, right, top;

  bool valid() const {
    return std::isfinite(left) && std::isfinite(bottom) && std::isfinite(right) && std::isfinite(top)
      && left < right && bottom < top;
  }

  TextBox united_with(const TextBox& other) const {
    return {std::min(left, other.left), std::min(bottom, other.bottom),
      std::max(right, other.right), std::max(top, other.top)};
  }

  TextBox intersected_with(const TextBox& other) const {
    return {std::max(left, other.left), std::max(bottom, other.bottom),
      std::min(right, other.right), std::min(top, other.top)};
  }
};

inline TextBox as_text_box(const FS_RECTF& rect) { return {rect.left, rect.bottom, rect.right, rect.top}; }

inline std::optional<TextBox> character_box(FPDF_TEXTPAGE text, int index) {
  // PDFium's loose bounds already contain the tight bounds and fall back to
  // them when font metrics are missing.
  FS_RECTF loose{};
  if (!FPDFText_GetLooseCharBox(text, index, &loose)) return std::nullopt;
  const auto bounds = as_text_box(loose);
  return bounds.valid() ? std::optional{bounds} : std::nullopt;
}

inline std::optional<std::array<double, 2>> axis(double x, double y) {
  const double length = std::hypot(x, y);
  if (!std::isfinite(length) || length == 0) return std::nullopt;
  constexpr double tolerance = 1e-6;
  if (std::abs(y) <= tolerance * length) return std::array<double, 2>{std::copysign(1., x), 0.};
  if (std::abs(x) <= tolerance * length) return std::array<double, 2>{0., std::copysign(1., y)};
  return std::nullopt;
}

inline nlohmann::json character_quad(FPDF_TEXTPAGE text, int index, const TextBox& box) {
  // Public PDFium boxes are axis-aligned. Recover corner order for straight
  // and quarter-turn text; arbitrary rotations and shears need more data.
  FS_MATRIX matrix{};
  if (!FPDFText_GetMatrix(text, index, &matrix)) return nullptr;
  const auto horizontal = axis(matrix.a, matrix.b), vertical = axis(matrix.c, matrix.d);
  if (!horizontal || !vertical) return nullptr;
  const auto [ux, uy] = *horizontal;
  const auto [vx, vy] = *vertical;
  if (ux * vx + uy * vy != 0) return nullptr;
  const auto [u_min, u_max] = std::minmax({ux * box.left + uy * box.bottom, ux * box.right + uy * box.top});
  const auto [v_min, v_max] = std::minmax({vx * box.left + vy * box.bottom, vx * box.right + vy * box.top});
  return std::array<double, 8>{
    ux * u_min + vx * v_max, uy * u_min + vy * v_max,
    ux * u_max + vx * v_max, uy * u_max + vy * v_max,
    ux * u_min + vx * v_min, uy * u_min + vy * v_min,
    ux * u_max + vx * v_min, uy * u_max + vy * v_min,
  };
}

inline nlohmann::json selection_geometry(SelectionTextPage& source, int offset, int limit,
    std::string (*encode_scalar)(uint32_t)) {
  using nlohmann::json;
  auto glyphs = json::array();
  const auto text = source.text;
  int line = source.line_at(offset);
  int unmapped = 0;
  FS_RECTF page_bounds{};
  const bool has_page_bounds = FPDF_GetPageBoundingBox(source.page, &page_bounds) && as_text_box(page_bounds).valid();
  const auto crop = as_text_box(page_bounds);
  const int stop = std::min(source.count, offset + limit);
  int index = offset;
  while (index < stop) {
    const int start = index++;
    uint32_t scalar = FPDFText_GetUnicode(text, start);
    const auto next = index < source.count ? FPDFText_GetUnicode(text, index) : 0;
    if (joined_characters(scalar, next)) {
      if (high_surrogate(scalar)) scalar = 0x10000 + ((scalar - 0xd800) << 10) + (next - 0xdc00);
      index++;
    }
    if (line_break(scalar)) {
      glyphs.push_back({{"index", start}, {"end", index}, {"text", "\n"}, {"line", line}, {"quad", nullptr}});
      line = index;
      continue;
    }
    if (scalar == 0x0002 && FPDFText_IsHyphen(text, start) == 1) continue;
    const bool generated = FPDFText_IsGenerated(text, start) == 1;
    if (generated && scalar < 32) continue;
    auto bounds = generated ? std::nullopt : character_box(text, start);
    if (bounds && index - start == 2) {
      const auto second = character_box(text, index - 1);
      if (second) bounds = bounds->united_with(*second);
    }
    if (bounds && has_page_bounds) {
      bounds = bounds->intersected_with(crop);
      if (!bounds->valid()) continue;  // An invisible glyph cannot become a selectable or copied character.
    }
    const bool bad_mapping = !generated && (scalar < 32 || scalar == 0xfffd || scalar > 0x10ffff
      || high_surrogate(scalar) || low_surrogate(scalar) || FPDFText_HasUnicodeMapError(text, start) == 1);
    if (bad_mapping) { ++unmapped; scalar = 0xfffd; }
    glyphs.push_back({{"index", start}, {"end", index}, {"text", encode_scalar(scalar)}, {"line", line},
      {"quad", bounds ? character_quad(text, start, *bounds) : json(nullptr)}});
  }
  source.cursor = index;
  source.line = line;
  return {{"offset", offset}, {"charCount", source.count}, {"nextOffset", index < source.count ? json(index) : json(nullptr)},
    {"unmapped", unmapped}, {"glyphs", std::move(glyphs)}};
}

}  // namespace pdf_engine
