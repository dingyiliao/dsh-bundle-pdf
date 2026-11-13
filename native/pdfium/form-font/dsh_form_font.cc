#include "fpdfsdk/dsh_form_font.h"

#include <algorithm>
#include <array>
#include <memory>
#include <vector>

#include "core/fpdfapi/font/cpdf_font.h"
#include "core/fpdfapi/page/cpdf_docpagedata.h"
#include "core/fpdfapi/parser/cpdf_array.h"
#include "core/fpdfapi/parser/cpdf_dictionary.h"
#include "core/fpdfapi/parser/cpdf_document.h"
#include "core/fpdfapi/parser/cpdf_name.h"
#include "core/fpdfapi/parser/cpdf_number.h"
#include "core/fpdfapi/parser/cpdf_reference.h"
#include "core/fpdfapi/parser/cpdf_stream.h"
#include "core/fpdfapi/parser/cpdf_string.h"
#include "core/fpdfdoc/cpdf_bafontmap.h"
#include "core/fxcrt/compiler_specific.h"
#include "core/fxcrt/numerics/safe_conversions.h"
#include "core/fxcrt/utf16.h"
#include "core/fxge/cfx_face.h"
#include "core/fxge/cfx_font.h"
#include "third_party/harfbuzz/src/src/hb-ot.h"
#include "third_party/harfbuzz/src/src/hb-subset.h"
#include "third_party/harfbuzz/src/src/hb.h"

namespace {

constexpr size_t kMaxFontSize = 32 * 1024 * 1024;
constexpr size_t kCMapBatchSize = 100;

template <typename T, void (*Destroy)(T*)>
using HbHandle = std::unique_ptr<T, decltype(Destroy)>;

struct Character {
  uint32_t unicode;
  uint16_t code;
  uint16_t cid;
  int width;
};

ByteString MakeCMap(const std::vector<Character>& characters, bool unicode) {
  ByteString stream = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n";
  stream += unicode
      ? "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n"
        "/CMapName /DSHFormUnicode def\n/CMapType 2 def\n"
      : "/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> def\n"
        "/CMapName /DSHFormEncoding def\n/CMapType 1 def\n";
  stream += "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n";
  for (size_t start = 0; start < characters.size(); start += kCMapBatchSize) {
    const size_t count = std::min(kCMapBatchSize, characters.size() - start);
    stream += ByteString::Format("%zu begin%schar\n", count, unicode ? "bf" : "cid");
    for (size_t index = start; index < start + count; ++index) {
      const auto& character = characters[index];
      // Each scalar gets a different character code, even when the font
      // uses one glyph for two distinct Unicode characters.
      const auto code = static_cast<unsigned>(character.code);
      if (!unicode) {
        stream += ByteString::Format("<%04X> %u\n", code, static_cast<unsigned>(character.cid));
      } else if (pdfium::IsSupplementary(character.unicode)) {
        const pdfium::SurrogatePair pair(character.unicode);
        stream += ByteString::Format("<%04X> <%04X%04X>\n", code,
            static_cast<unsigned>(pair.high()), static_cast<unsigned>(pair.low()));
      } else {
        stream += ByteString::Format("<%04X> <%04X>\n", code, static_cast<unsigned>(character.unicode));
      }
    }
    stream += unicode ? "endbfchar\n" : "endcidchar\n";
  }
  stream += "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n";
  return stream;
}

ByteString SubsetName(uint32_t object_number, const CFX_Font& original) {
  std::array<char, 7> prefix{'A', 'A', 'A', 'A', 'A', 'A', '+'};
  for (size_t i = 0; i < 6; ++i) {
    prefix[i] = static_cast<char>('A' + object_number % 26);
    object_number /= 26;
  }
  ByteString name(prefix.data(), prefix.size());
  name += original.GetPsName();
  return name;
}

RetainPtr<CPDF_Font> Embed(CPDF_Document* document,
                          const CFX_Font& original,
                          const std::vector<Character>& characters,
                          pdfium::span<const uint8_t> cff) {
  auto font = document->NewIndirect<CPDF_Dictionary>();
  const auto name = SubsetName(font->GetObjNum(), original);
  auto cid_font = document->NewIndirect<CPDF_Dictionary>();
  cid_font->SetNewFor<CPDF_Name>("Type", "Font");
  cid_font->SetNewFor<CPDF_Name>("Subtype", "CIDFontType0");
  cid_font->SetNewFor<CPDF_Name>("BaseFont", name);
  auto system = cid_font->SetNewFor<CPDF_Dictionary>("CIDSystemInfo");
  system->SetNewFor<CPDF_String>("Registry", "Adobe");
  system->SetNewFor<CPDF_String>("Ordering", "Identity");
  system->SetNewFor<CPDF_Number>("Supplement", 0);
  auto widths = cid_font->SetNewFor<CPDF_Array>("W");
  std::set<uint16_t> recorded;
  for (const auto& character : characters) {
    if (!recorded.insert(character.cid).second) continue;
    widths->AppendNew<CPDF_Number>(static_cast<int>(character.cid));
    widths->AppendNew<CPDF_Array>()->AppendNew<CPDF_Number>(character.width);
  }

  auto descriptor = document->NewIndirect<CPDF_Dictionary>();
  descriptor->SetNewFor<CPDF_Name>("Type", "FontDescriptor");
  descriptor->SetNewFor<CPDF_Name>("FontName", name);
  descriptor->SetNewFor<CPDF_Number>("Flags", 4);
  descriptor->SetRectFor("FontBBox", CFX_FloatRect(original.GetBBox().value_or(FX_RECT())));
  descriptor->SetNewFor<CPDF_Number>("Ascent", original.GetAscent());
  descriptor->SetNewFor<CPDF_Number>("Descent", original.GetDescent());
  descriptor->SetNewFor<CPDF_Number>("CapHeight", original.GetAscent());
  descriptor->SetNewFor<CPDF_Number>("ItalicAngle", 0);
  descriptor->SetNewFor<CPDF_Number>("StemV", 80);
  auto data = document->NewIndirect<CPDF_Stream>(cff);
  data->GetMutableDict()->SetNewFor<CPDF_Name>("Subtype", "CIDFontType0C");
  descriptor->SetNewFor<CPDF_Reference>("FontFile3", document, data->GetObjNum());
  cid_font->SetNewFor<CPDF_Reference>("FontDescriptor", document, descriptor->GetObjNum());

  font->SetNewFor<CPDF_Name>("Type", "Font");
  font->SetNewFor<CPDF_Name>("Subtype", "Type0");
  font->SetNewFor<CPDF_Name>("BaseFont", name);
  font->SetNewFor<CPDF_Array>("DescendantFonts")->AppendNew<CPDF_Reference>(document, cid_font->GetObjNum());
  const auto encoding = document->NewIndirect<CPDF_Stream>(MakeCMap(characters, false).unsigned_span());
  const auto unicode = document->NewIndirect<CPDF_Stream>(MakeCMap(characters, true).unsigned_span());
  font->SetNewFor<CPDF_Reference>("Encoding", document, encoding->GetObjNum());
  font->SetNewFor<CPDF_Reference>("ToUnicode", document, unicode->GetObjNum());
  auto loaded = CPDF_DocPageData::FromDocument(document)->GetFont(font);
  return loaded && loaded->IsEmbedded() ? loaded : nullptr;
}

}  // namespace

ScopedDshFormFont::ScopedDshFormFont() = default;

ScopedDshFormFont::~ScopedDshFormFont() {
  if (active_) CPDF_BAFontMap::SetDshFormFont(nullptr, nullptr, nullptr);
}

bool ScopedDshFormFont::Initialize(CPDF_Document* document,
                                    pdfium::span<const uint8_t> font_data,
                                    const std::set<uint32_t>& characters) {
  if (characters.empty()) {
    CPDF_BAFontMap::SetDshFormFont(document, nullptr, &supplementary_);
    active_ = true;
    return true;
  }
  if (font_data.empty() || font_data.size() > kMaxFontSize) return false;
  CFX_Font original;
  if (!original.LoadFaceZeroFromSpan(font_data, false, 0)) return false;

  HbHandle<hb_blob_t, hb_blob_destroy> blob(
      hb_blob_create(reinterpret_cast<const char*>(font_data.data()),
                     pdfium::checked_cast<unsigned>(font_data.size()),
                     HB_MEMORY_MODE_READONLY, nullptr, nullptr), hb_blob_destroy);
  HbHandle<hb_face_t, hb_face_destroy> face(hb_face_create(blob.get(), 0), hb_face_destroy);
  HbHandle<hb_font_t, hb_font_destroy> font(hb_font_create(face.get()), hb_font_destroy);
  hb_ot_font_set_funcs(font.get());
  hb_font_set_scale(font.get(), 1000, 1000);
  HbHandle<hb_subset_input_t, hb_subset_input_destroy> input(hb_subset_input_create_or_fail(),
                                                           hb_subset_input_destroy);
  if (!input) return false;
  auto* unicodes = hb_subset_input_unicode_set(input.get());
  std::vector<Character> selected;
  selected.reserve(characters.size());
  for (uint32_t unicode : characters) {
    hb_codepoint_t glyph = 0;
    if (!hb_font_get_nominal_glyph(font.get(), unicode, &glyph) || !glyph) return false;
    const auto cid = original.GetFace()->GetDshCharacterId(glyph);
    if (!cid || !*cid) return false;
    size_t code = unicode;
    if (pdfium::IsSupplementary(unicode)) {
      // PDFium's widget formatter uses 16-bit layout units. Surrogate
      // slots are otherwise invalid as individual scalar values.
      code = pdfium::kMinimumHighSurrogateCodeUnit + supplementary_.size();
      if (code > pdfium::kMaximumLowSurrogateCodeUnit) return false;
      supplementary_.push_back(unicode);
    }
    selected.push_back({unicode, pdfium::checked_cast<uint16_t>(code), *cid,
                        hb_font_get_glyph_h_advance(font.get(), glyph)});
    hb_set_add(unicodes, unicode);
  }

  HbHandle<hb_face_t, hb_face_destroy> subset(hb_subset_or_fail(face.get(), input.get()), hb_face_destroy);
  if (!subset) return false;
  HbHandle<hb_blob_t, hb_blob_destroy> cff(hb_face_reference_table(subset.get(), HB_TAG('C', 'F', 'F', ' ')),
                                          hb_blob_destroy);
  unsigned size = 0;
  const char* data = hb_blob_get_data(cff.get(), &size);
  if (!data || !size) return false;
  // SAFETY: HarfBuzz owns this byte range for the lifetime of the blob.
  const auto bytes = UNSAFE_BUFFERS(pdfium::span(reinterpret_cast<const uint8_t*>(data), size));
  font_ = Embed(document, original, selected, bytes);
  if (!font_) return false;
  CPDF_BAFontMap::SetDshFormFont(document, font_.Get(), &supplementary_);
  active_ = true;
  return true;
}
