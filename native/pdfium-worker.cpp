// All PDFium calls run on this process's one command loop. No Host paths or
// native pointers cross the protocol. Input PDF bytes remain alive with a handle.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <functional>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>
#include "json.hpp"
#include "fpdfview.h"
#include "fpdf_doc.h"
#include "fpdf_edit.h"
#include "fpdf_text.h"
#include "fpdf_formfill.h"
#include "fpdf_signature.h"
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

using json = nlohmann::json;
constexpr uint32_t max_json = 2 * 1024 * 1024;
constexpr uint32_t max_payload = 256 * 1024 * 1024;
constexpr uint32_t max_reply_payload = 8 * 1024 * 1024;
constexpr int max_tile = 1026;
struct Failure : std::runtime_error {
  std::string code;
  Failure(std::string c, std::string m) : std::runtime_error(m), code(std::move(c)) {}
};
void require(bool ok, const char* message) {
  if (!ok) throw Failure("pdf/native-request", message);
}
int integer(const json& value, const char* key, int low, int high) {
  require(value.contains(key) && value[key].is_number_integer(), "An integer field is required");
  const int64_t n = value[key].get<int64_t>();
  require(n >= low && n <= high, "Integer is outside the native protocol bounds");
  return static_cast<int>(n);
}
std::string id_for(const json& value, const char* key) {
  require(value.contains(key) && value[key].is_string(), "Document identity is required");
  auto id = value[key].get<std::string>();
  require(!id.empty() && id.size() <= 128, "Invalid document identity");
  return id;
}
struct Page {
  FPDF_PAGE handle;
  uint64_t used = 0;
  explicit Page(FPDF_PAGE value) : handle(value) {}
  ~Page() { if (handle) FPDF_ClosePage(handle); }
};
struct Bitmap {
  FPDF_BITMAP handle;
  explicit Bitmap(FPDF_BITMAP value) : handle(value) {}
  Bitmap(const Bitmap&) = delete;
  Bitmap& operator=(const Bitmap&) = delete;
  ~Bitmap() { if (handle) FPDFBitmap_Destroy(handle); }
};
struct Document;
struct FormHost {
  FPDF_FORMFILLINFO callbacks{};
  Document* document = nullptr;
};
struct Document {
  std::vector<unsigned char> bytes;
  FPDF_DOCUMENT handle = nullptr;
  FPDF_FORMHANDLE form = nullptr;
  FormHost formHost{};
  int formType = FORMTYPE_NONE;
  int count = 0;
  uint64_t clock = 0;
  std::unordered_map<int, std::unique_ptr<Page>> pages;
  ~Document() {
    for (const auto& [index, page] : pages) {
      (void)index;
      if (form) FORM_OnBeforeClosePage(page->handle, form);
    }
    pages.clear();
    if (form) FPDFDOC_ExitFormFillEnvironment(form);
    if (handle) FPDF_CloseDocument(handle);
  }
  void initializeForm() {
    if (formType != FORMTYPE_ACRO_FORM) return;
    formHost.document = this;
    formHost.callbacks.version = 1;
    // The reader only renders form appearances. No document JavaScript,
    // network, named action or PDFium form input event is executed.
    formHost.callbacks.FFI_Invalidate = [](FPDF_FORMFILLINFO*, FPDF_PAGE, double, double, double, double) {};
    formHost.callbacks.FFI_GetPage = [](FPDF_FORMFILLINFO* callbacks, FPDF_DOCUMENT handle, int index) -> FPDF_PAGE {
      auto* host = reinterpret_cast<FormHost*>(callbacks);
      if (!host->document || host->document->handle != handle) return nullptr;
      try { return host->document->page(index); } catch (...) { return nullptr; }
    };
    formHost.callbacks.FFI_GetRotation = [](FPDF_FORMFILLINFO*, FPDF_PAGE) { return 0; };
    form = FPDFDOC_InitFormFillEnvironment(handle, &formHost.callbacks);
    if (!form) throw Failure("pdf/native-form", "PDFium could not initialize AcroForm rendering");
  }
  FPDF_PAGE page(int index) {
    require(index >= 0 && index < count, "Page index is outside the document");
    auto found = pages.find(index);
    if (found != pages.end()) { found->second->used = ++clock; return found->second->handle; }
    if (pages.size() >= 16) {
      auto oldest = std::min_element(pages.begin(), pages.end(), [](const auto& a, const auto& b) {
        return a.second->used < b.second->used;
      });
      if (form) FORM_OnBeforeClosePage(oldest->second->handle, form);
      pages.erase(oldest);
    }
    auto handle = FPDF_LoadPage(this->handle, index);
    if (!handle) throw Failure("pdf/native-page", "PDFium could not load the requested page");
    auto owned = std::make_unique<Page>(handle);
    owned->used = ++clock;
    pages.emplace(index, std::move(owned));
    if (form) FORM_OnAfterLoadPage(handle, form);
    return handle;
  }
};
std::unordered_map<std::string, std::unique_ptr<Document>> documents;
Document& doc_for(const json& request) {
  auto found = documents.find(id_for(request, "documentId"));
  if (found == documents.end()) throw Failure("pdf/native-document", "Native document has closed; reopen it");
  return *found->second;
}
uint32_t u32(const unsigned char* p) {
  return uint32_t(p[0]) | (uint32_t(p[1]) << 8) | (uint32_t(p[2]) << 16) | (uint32_t(p[3]) << 24);
}
void write_u32(unsigned char* p, uint32_t n) {
  for (unsigned i = 0; i < 4; i++) p[i] = static_cast<unsigned char>(n >> (i * 8));
}
void reply(const json& value, const std::vector<unsigned char>& payload = {}) {
  auto text = value.dump();
  if (text.size() > max_json || payload.size() > max_reply_payload)
    throw Failure("pdf/native-reply-too-large", "Native reply exceeds protocol limit");
  unsigned char prefix[8];
  write_u32(prefix, static_cast<uint32_t>(text.size()));
  write_u32(prefix + 4, static_cast<uint32_t>(payload.size()));
  std::cout.write(reinterpret_cast<const char*>(prefix), 8);
  std::cout.write(text.data(), static_cast<std::streamsize>(text.size()));
  if (!payload.empty()) std::cout.write(reinterpret_cast<const char*>(payload.data()), payload.size());
  std::cout.flush();
}
std::string utf8(uint32_t n) {
  if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) n = 0xfffd;
  std::string s;
  if (n <= 0x7f) s += char(n);
  else if (n <= 0x7ff) { s += char(0xc0 | (n >> 6)); s += char(0x80 | (n & 63)); }
  else if (n <= 0xffff) { s += char(0xe0 | (n >> 12)); s += char(0x80 | ((n >> 6) & 63)); s += char(0x80 | (n & 63)); }
  else { s += char(0xf0 | (n >> 18)); s += char(0x80 | ((n >> 12) & 63)); s += char(0x80 | ((n >> 6) & 63)); s += char(0x80 | (n & 63)); }
  return s;
}

json destination(FPDF_DOCUMENT doc, FPDF_DEST dest) {
  if (!dest) return nullptr;
  const int page = FPDFDest_GetDestPageIndex(doc, dest);
  if (page < 0) return nullptr;
  unsigned long count = 0;
  FS_FLOAT params[4] = {0, 0, 0, 0};
  const auto type = FPDFDest_GetView(dest, &count, params);
  json result = json::array({ page });
  const char* names[] = { "", "XYZ", "Fit", "FitH", "FitV", "FitR", "FitB", "FitBH", "FitBV" };
  result.push_back({{"name", type < 9 && type > 0 ? names[type] : "Fit"}});
  if (type == PDFDEST_VIEW_XYZ) {
    FPDF_BOOL has_x = 0, has_y = 0, has_zoom = 0;
    FS_FLOAT x = 0, y = 0, zoom = 0;
    FPDFDest_GetLocationInPage(dest, &has_x, &has_y, &has_zoom, &x, &y, &zoom);
    result.push_back(has_x ? json(x) : json(nullptr));
    result.push_back(has_y ? json(y) : json(nullptr));
    result.push_back(has_zoom ? json(zoom) : json(nullptr));
  } else for (unsigned i = 0; i < std::min<unsigned long>(count, 4); i++) result.push_back(params[i]);
  return result;
}

json outline(FPDF_DOCUMENT doc) {
  auto first = FPDFBookmark_GetFirstChild(doc, nullptr);
  if (!first) return nullptr;
  std::unordered_set<FPDF_BOOKMARK> visited;
  size_t count = 0;
  std::function<json(FPDF_BOOKMARK, int)> walk = [&](FPDF_BOOKMARK current, int depth) -> json {
    require(depth <= 64, "Bookmark nesting exceeds its budget");
    json items = json::array();
    while (current) {
      // Malformed PDFs can make the next/child pointers circular.
      if (!visited.insert(current).second) break;
      require(++count <= 5000, "Bookmark count exceeds its budget");
      const auto length = FPDFBookmark_GetTitle(current, nullptr, 0);
      require(length <= 16384 && length % 2 == 0, "Bookmark title exceeds its budget");
      std::vector<uint16_t> units(length / 2);
      if (length) FPDFBookmark_GetTitle(current, units.data(), length);
      std::string title;
      for (size_t i = 0; i + 1 < units.size(); i++) {
        uint32_t scalar = units[i];
        if (scalar >= 0xd800 && scalar <= 0xdbff && i + 2 < units.size()
            && units[i + 1] >= 0xdc00 && units[i + 1] <= 0xdfff) {
          scalar = 0x10000 + ((scalar - 0xd800) << 10) + (units[++i] - 0xdc00);
        }
        title += utf8(scalar);
      }
      json item = {{"title", title}};
      auto action = FPDFBookmark_GetAction(current);
      auto dest = FPDFBookmark_GetDest(doc, current);
      if (!dest && action && FPDFAction_GetType(action) == PDFACTION_GOTO) dest = FPDFAction_GetDest(doc, action);
      if (dest) item["dest"] = destination(doc, dest);
      if (action && FPDFAction_GetType(action) == PDFACTION_URI) {
        const auto url_length = FPDFAction_GetURIPath(doc, action, nullptr, 0);
        if (url_length > 0 && url_length <= 32768) {
          std::vector<char> url(url_length);
          FPDFAction_GetURIPath(doc, action, url.data(), url_length);
          item["url"] = std::string(url.data(), url_length - 1);
        }
      }
      item["items"] = walk(FPDFBookmark_GetFirstChild(doc, current), depth + 1);
      items.push_back(std::move(item));
      current = FPDFBookmark_GetNextSibling(doc, current);
    }
    return items;
  };
  return walk(first, 0);
}

json text_content(Document& doc, const json& request) {
  const int index = integer(request, "pageIndex", 0, doc.count - 1);
  auto page = doc.page(index);
  auto text_page = FPDFText_LoadPage(page);
  if (!text_page) throw Failure("pdf/native-text", "PDFium could not extract this page's text");
  struct Closer { FPDF_TEXTPAGE handle; ~Closer() { FPDFText_ClosePage(handle); } } closer{text_page};
  const int chars = FPDFText_CountChars(text_page);
  require(chars >= 0 && chars <= 200000, "Text page exceeds the character budget");
  json runs = json::array();
  std::string value;
  FPDF_PAGEOBJECT owner = nullptr;
  std::array<double, 6> transform{};
  double width = 0, size = 0;
  std::vector<std::array<double, 3>> glyphs;
  bool positioned = true;
  auto flush = [&](bool eol) {
    if (!value.empty()) {
      json run = {{"str", value}, {"transform", transform}, {"width", std::max(0.0, width)},
        {"height", size}, {"hasEOL", eol}, {"dir", "ltr"}, {"fontName", "nativeSans"}};
      // One positioned glyph per Unicode scalar lets the browser's selectable
      // layer follow PDFium's advances instead of a substituted font's widths.
      if (positioned && glyphs.size() > 1) run["glyphs"] = glyphs;
      runs.push_back(std::move(run));
    }
    value.clear(); owner = nullptr; width = 0; glyphs.clear(); positioned = true;
  };
  for (int i = 0; i < chars; i++) {
    const auto cp = FPDFText_GetUnicode(text_page, i);
    if (cp == '\r' || cp == '\n') { flush(true); continue; }
    if (!cp || cp < 32) continue;
    // PDFium exposes supplementary characters as adjacent UTF-16 surrogates.
    // Combine them before UTF-8 encoding, while including both character boxes
    // in the text run's width and consuming both PDFium character indices.
    uint32_t scalar = cp;
    int last_char = i;
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < chars) {
      const auto low = FPDFText_GetUnicode(text_page, i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        scalar = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
        last_char = i + 1;
      }
    }
    auto object = FPDFText_GetTextObject(text_page, i);
    double x = 0, y = 0, l = 0, r = 0, b = 0, t = 0;
    FS_MATRIX m{1, 0, 0, 1, 0, 0};
    const bool has_origin = FPDFText_GetCharOrigin(text_page, i, &x, &y);
    const bool has_box = FPDFText_GetCharBox(text_page, i, &l, &r, &b, &t);
    FPDFText_GetMatrix(text_page, i, &m);
    auto font_size = FPDFText_GetFontSize(text_page, i);
    if (!std::isfinite(font_size) || font_size <= 0) font_size = std::max(1.0, t - b);
    if (!value.empty() && object && object != owner) flush(false);
    if (value.empty()) {
      size = font_size;
      transform = {m.a * size, m.b * size, m.c * size, m.d * size, x, y};
      owner = object;
    }
    value += utf8(scalar);
    const double nx = transform[0], ny = transform[1], norm = std::hypot(nx, ny);
    if (norm > 0) {
      const auto projection = [&](double px, double py) { return ((px - transform[4]) * nx + (py - transform[5]) * ny) / norm; };
      width = std::max({width, projection(l,b), projection(l,t), projection(r,b), projection(r,t)});
      if (last_char != i) {
        FPDFText_GetCharBox(text_page, last_char, &l, &r, &b, &t);
        width = std::max({width, projection(l,b), projection(l,t), projection(r,b), projection(r,t)});
      }
      const auto from_char = [&](double px, double py) { return ((px - x) * nx + (py - y) * ny) / norm; };
      const double box_width = has_box ? std::max({from_char(l,b), from_char(l,t), from_char(r,b), from_char(r,t)}) : 0;
      if (!glyphs.empty()) {
        // The previous character's selectable width ends at this origin.
        const double next = ((x - glyphs.back()[0]) * nx + (y - glyphs.back()[1]) * ny) / norm;
        if (std::isfinite(next) && next > 0) glyphs.back()[2] = next;
      }
      glyphs.push_back({x, y, std::max(0.01, box_width > 0 ? box_width : font_size * 0.4)});
    }
    positioned = positioned && has_origin && std::isfinite(x) && std::isfinite(y) && norm > 0
      && !glyphs.empty() && std::isfinite(glyphs.back()[2]);
    i = last_char;
    require(runs.size() < 10000, "Text page exceeds the text-run budget");
  }
  flush(false);
  json result = {{"items", runs}, {"styles", {{"nativeSans", {{"fontFamily", "sans-serif"}, {"ascent", 0.8},
    {"descent", -0.2}, {"vertical", false}}}}}, {"lang", nullptr}};
  // Preserve the existing text response for unusually dense pages instead of
  // crossing the worker's JSON frame limit just to add selection positions.
  if (result.dump().size() > max_json - 4096) for (auto& run : result["items"]) run.erase("glyphs");
  return result;
}

json page_links(Document& doc, const json& request) {
  const int index = integer(request, "pageIndex", 0, doc.count - 1);
  auto page = doc.page(index);
  json links = json::array();
  int pos = 0; FPDF_LINK link = nullptr;
  while (FPDFLink_Enumerate(page, &pos, &link)) {
    require(links.size() < 10000, "Link page exceeds its budget");
    FS_RECTF rect{};
    if (!FPDFLink_GetAnnotRect(link, &rect)) continue;
    json item = {{"id", "native-link-" + std::to_string(index) + "-" + std::to_string(pos)}, {"subtype", "Link"},
      {"rect", {std::min(rect.left,rect.right), std::min(rect.top,rect.bottom), std::max(rect.left,rect.right), std::max(rect.top,rect.bottom)}}};
    const int count = FPDFLink_CountQuadPoints(link);
    require(count >= 0 && count <= 4000, "Link quadrilaterals exceed their budget");
    if (count) {
      json quads = json::array();
      for (int q = 0; q < count; q++) {
        FS_QUADPOINTSF points{};
        if (FPDFLink_GetQuadPoints(link,q,&points)) for (auto n : {points.x1,points.y1,points.x2,points.y2,points.x3,points.y3,points.x4,points.y4}) quads.push_back(n);
      }
      if (!quads.empty()) item["quadPoints"] = std::move(quads);
    }
    auto dest = FPDFLink_GetDest(doc.handle, link);
    auto action = FPDFLink_GetAction(link);
    if (!dest && action && FPDFAction_GetType(action) == PDFACTION_GOTO) dest = FPDFAction_GetDest(doc.handle, action);
    if (dest) item["dest"] = destination(doc.handle, dest);
    if (action && FPDFAction_GetType(action) == PDFACTION_URI) {
      auto length = FPDFAction_GetURIPath(doc.handle, action, nullptr, 0);
      if (length > 0 && length <= 32768) {
        std::vector<char> url(length); FPDFAction_GetURIPath(doc.handle, action, url.data(), length);
        item["url"] = std::string(url.data(), length-1);
      }
    }
    links.push_back(item);
  }
  return links;
}

json inspect_page(Document& doc, const json& request) {
  const int index = integer(request, "pageIndex", 0, doc.count - 1);
  auto page = doc.page(index);
  const int count = FPDFPage_CountObjects(page);
  const int offset = integer(request, "offset", 0, std::max(0,count));
  const int limit = integer(request, "limit", 1, 100);
  json objects = json::array();
  for (int i = offset; i < count && i < offset + limit; i++) {
    auto object = FPDFPage_GetObject(page,i);
    float left=0,bottom=0,right=0,top=0;
    FPDFPageObj_GetBounds(object,&left,&bottom,&right,&top);
    objects.push_back({{"index",i},{"type",FPDFPageObj_GetType(object)},{"bounds",{left,bottom,right,top}},
      {"editable",false}});
  }
  return {{"objects",objects},{"nextOffset",offset+limit < count ? json(offset+limit) : json(nullptr)}};
}

json render_tile(Document& doc, const json& request, std::vector<unsigned char>& out) {
  const int index = integer(request, "pageIndex", 0, doc.count - 1);
  auto page = doc.page(index);
  const int w = integer(request,"width",1,max_tile), h = integer(request,"height",1,max_tile);
  const int full_w = integer(request,"rasterWidth",1,1048576), full_h = integer(request,"rasterHeight",1,1048576);
  const int x = integer(request,"x",-2,full_w), y = integer(request,"y",-2,full_h);
  const int rotation = integer(request,"rotation",0,270);
  require(rotation % 90 == 0 && x+w <= full_w+2 && y+h <= full_h+2, "Invalid native tile coordinates");
  require(!request.contains("annotations") || request["annotations"].is_boolean(), "Annotation flag must be boolean");
  const int flags = FPDF_REVERSE_BYTE_ORDER | (request.value("annotations",true) ? FPDF_ANNOT : 0);
  const double page_w = FPDF_GetPageWidthF(page), page_h = FPDF_GetPageHeightF(page);
  require(page_w > 0 && page_h > 0, "Native page geometry is invalid");
  const float sx = float((rotation % 180 ? full_h : full_w) / page_w);
  const float sy = float((rotation % 180 ? full_w : full_h) / page_h);
  FS_MATRIX matrix{};
  // PDFium first applies its intrinsic crop/rotation/display matrix. This is
  // an additional transform in that normalized top-left page space, without
  // a second Y flip (see pinned fpdf_view.cpp, WithMatrix implementation).
  if (rotation == 0) matrix = {sx,0,0,sy,float(-x),float(-y)};
  else if (rotation == 90) matrix = {0,sx,-sy,0,float(full_w-x),float(-y)};
  else if (rotation == 180) matrix = {-sx,0,0,-sy,float(full_w-x),float(full_h-y)};
  else matrix = {0,-sx,sy,0,float(-x),float(full_h-y)};
  out.assign(size_t(w)*h*4,255);
  Bitmap bitmap{FPDFBitmap_CreateEx(w,h,FPDFBitmap_BGRA,out.data(),w*4)};
  if (!bitmap.handle) throw Failure("pdf/native-bitmap", "PDFium bitmap allocation failed");
  FS_RECTF clip{0,0,float(w),float(h)};
  FPDF_RenderPageBitmapWithMatrix(bitmap.handle,page,&matrix,&clip,flags);
  if (doc.form) {
    // Form fields are document content even when a screenshot excludes markup
    // annotations. Offset PDFium's form layer by the tile origin so widget
    // appearances remain aligned across seams.
    FPDF_FFLDraw(doc.form, bitmap.handle, page, -x, -y, full_w, full_h, rotation / 90, flags);
  }
  return {{"width",w},{"height",h},{"format","rgba"}};
}

enum class Command { unknown, hello, open, close, text, outline, destination, links, inspect, render };

Command command_for(const json& request) {
  const auto name = request.at("command").get<std::string>();
  static constexpr std::array<std::pair<std::string_view, Command>, 9> commands{{
    {"hello", Command::hello}, {"open", Command::open}, {"close", Command::close},
    {"text", Command::text}, {"outline", Command::outline}, {"destination", Command::destination},
    {"links", Command::links}, {"inspect", Command::inspect}, {"render", Command::render},
  }};
  for (const auto& [label, command] : commands) if (label == name) return command;
  return Command::unknown;
}

json run(const json& request, std::vector<unsigned char>& payload, std::vector<unsigned char>& out) {
  switch (command_for(request)) {
  case Command::unknown:
    break;
  case Command::hello:
    return {{"protocolVersion", 1}, {"engine", "pdfium"}, {"build", "156.0.8076.0"}};
  case Command::open: {
    const auto id = id_for(request, "documentId");
    require(documents.size() < 32 || documents.count(id), "Native document limit reached");
    require(!payload.empty(), "PDF input bytes are required");
    auto doc = std::make_unique<Document>();
    doc->bytes = std::move(payload);
    doc->handle = FPDF_LoadMemDocument64(doc->bytes.data(), doc->bytes.size(), nullptr);
    if (!doc->handle) throw Failure("pdf/native-open", "PDFium could not open the document (error " + std::to_string(FPDF_GetLastError()) + ")");
    doc->count = FPDF_GetPageCount(doc->handle);
    require(doc->count > 0 && doc->count <= 100000, "Unsupported native page count");
    doc->formType = FPDF_GetFormType(doc->handle);
    doc->initializeForm();
    json result = {{"pageCount", doc->count}, {"formType", doc->formType},
      {"signatureCount", FPDF_GetSignatureCount(doc->handle)}};
    documents[id] = std::move(doc);
    return result;
  }
  case Command::close:
    documents.erase(id_for(request, "documentId"));
    return {{"closed", true}};
  case Command::text:
    return text_content(doc_for(request), request);
  case Command::outline:
    return outline(doc_for(request).handle);
  case Command::destination: {
    auto& doc = doc_for(request);
    return destination(doc.handle, FPDF_GetNamedDestByName(doc.handle, request.at("name").get<std::string>().c_str()));
  }
  case Command::links:
    return page_links(doc_for(request), request);
  case Command::inspect:
    return inspect_page(doc_for(request), request);
  case Command::render:
    return render_tile(doc_for(request), request, out);
  }
  throw Failure("pdf/native-request", "Unknown native command");
}

int main() {
#ifdef _WIN32
  _setmode(_fileno(stdin), _O_BINARY); _setmode(_fileno(stdout), _O_BINARY);
#endif
  std::ios::sync_with_stdio(false); std::cin.tie(nullptr);
  FPDF_InitLibrary();
  try {
    unsigned char prefix[8];
    while (std::cin.read(reinterpret_cast<char*>(prefix),8)) {
      const auto n = u32(prefix), b = u32(prefix+4);
      if (!n || n > max_json || b > max_payload) throw std::runtime_error("Invalid native frame length");
      std::string text(n,'\0'); std::vector<unsigned char> payload(b), output;
      if (!std::cin.read(text.data(),n) || (b && !std::cin.read(reinterpret_cast<char*>(payload.data()),b))) break;
      std::string request_id;
      try {
        auto request = json::parse(text);
        request_id = id_for(request,"requestId");
        auto value = run(request,payload,output);
        reply({{"requestId",request_id},{"ok",true},{"value",value}},output);
      } catch (const Failure& e) {
        reply({{"requestId",request_id},{"ok",false},{"error",{{"code",e.code},{"message",e.what()}}}});
      } catch (const std::exception&) {
        reply({{"requestId",request_id},{"ok",false},{"error",{{"code","pdf/native-request"},{"message","Invalid native command"}}}});
      }
    }
  } catch (const std::exception& e) { std::cerr << e.what() << '\n'; }
  documents.clear(); FPDF_DestroyLibrary();
  return 0;
}
