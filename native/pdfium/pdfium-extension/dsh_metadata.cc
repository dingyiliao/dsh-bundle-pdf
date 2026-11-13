#include "public/dsh_metadata.h"

#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <utility>

#include "core/fdrm/fx_crypt_sha.h"
#include "core/fpdfapi/parser/cpdf_array.h"
#include "core/fpdfapi/parser/cpdf_cross_ref_table.h"
#include "core/fpdfapi/parser/cpdf_dictionary.h"
#include "core/fpdfapi/parser/cpdf_document.h"
#include "core/fpdfapi/parser/cpdf_number.h"
#include "core/fpdfapi/parser/cpdf_parser.h"
#include "core/fpdfapi/parser/cpdf_stream.h"
#include "core/fpdfapi/parser/cpdf_stream_acc.h"
#include "core/fpdfapi/parser/fpdf_parser_utility.h"
#include "core/fxcrt/fx_coordinates.h"
#include "core/fxcrt/scoped_set_insertion.h"
#include "fpdfsdk/cpdfsdk_helpers.h"

#if defined(USE_SYSTEM_ZLIB)
#include <zlib.h>
#else
#include "third_party/zlib/zlib.h"
#endif

namespace {

constexpr unsigned kMaxDepth = 64;
constexpr size_t kMaxObjects = 500'000;
constexpr size_t kMaxStreamBytes = 32 * 1024 * 1024;
constexpr size_t kMaxPageBytes = 256 * 1024 * 1024;
constexpr size_t kMaxDocumentBytes = 1024 * 1024 * 1024;

using Object = RetainPtr<const CPDF_Object>;
using Dictionary = RetainPtr<const CPDF_Dictionary>;
using Digest = std::array<uint8_t, 32>;

// Distinguish an absent attribute from malformed ancestry or a broken reference.
std::optional<Object> Resolve(Object object) {
  if (object && object->IsReference()) {
    object = object->GetDirect();
    if (!object || object->IsReference()) {
      return std::nullopt;
    }
  }
  if (object && object->IsNull()) {
    object.Reset();
  }
  return object;
}

std::optional<Object> InheritedAttribute(Dictionary page, ByteStringView key) {
  for (unsigned depth = 0; depth <= kMaxDepth; ++depth) {
    if (page->KeyExist(key)) {
      return Resolve(page->GetObjectFor(key));
    }
    auto parent = Resolve(page->GetObjectFor("Parent"));
    if (!parent) {
      return std::nullopt;
    }
    if (!*parent) {
      return Object();
    }
    page = ToDictionary(*parent);
    if (!page) {
      return std::nullopt;
    }
  }
  return std::nullopt;
}

std::optional<CFX_FloatRect> ReadBox(const Object& value,
                                     const CFX_FloatRect& default_box) {
  if (!value) {
    return default_box;
  }
  const CPDF_Array* array = value->AsArray();
  if (!array || array->size() != 4) {
    return std::nullopt;
  }
  std::array<float, 4> points;
  for (size_t i = 0; i < points.size(); ++i) {
    auto item = Resolve(array->GetObjectAt(i));
    if (!item || !*item || !(*item)->IsNumber()) {
      return std::nullopt;
    }
    points[i] = (*item)->GetNumber();
    if (!std::isfinite(points[i])) {
      return std::nullopt;
    }
  }
  CFX_FloatRect box(points[0], points[1], points[2], points[3]);
  box.Normalize();
  if (box.IsEmpty()) {
    return std::nullopt;
  }
  return box;
}

FS_RECTF PublicBox(const CFX_FloatRect& box) {
  return {box.left, box.top, box.right, box.bottom};
}

std::optional<FPDF_DSH_PAGE_GEOMETRY> PageGeometry(const Dictionary& page) {
  auto media = InheritedAttribute(page, "MediaBox");
  auto crop = InheritedAttribute(page, "CropBox");
  auto rotate = InheritedAttribute(page, "Rotate");
  auto unit = Resolve(page->GetObjectFor("UserUnit"));
  if (!media || !crop || !rotate || !unit) {
    return std::nullopt;
  }
  auto media_box = ReadBox(*media, CFX_FloatRect(0, 0, 612, 792));
  auto crop_box = media_box ? ReadBox(*crop, *media_box) : std::nullopt;
  if (!crop_box || (*rotate && !(*rotate)->IsNumber()) ||
      (*unit && !(*unit)->IsNumber())) {
    return std::nullopt;
  }
  int rotation = *rotate ? (*rotate)->GetInteger() % 360 : 0;
  const double user_unit = *unit ? (*unit)->GetNumber() : 1;
  if (rotation % 90 != 0 || !std::isfinite(user_unit) || user_unit <= 0) {
    return std::nullopt;
  }
  if (rotation < 0) {
    rotation += 360;
  }
  return FPDF_DSH_PAGE_GEOMETRY{PublicBox(*media_box), PublicBox(*crop_box),
                                rotation, user_unit};
}

bool HasNonNullEntry(const CPDF_Dictionary& dictionary, ByteStringView key) {
  // Treat a broken reference in a signature slot as possible signature data.
  auto value = Resolve(dictionary.GetObjectFor(key));
  return !value || !!*value;
}

std::optional<ByteString> ReadName(const CPDF_Dictionary& dictionary,
                                  ByteStringView key) {
  auto value = Resolve(dictionary.GetObjectFor(key));
  if (!value) {
    return std::nullopt;
  }
  return *value && (*value)->IsName() ? (*value)->GetString() : ByteString();
}

// Each indirect object is inspected from the cross-reference table below.
// Follow inline containers here, without following the page tree's backlinks.
int ScanSignatureObjects(const CPDF_Object& object,
                         unsigned depth,
                         size_t& remaining) {
  if (depth > kMaxDepth || remaining == 0) {
    return -1;
  }
  --remaining;
  if (const CPDF_Array* array = object.AsArray()) {
    for (size_t i = 0; i < array->size(); ++i) {
      auto child = array->GetObjectAt(i);
      if (child) {
        const int result = ScanSignatureObjects(*child, depth + 1, remaining);
        if (result != 0) {
          return result;
        }
      }
    }
    return 0;
  }
  if (object.IsReference()) {
    return 0;
  }
  auto dictionary = object.GetDict();
  if (!dictionary) {
    return 0;
  }
  const auto type = ReadName(*dictionary, "Type");
  const auto field_type = ReadName(*dictionary, "FT");
  if ((type && (*type == "Sig" || *type == "DocTimeStamp")) ||
      (field_type && *field_type == "Sig" &&
       HasNonNullEntry(*dictionary, "V")) ||
      (dictionary->GetArrayFor("ByteRange") &&
       HasNonNullEntry(*dictionary, "Contents"))) {
    return 1;
  }
  if (!type || !field_type) {
    return -1;
  }
  for (const auto& key : dictionary->GetKeys()) {
    auto child = dictionary->GetObjectFor(key.AsStringView());
    if (child) {
      const int result = ScanSignatureObjects(*child, depth + 1, remaining);
      if (result != 0) {
        return result;
      }
    }
  }
  return 0;
}

// Only a balanced, known page program can be proven equivalent when a PDF
// editor has added standalone outer graphics-state streams.
bool IsNumericOperand(std::string_view token) {
  if (token.starts_with('+') || token.starts_with('-'))
    token.remove_prefix(1);
  bool has_digit = false;
  bool has_dot = false;
  for (char ch : token) {
    if (ch >= '0' && ch <= '9') {
      has_digit = true;
    } else if (ch == '.' && !has_dot) {
      has_dot = true;
    } else {
      return false;
    }
  }
  return has_digit;
}

bool IsBalancedPageProgram(std::string_view program) {
  constexpr std::string_view operators[] = {
      "q", "Q", "cm", "w", "J", "j", "M", "d", "ri", "i", "gs", "m", "l",
      "c", "v", "y", "h", "re", "S", "s", "f", "F", "f*", "B", "B*",
      "b", "b*", "n", "W", "W*", "BT", "ET", "Tc", "Tw", "Tz", "TL", "Tf",
      "Tr", "Ts", "Td", "TD", "Tm", "T*", "Tj", "TJ", "'", "\"", "d0",
      "d1", "CS", "cs", "SC", "SCN", "sc", "scn", "G", "g", "RG", "rg",
      "K", "k", "sh", "Do", "MP", "DP", "BMC", "BDC", "EMC", "BX", "EX"};
  const auto delimiter = [](uint8_t ch) {
    return PDFCharIsWhitespace(ch) || PDFCharIsDelimiter(ch);
  };
  std::string containers;
  size_t index = 0;
  int saves = 0;
  while (index < program.size()) {
    const uint8_t ch = program[index++];
    if (PDFCharIsWhitespace(ch))
      continue;
    if (ch == '%') {
      while (index < program.size() && !PDFCharIsLineEnding(program[index]))
        ++index;
      // PDFium joins streams with a space. An unterminated comment would
      // consume the closing wrapper as part of the original page program.
      if (index == program.size())
        return false;
    } else if (ch == '(') {
      size_t nesting = 1;
      while (index < program.size() && nesting) {
        const auto value = program[index++];
        if (value == '(')
          ++nesting;
        else if (value == ')')
          --nesting;
        else if (value == '\\') {
          if (index == program.size())
            return false;
          ++index;
        }
      }
      if (nesting)
        return false;
    } else if (ch == '/') {
      while (index < program.size() && !delimiter(program[index]))
        ++index;
    } else if (ch == '<' && (index == program.size() || program[index] != '<')) {
      while (index < program.size() && program[index] != '>') {
        const uint8_t hex = program[index++];
        if (!PDFCharIsWhitespace(hex) && !(hex >= '0' && hex <= '9') &&
            !(hex >= 'a' && hex <= 'f') && !(hex >= 'A' && hex <= 'F'))
          return false;
      }
      if (index == program.size())
        return false;
      ++index;
    } else if (ch == '[' || ch == '<') {
      if (ch == '<')
        ++index;
      if (containers.size() == kMaxDepth)
        return false;
      containers.push_back(ch == '[' ? ']' : '>');
    } else if (ch == ']' || ch == '>') {
      if (containers.empty() || containers.back() != ch)
        return false;
      containers.pop_back();
      if (ch == '>' && (index == program.size() || program[index++] != '>'))
        return false;
    } else {
      if (delimiter(ch))
        return false;
      const size_t start = index - 1;
      while (index < program.size() && !delimiter(program[index]))
        ++index;
      const auto token = program.substr(start, index - start);
      if (!containers.empty()) {
        if (token != "true" && token != "false" && token != "null" &&
            !IsNumericOperand(token))
          return false;
      } else {
        if (std::ranges::find(operators, token) == std::end(operators) &&
            !IsNumericOperand(token))
          return false;
        if (token == "q")
          ++saves;
        if (token == "Q" && --saves < 0)
          return false;
      }
    }
  }
  return saves == 0 && containers.empty();
}

std::optional<std::string> DecodePageProgram(const Object& raw, size_t limit) {
  auto object = Resolve(raw);
  if (!object)
    return std::nullopt;
  auto stream = ToStream(*object);
  if (!stream || stream->GetRawSize() > limit + 64)
    return std::nullopt;
  const auto dictionary = stream->GetDict();
  auto filter = Resolve(dictionary->GetObjectFor("Filter"));
  auto parameters = Resolve(dictionary->GetObjectFor("DecodeParms"));
  if (!filter || !parameters || *parameters)
    return std::nullopt;
  auto access = pdfium::MakeRetain<CPDF_StreamAcc>(stream);
  access->LoadAllDataRaw();
  const auto bytes = access->GetSpan();
  if (bytes.size() != stream->GetRawSize())
    return std::nullopt;
  if (!*filter && bytes.size() <= limit)
    return std::string(bytes.begin(), bytes.end());
  if (!*filter || !(*filter)->IsName() ||
      ((*filter)->GetString() != "FlateDecode" && (*filter)->GetString() != "Fl"))
    return std::nullopt;
  std::string output(limit, '\0');
  uLongf size = output.size();
  uLong consumed = bytes.size();
  if (uncompress2(reinterpret_cast<Bytef*>(output.data()), &size, bytes.data(),
                  &consumed) != Z_OK || consumed != bytes.size())
    return std::nullopt;
  output.resize(size);
  return output;
}

bool IsGraphicsWrapper(const Object& stream, char op) {
  const auto program = DecodePageProgram(stream, 128);
  if (!program)
    return false;
  auto view = std::string_view(*program);
  while (!view.empty() && PDFCharIsWhitespace(view.front()))
    view.remove_prefix(1);
  while (!view.empty() && PDFCharIsWhitespace(view.back()))
    view.remove_suffix(1);
  return view.size() == 1 && view.front() == op;
}

class Sha256 {
 public:
  Sha256() { CryptSha256Start(&context_); }

  void Write(pdfium::span<const uint8_t> bytes) {
    CryptSha256Update(&context_, bytes);
  }

  void Integer(uint64_t value) {
    std::array<uint8_t, 8> bytes;
    for (auto& byte : bytes) {
      byte = static_cast<uint8_t>(value);
      value >>= 8;
    }
    Write(bytes);
  }

  void Number(double value) {
    // Match numerical equality, including the two representations of zero.
    Integer(std::bit_cast<uint64_t>(value == 0 ? 0.0 : value));
  }

  void String(ByteStringView value) {
    Integer(value.GetLength());
    Write(value.unsigned_span());
  }

  Digest Finish() {
    Digest output;
    CryptSha256Finish(&context_, output);
    return output;
  }

 private:
  CryptSha2Context context_;
};

bool IsResourceCategory(ByteStringView key) {
  return key == "Font" || key == "XObject" || key == "ExtGState" ||
         key == "ColorSpace" || key == "Pattern" || key == "Shading" ||
         key == "Properties";
}

}  // namespace

struct fpdf_dsh_content_fingerprint_t__ {
  explicit fpdf_dsh_content_fingerprint_t__(CPDF_Document* document)
      : document_(document) {}

  bool Initialize() {
    const CPDF_Dictionary* root = document_->GetRoot();
    if (!root) {
      return false;
    }
    auto optional = Resolve(root->GetObjectFor("OCProperties"));
    if (!optional) {
      return false;
    }
    if (*optional) {
      auto dictionary = ToDictionary(*optional);
      if (!dictionary) {
        return false;
      }
      auto groups = Resolve(dictionary->GetObjectFor("OCGs"));
      if (!groups || (*groups && !(*groups)->IsArray())) {
        return false;
      }
      if (*groups) {
        const CPDF_Array* array = (*groups)->AsArray();
        if (array->size() > kMaxObjects) {
          return false;
        }
        for (size_t i = 0; i < array->size(); ++i) {
          auto group = Resolve(array->GetObjectAt(i));
          if (!group || !*group || !(*group)->IsDictionary() ||
              !groups_.emplace(group->Get(), i).second) {
            return false;
          }
        }
      }
    }
    Sha256 hash;
    hash.String("pdfium-index-shared-v1");
    if (!Append(hash, *optional, 0) ||
        !Append(hash, root->GetObjectFor("OutputIntents"), 0)) {
      return false;
    }
    shared_ = hash.Finish();
    return true;
  }

  std::optional<Digest> Page(int index) {
    if (auto it = pages_.find(index); it != pages_.end()) {
      return it->second;
    }
    page_bytes_ = 0;
    if (objects_ >= kMaxObjects || total_bytes_ >= kMaxDocumentBytes) {
      return std::nullopt;
    }
    const Dictionary page = document_->GetPageDictionary(index);
    if (!page) {
      return std::nullopt;
    }
    auto geometry = PageGeometry(page);
    auto resources = InheritedAttribute(page, "Resources");
    auto contents = Resolve(page->GetObjectFor("Contents"));
    if (!geometry || !resources || !contents ||
        (*resources && !(*resources)->IsDictionary())) {
      return std::nullopt;
    }
    Sha256 hash;
    hash.String("pdfium-index-page-v1");
    hash.Write(shared_);
    for (const auto& box : {geometry->media_box, geometry->crop_box}) {
      hash.Number(box.left);
      hash.Number(box.bottom);
      hash.Number(box.right);
      hash.Number(box.top);
    }
    hash.Integer(geometry->rotation);
    hash.Number(geometry->user_unit);
    if (!Append(hash, page->GetObjectFor("Group"), 0) ||
        !HashDictionary(hash, ToDictionary(*resources).Get(), 0,
                        DictionaryKind::kResources) ||
        !HashPageContents(hash, *contents)) {
      return std::nullopt;
    }
    auto digest = hash.Finish();
    pages_.emplace(index, digest);
    return digest;
  }

 private:
  enum class DictionaryKind { kOrdinary, kResources, kRawStream, kPlainStream };

  bool Charge(size_t bytes) {
    if (bytes > kMaxPageBytes - page_bytes_ ||
        bytes > kMaxDocumentBytes - total_bytes_) {
      return false;
    }
    page_bytes_ += bytes;
    total_bytes_ += bytes;
    return true;
  }

  bool Append(Sha256& hash, Object object, unsigned depth) {
    auto digest = HashObject(std::move(object), depth);
    if (!digest) {
      return false;
    }
    hash.Write(*digest);
    return true;
  }

  std::optional<Digest> HashObject(Object raw, unsigned depth) {
    if (objects_ >= kMaxObjects || depth > kMaxDepth) {
      return std::nullopt;
    }
    ++objects_;
    auto resolved = Resolve(std::move(raw));
    if (!resolved) {
      return std::nullopt;
    }
    Sha256 hash;
    const auto& object = *resolved;
    if (!object) {
      hash.String("null");
      return hash.Finish();
    }
    const auto type = object->GetType();
    if (type == CPDF_Object::kNumber) {
      const CPDF_Number* number = object->AsNumber();
      double value = number->GetNumber();
      if (number->IsInteger()) {
        const int integer = number->GetInteger();
        // PDFium can store unsigned 32-bit values. GetInteger() exposes their
        // signed bits, whereas GetNumber() loses precision at that magnitude.
        value = integer < 0 && value >= 0
                    ? static_cast<double>(static_cast<uint32_t>(integer))
                    : static_cast<double>(integer);
      }
      if (!std::isfinite(value)) {
        return std::nullopt;
      }
      hash.String("number");
      hash.Number(value);
      return hash.Finish();
    }
    if (type == CPDF_Object::kBoolean) {
      hash.String("boolean");
      hash.Integer(object->GetInteger() != 0);
      return hash.Finish();
    }
    if (type == CPDF_Object::kName || type == CPDF_Object::kString) {
      const ByteString value = object->GetString();
      if (!Charge(value.GetLength())) {
        return std::nullopt;
      }
      hash.String(type == CPDF_Object::kName ? "name" : "string");
      hash.String(value.AsStringView());
      return hash.Finish();
    }
    if (active_.contains(object.Get())) {
      return std::nullopt;
    }
    if (auto it = memo_.find(object.Get()); it != memo_.end()) {
      return it->second;
    }
    ScopedSetInsertion active(&active_, object.Get());
    bool ok = false;
    if (const auto* array = object->AsArray()) {
      hash.String("array");
      hash.Integer(array->size());
      ok = true;
      for (size_t i = 0; i < array->size() && ok; ++i) {
        ok = Append(hash, array->GetObjectAt(i), depth + 1);
      }
    } else if (const auto* dictionary = object->AsDictionary()) {
      ok = HashDictionary(hash, dictionary, depth, DictionaryKind::kOrdinary);
    } else if (object->IsStream()) {
      ok = HashStream(hash, ToStream(object), depth);
    }
    if (!ok) {
      return std::nullopt;
    }
    auto digest = hash.Finish();
    memo_.emplace(object.Get(), digest);
    return digest;
  }

  bool HashDictionary(Sha256& hash,
                      const CPDF_Dictionary* dictionary,
                      unsigned depth,
                      DictionaryKind kind) {
    hash.String("dictionary");
    if (!dictionary) {
      hash.String("end");
      return true;
    }
    const auto type = ReadName(*dictionary, "Type");
    if (!type || *type == "Page" || *type == "Pages" || *type == "Catalog") {
      return false;
    }
    if (*type == "OCG") {
      auto group = groups_.find(dictionary);
      if (group == groups_.end()) {
        return false;
      }
      hash.String("optional-content-group");
      hash.Integer(group->second);
    }
    if (dictionary->size() > kMaxObjects - objects_) {
      return false;
    }
    auto keys = dictionary->GetKeys();
    std::sort(keys.begin(), keys.end());
    for (const auto& name : keys) {
      const auto key = name.AsStringView();
      if (key == "Metadata" ||
          (kind == DictionaryKind::kResources && key == "ProcSet") ||
          ((kind == DictionaryKind::kRawStream ||
            kind == DictionaryKind::kPlainStream) && key == "Length") ||
          (kind == DictionaryKind::kPlainStream &&
           (key == "Filter" || key == "DecodeParms"))) {
        continue;
      }
      if (kind == DictionaryKind::kResources && !IsResourceCategory(key)) {
        return false;
      }
      auto value = Resolve(dictionary->GetObjectFor(key));
      if (!value) {
        return false;
      }
      if (!*value ||
          (kind == DictionaryKind::kResources &&
           (*value)->IsDictionary() && (*value)->AsDictionary()->IsEmpty())) {
        continue;
      }
      if (!Charge(key.GetLength())) {
        return false;
      }
      hash.String("entry");
      hash.String(key);
      if (!Append(hash, *value, depth + 1)) {
        return false;
      }
    }
    hash.String("end");
    return true;
  }

  // CPDF_FlateEncoder compresses previously unfiltered streams even when a
  // save only changes annotations. Hash the decoded payload for these two
  // equivalent representations, without retaining expanded streams.
  bool HashStream(Sha256& hash,
                  RetainPtr<const CPDF_Stream> stream,
                  unsigned depth) {
    const auto dictionary = stream->GetDict();
    auto filter = Resolve(dictionary->GetObjectFor("Filter"));
    if (!filter) {
      return false;
    }
    Object single_filter = *filter;
    if (const auto array = ToArray(single_filter); array && array->size() == 1) {
      auto only = Resolve(array->GetObjectAt(0));
      if (!only || !*only) {
        return false;
      }
      single_filter = *only;
    }
    const bool flate = single_filter && single_filter->IsName() &&
        (single_filter->GetString() == "FlateDecode" ||
         single_filter->GetString() == "Fl");
    const bool plain = !*filter || flate;
    hash.String(plain ? "plain-stream" : "encoded-stream");
    if (!HashDictionary(hash, dictionary.Get(), depth,
                        plain ? DictionaryKind::kPlainStream
                              : DictionaryKind::kRawStream)) {
      return false;
    }
    if (plain) {
      Object parameters;
      if (flate) {
        auto resolved = Resolve(dictionary->GetObjectFor("DecodeParms"));
        if (!resolved) {
          return false;
        }
        parameters = *resolved;
        if (const auto array = ToArray(parameters); array && array->size() == 1) {
          parameters = array->GetObjectAt(0);
        }
      }
      if (!Append(hash, std::move(parameters), depth + 1)) {
        return false;
      }
    }
    const size_t size = stream->GetRawSize();
    if (size > kMaxStreamBytes || !Charge(size)) {
      return false;
    }
    auto access = pdfium::MakeRetain<CPDF_StreamAcc>(std::move(stream));
    access->LoadAllDataRaw();
    const auto bytes = access->GetSpan();
    if (bytes.size() != size) {
      return false;
    }
    Sha256 payload;
    if (flate) {
      if (!HashFlate(payload, bytes)) {
        return false;
      }
    } else {
      payload.Write(bytes);
    }
    hash.Write(payload.Finish());
    return true;
  }

  bool HashFlate(Sha256& hash, pdfium::span<const uint8_t> bytes) {
    z_stream stream = {};
    stream.next_in = const_cast<uint8_t*>(bytes.data());
    stream.avail_in = static_cast<uInt>(bytes.size());
    if (inflateInit(&stream) != Z_OK) {
      return false;
    }
    std::array<uint8_t, 16 * 1024> buffer;
    int result;
    do {
      stream.next_out = buffer.data();
      stream.avail_out = static_cast<uInt>(buffer.size());
      result = inflate(&stream, Z_NO_FLUSH);
      const size_t size = buffer.size() - stream.avail_out;
      if (stream.total_out > kMaxStreamBytes || !Charge(size)) {
        inflateEnd(&stream);
        return false;
      }
      hash.Write(pdfium::span(buffer).first(size));
    } while (result == Z_OK);
    inflateEnd(&stream);
    return result == Z_STREAM_END;
  }

  bool HasBalancedContents(const CPDF_Array& streams, size_t first, size_t end) {
    constexpr size_t kMaxProgramBytes = 1024 * 1024;
    size_t remaining = std::min(kMaxProgramBytes, wrapper_bytes_);
    if (!remaining)
      return false;
    std::string combined;
    for (size_t index = first; index < end; ++index) {
      if (remaining <= 1)
        return false;
      auto program = DecodePageProgram(streams.GetObjectAt(index), remaining - 1);
      if (!program) {
        // Even a failed inflate can consume its output budget.
        wrapper_bytes_ -= remaining;
        return false;
      }
      const size_t bytes = program->size() + 1;
      remaining -= bytes;
      wrapper_bytes_ -= bytes;
      combined += *program;
      combined += ' ';
    }
    return IsBalancedPageProgram(combined);
  }

  bool HashPageContents(Sha256& hash, const Object& contents) {
    if (!contents) {
      hash.Integer(0);
      return true;
    }
    if (const CPDF_Array* array = contents->AsArray()) {
      size_t first = 0, end = array->size();
      while (end - first >= 2 && wrapper_bytes_ &&
             IsGraphicsWrapper(array->GetObjectAt(first), 'q') &&
             IsGraphicsWrapper(array->GetObjectAt(end - 1), 'Q') &&
             HasBalancedContents(*array, first + 1, end - 1)) {
        // Bound work even for a chain of empty nested wrappers.
        --wrapper_bytes_;
        ++first;
        --end;
      }
      hash.Integer(end - first);
      for (size_t i = first; i < end; ++i) {
        auto stream = Resolve(array->GetObjectAt(i));
        if (!stream || !*stream || !(*stream)->IsStream() ||
            !Append(hash, *stream, 0)) {
          return false;
        }
      }
      return true;
    }
    hash.Integer(1);
    return contents->IsStream() && Append(hash, contents, 0);
  }

  CPDF_Document* const document_;
  std::map<int, Digest> pages_;
  std::map<const CPDF_Object*, size_t> groups_;
  std::map<const CPDF_Object*, Digest> memo_;
  std::set<const CPDF_Object*> active_;
  Digest shared_;
  size_t wrapper_bytes_ = 32 * 1024 * 1024;
  size_t objects_ = 0;
  size_t page_bytes_ = 0;
  size_t total_bytes_ = 0;
};

FPDF_EXPORT FPDF_BOOL FPDF_CALLCONV
FPDF_DSH_GetPageGeometry(FPDF_DOCUMENT handle,
                        int page_index,
                        FPDF_DSH_PAGE_GEOMETRY* geometry) {
  CPDF_Document* document = CPDFDocumentFromFPDFDocument(handle);
  if (!document || !geometry) {
    return false;
  }
  const Dictionary page = document->GetPageDictionary(page_index);
  const auto result = page ? PageGeometry(page) : std::nullopt;
  if (!result) {
    return false;
  }
  *geometry = *result;
  return true;
}

FPDF_EXPORT int FPDF_CALLCONV FPDF_DSH_GetSignatureStatus(FPDF_DOCUMENT handle) {
  CPDF_Document* document = CPDFDocumentFromFPDFDocument(handle);
  if (!document || !document->GetRoot() || !document->GetParser()) {
    return -1;
  }
  const CPDF_Dictionary* root = document->GetRoot();
  CPDF_Parser* parser = document->GetParser();
  auto permissions = Resolve(root->GetObjectFor("Perms"));
  if (permissions && *permissions) {
    auto dictionary = ToDictionary(*permissions);
    if (!dictionary) {
      permissions = std::nullopt;
    } else if (HasNonNullEntry(*dictionary, "DocMDP") ||
               HasNonNullEntry(*dictionary, "UR") ||
               HasNonNullEntry(*dictionary, "UR3")) {
      return 1;
    }
  }
  size_t remaining = kMaxObjects;
  const int root_result = ScanSignatureObjects(*root, 0, remaining);
  if (root_result != 0) {
    return root_result;
  }
  // PDFium can reconstruct a missing cross-reference table by scanning the
  // file, including the objects inside object streams. A reconstructed table
  // still needs the same complete object inspection before enabling writes.
  bool complete = permissions.has_value();
  // This internal accessor exposes the sparse table, including objects stored
  // in object streams. Parsing uncached objects directly keeps them out of the
  // document's long-lived indirect-object cache.
  const auto* table = parser->GetCrossRefTableForTesting();
  for (const auto& [number, entry] : table->objects_info()) {
    if (entry.type == CPDF_CrossRefTable::ObjectType::kFree ||
        number == root->GetObjNum()) {
      continue;
    }
    if (remaining == 0) {
      return -1;
    }
    --remaining;
    auto object = document->GetIndirectObject(number);
    if (!object) {
      object = parser->ParseIndirectObject(number);
    }
    if (!object) {
      complete = false;
      continue;
    }
    const int result = ScanSignatureObjects(*object, 0, remaining);
    if (result != 0) {
      return result;
    }
  }
  return complete ? 0 : -1;
}

FPDF_EXPORT FPDF_DSH_CONTENT_FINGERPRINT FPDF_CALLCONV
FPDF_DSH_CreateContentFingerprint(FPDF_DOCUMENT handle) {
  CPDF_Document* document = CPDFDocumentFromFPDFDocument(handle);
  if (!document) {
    return nullptr;
  }
  auto fingerprint = std::make_unique<fpdf_dsh_content_fingerprint_t__>(document);
  return fingerprint->Initialize() ? fingerprint.release() : nullptr;
}

FPDF_EXPORT FPDF_BOOL FPDF_CALLCONV
FPDF_DSH_GetPageFingerprint(FPDF_DSH_CONTENT_FINGERPRINT fingerprint,
                           int page_index,
                           unsigned char digest[32]) {
  if (!fingerprint || !digest) {
    return false;
  }
  auto result = fingerprint->Page(page_index);
  if (!result) {
    return false;
  }
  std::copy(result->begin(), result->end(), digest);
  return true;
}

FPDF_EXPORT void FPDF_CALLCONV FPDF_DSH_CloseContentFingerprint(
    FPDF_DSH_CONTENT_FINGERPRINT fingerprint) {
  delete fingerprint;
}
