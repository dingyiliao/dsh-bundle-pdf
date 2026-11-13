import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function applyFormFontPatch(checkout, replaceOnce, register) {
  // PDFium uses the same HarfBuzz subsetter for TrueType. Enable its CFF
  // implementation for the bundled CID-keyed Noto OpenType font.
  await replaceOnce('third_party/harfbuzz/BUILD.gn', '      "HB_NO_SUBSET_CFF",\n',
    '      # DSH enables CFF subsetting for portable form appearances.\n')
  await replaceOnce('third_party/harfbuzz/BUILD.gn', '      defines -= [ "HB_NO_SUBSET_CFF" ]\n',
    '      # CFF subsetting is already enabled for DSH form appearances.\n')
  await register('fpdfsdk/BUILD.gn', '    "../core/fdrm",', ['    "//third_party/harfbuzz",'])
  await register('fpdfsdk/BUILD.gn', '    "fpdf_annot.cpp",', ['    "dsh_form_font.cc",', '    "dsh_form_font.h",'])

  for (const name of ['dsh_form_font.cc', 'dsh_form_font.h']) {
    await copyFile(new URL(`./form-font/${name}`, import.meta.url), join(checkout, 'fpdfsdk', name))
  }

  // Raw CIDFontType0C streams retain CFF character IDs when HarfBuzz remaps
  // glyph indices. Expose the FreeType distinction through the PDFium face.
  await register('third_party/BUILD.gn', '      "//third_party/freetype/src/src/base/ftbitmap.c",',
    ['      "//third_party/freetype/src/src/base/ftcid.c",'])
  await replaceOnce('core/fxge/cfx_face.h', '  int GetCharIndex(uint32_t code);',
    '  int GetCharIndex(uint32_t code);\n  std::optional<uint16_t> GetDshCharacterId(uint32_t glyph_index);')
  await replaceOnce('core/fxge/cfx_face.cpp', '#include "core/fxge/cfx_face.h"',
    '#include "core/fxge/cfx_face.h"\n\n#include FT_CID_H')
  await replaceOnce('core/fxge/cfx_face.cpp', 'int CFX_Face::GetCharIndex(uint32_t code) {',
    `std::optional<uint16_t> CFX_Face::GetDshCharacterId(uint32_t glyph_index) {
  unsigned int cid = 0;
  if (!GetRec() || FT_Get_CID_From_Glyph_Index(GetRec(), glyph_index, &cid) || cid > 65535) {
    return std::nullopt;
  }
  return static_cast<uint16_t>(cid);
}

int CFX_Face::GetCharIndex(uint32_t code) {`)

  // The native worker handles one request at a time. Scope the font to its
  // isolated editing document and reuse PDFium's widget layout and AP writer.
  await replaceOnce('core/fpdfdoc/cpdf_bafontmap.h', '  static FX_Charset GetNativeCharset();',
    `  static FX_Charset GetNativeCharset();
  static void SetDshFormFont(CPDF_Document* document, CPDF_Font* font,
                             const std::vector<uint32_t>* supplementary);
  static uint32_t DshNextFormScalar(WideStringView text, size_t& index);
  WideString DshLayoutText(const WideString& text) const;`)
  await replaceOnce('core/fpdfdoc/cpdf_bafontmap.cpp', '#include <memory>', '#include <algorithm>\n#include <memory>')
  await replaceOnce('core/fpdfdoc/cpdf_bafontmap.cpp', '#include "core/fxcrt/stl_util.h"',
    '#include "core/fxcrt/stl_util.h"\n#include "core/fxcrt/utf16.h"')
  await replaceOnce('core/fpdfdoc/cpdf_bafontmap.cpp', 'namespace {\n\nbool FindNativeTrueTypeFont',
    `namespace {

thread_local CPDF_Document* dsh_font_document = nullptr;
thread_local CPDF_Font* dsh_form_font = nullptr;
thread_local const std::vector<uint32_t>* dsh_form_supplementary = nullptr;

uint32_t GetDshFormCode(uint16_t word) {
  if (pdfium::IsHighSurrogate(word) || pdfium::IsLowSurrogate(word)) {
    const auto index = static_cast<size_t>(word - pdfium::kMinimumHighSurrogateCodeUnit);
    return dsh_form_supplementary && index < dsh_form_supplementary->size() ? word : 0;
  }
  return dsh_form_font->CharCodeFromUnicode(word);
}

bool FindNativeTrueTypeFont`)
  await replaceOnce('core/fpdfdoc/cpdf_bafontmap.cpp', 'CPDF_BAFontMap::Data::Data() = default;',
    `void CPDF_BAFontMap::SetDshFormFont(CPDF_Document* document, CPDF_Font* font,
                                     const std::vector<uint32_t>* supplementary) {
  dsh_font_document = document;
  dsh_form_font = font;
  dsh_form_supplementary = supplementary;
}

uint32_t CPDF_BAFontMap::DshNextFormScalar(WideStringView text, size_t& index) {
  const auto first = static_cast<uint32_t>(text[index++]);
  if (pdfium::IsHighSurrogate(first) && index < text.GetLength() &&
      pdfium::IsLowSurrogate(text[index])) {
    return pdfium::SurrogatePair(static_cast<char16_t>(first),
                                static_cast<char16_t>(text[index++])).ToCodePoint();
  }
  return first;
}

WideString CPDF_BAFontMap::DshLayoutText(const WideString& text) const {
  if (dsh_font_document != document_.get()) {
    return text;
  }
  const auto& characters = *dsh_form_supplementary;
  const auto view = text.AsStringView();
  WideString result;
  size_t index = 0;
  size_t pending = 0;
  while (index < view.GetLength()) {
    const size_t start = index;
    const uint32_t scalar = DshNextFormScalar(view, index);
    wchar_t replacement = 0;
    if (scalar == '\\f') {
      replacement = L'\\n';
    } else if (pdfium::IsSupplementary(scalar)) {
      const auto character = std::ranges::lower_bound(characters, scalar);
      if (character == characters.end() || *character != scalar) continue;
      replacement = static_cast<wchar_t>(pdfium::kMinimumHighSurrogateCodeUnit +
                                         (character - characters.begin()));
    } else if (scalar != '\\b' && scalar != '\\v') {
      continue;
    }
    // Nonprinting controls are kept in /V and omitted from the appearance.
    result += view.Substr(pending, start - pending);
    if (replacement) result += replacement;
    pending = index;
  }
  if (!pending) return text;
  result += view.Substr(pending);
  return result;
}

CPDF_BAFontMap::Data::Data() = default;`)
  await replaceOnce('core/fpdfdoc/cpdf_bafontmap.cpp', '  if (nFontIndex > 0) {\n    if (KnowWord(nFontIndex, word)) {',
    `  if (word > 0x7e && dsh_font_document == document_.get() && dsh_form_font &&
      GetDshFormCode(word) != 0) {
    for (size_t index = 0; index < data_.size(); ++index) {
      if (data_[index]->font.Get() == dsh_form_font) {
        return static_cast<int32_t>(index);
      }
    }
    const auto font = pdfium::WrapRetain(dsh_form_font);
    ByteString alias = ByteString::Format("DSHUnicode%u", font->GetFontDictObjNum());
    if (const auto ap = annot_dict_->GetDictFor(pdfium::annotation::kAP)) {
      if (const auto stream = ap->GetStreamFor(ap_type_.AsStringView())) {
        if (const auto resources = stream->GetDict()->GetDictFor("Resources")) {
          if (const auto fonts = resources->GetDictFor("Font")) {
            while (fonts->KeyExist(alias.AsStringView())) {
              alias += "_";
            }
          }
        }
      }
    }
    AddFontToAnnotDict(font, alias);
    return AddFontData(font, alias, FX_Charset::kDefault);
  }
  if (nFontIndex > 0) {
    if (KnowWord(nFontIndex, word)) {`)
  await replaceOnce('core/fpdfdoc/cpdf_bafontmap.cpp', '  if (pData->font->IsUnicodeCompatible()) {',
    `  if (pData->font.Get() == dsh_form_font) {
    const uint32_t code = GetDshFormCode(word);
    return code ? static_cast<int32_t>(code) : -1;
  }

  if (pData->font->IsUnicodeCompatible()) {`)

  // Keep the supplementary slots local to the saved appearance. The real
  // field value stays Unicode, and /ToUnicode maps the slots back to it.
  for (const expression of ['sValue.value()', 'pField->GetValue()', 'pField->GetOptionLabel(nCurSel)',
    'pField->GetOptionLabel(i)', 'sValue.value_or(pField->GetValue())']) {
    await replaceOnce('fpdfsdk/cpdfsdk_appstream.cpp', `pEdit->SetText(${expression});`,
      `pEdit->SetText(font_map.DshLayoutText(${expression}));`)
  }
}
