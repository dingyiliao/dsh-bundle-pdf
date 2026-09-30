// All PDFium calls run on this process's one command loop. No Host paths or
// native pointers cross the protocol. Input PDF bytes remain alive with a handle.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <unordered_map>
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
struct Document {
  std::vector<unsigned char> bytes;
  FPDF_DOCUMENT handle = nullptr;
  int count = 0;
  uint64_t clock = 0;
  std::unordered_map<int, std::unique_ptr<Page>> pages;
  ~Document() { pages.clear(); if (handle) FPDF_CloseDocument(handle); }
  FPDF_PAGE page(int index) {
    require(index >= 0 && index < count, "Page index is outside the document");
    auto found = pages.find(index);
    if (found != pages.end()) { found->second->used = ++clock; return found->second->handle; }
    if (pages.size() >= 16) {
      auto oldest = std::min_element(pages.begin(), pages.end(), [](const auto& a, const auto& b) {
        return a.second->used < b.second->used;
      });
      pages.erase(oldest);
    }
    auto handle = FPDF_LoadPage(this->handle, index);
    if (!handle) throw Failure("pdf/native-page", "PDFium could not load the requested page");
    auto owned = std::make_unique<Page>(handle);
    owned->used = ++clock;
    pages.emplace(index, std::move(owned));
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
  if (text.size() > max_json || payload.size() > 8 * 1024 * 1024) throw std::runtime_error("Native reply exceeds protocol limit");
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
  auto flush = [&](bool eol) {
    if (!value.empty()) runs.push_back({{"str", value}, {"transform", transform}, {"width", std::max(0.0, width)},
      {"height", size}, {"hasEOL", eol}, {"dir", "ltr"}, {"fontName", "nativeSans"}});
    value.clear(); owner = nullptr; width = 0;
  };
  for (int i = 0; i < chars; i++) {
    const auto cp = FPDFText_GetUnicode(text_page, i);
    if (cp == '\r' || cp == '\n') { flush(true); continue; }
    if (!cp || cp < 32) continue;
    auto object = FPDFText_GetTextObject(text_page, i);
    double x = 0, y = 0, l = 0, r = 0, b = 0, t = 0;
    FS_MATRIX m{1, 0, 0, 1, 0, 0};
    FPDFText_GetCharOrigin(text_page, i, &x, &y);
    FPDFText_GetCharBox(text_page, i, &l, &r, &b, &t);
    FPDFText_GetMatrix(text_page, i, &m);
    auto font_size = FPDFText_GetFontSize(text_page, i);
    if (!std::isfinite(font_size) || font_size <= 0) font_size = std::max(1.0, t - b);
    if (!value.empty() && object && object != owner) flush(false);
    if (value.empty()) {
      size = font_size;
      transform = {m.a * size, m.b * size, m.c * size, m.d * size, x, y};
      owner = object;
    }
    value += utf8(cp);
    const double nx = transform[0], ny = transform[1], norm = std::hypot(nx, ny);
    if (norm > 0) {
      const auto projection = [&](double px, double py) { return ((px - transform[4]) * nx + (py - transform[5]) * ny) / norm; };
      width = std::max({width, projection(l,b), projection(l,t), projection(r,b), projection(r,t)});
    }
    require(runs.size() < 10000, "Text page exceeds the text-run budget");
  }
  flush(false);
  return {{"items", runs}, {"styles", {{"nativeSans", {{"fontFamily", "sans-serif"}, {"ascent", 0.8},
    {"descent", -0.2}, {"vertical", false}}}}}, {"lang", nullptr}};
}

json run(const json& request, std::vector<unsigned char>& payload, std::vector<unsigned char>& out) {
  auto command = request.at("command").get<std::string>();
  if (command == "hello") return {{"protocolVersion", 1}, {"engine", "pdfium"}, {"build", "156.0.8076.0"}};
  if (command == "open") {
    const auto id = id_for(request, "documentId");
    require(documents.size() < 32 || documents.count(id), "Native document limit reached");
    require(!payload.empty(), "PDF input bytes are required");
    auto doc = std::make_unique<Document>();
    doc->bytes = std::move(payload);
    doc->handle = FPDF_LoadMemDocument64(doc->bytes.data(), doc->bytes.size(), nullptr);
    if (!doc->handle) throw Failure("pdf/native-open", "PDFium could not open the document (error " + std::to_string(FPDF_GetLastError()) + ")");
    doc->count = FPDF_GetPageCount(doc->handle);
    require(doc->count > 0 && doc->count <= 100000, "Unsupported native page count");
    json result = {{"pageCount", doc->count}, {"formType", FPDF_GetFormType(doc->handle)},
      {"signatureCount", FPDF_GetSignatureCount(doc->handle)}};
    documents[id] = std::move(doc);
    return result;
  }
  if (command == "close") { documents.erase(id_for(request, "documentId")); return {{"closed", true}}; }
  auto& doc = doc_for(request);
  if (command == "text") return text_content(doc, request);
  if (command == "destination") return destination(doc.handle, FPDF_GetNamedDestByName(doc.handle, request.at("name").get<std::string>().c_str()));
  const int index = integer(request, "pageIndex", 0, doc.count - 1);
  auto page = doc.page(index);
  if (command == "links") {
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
  if (command == "inspect") {
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
  require(command == "render", "Unknown native command");
  const int w = integer(request,"width",1,max_tile), h = integer(request,"height",1,max_tile);
  const int full_w = integer(request,"rasterWidth",1,1048576), full_h = integer(request,"rasterHeight",1,1048576);
  const int x = integer(request,"x",-2,full_w), y = integer(request,"y",-2,full_h);
  const int rotation = integer(request,"rotation",0,270);
  require(rotation % 90 == 0 && x+w <= full_w+2 && y+h <= full_h+2, "Invalid native tile coordinates");
  const double page_w = FPDF_GetPageWidthF(page), page_h = FPDF_GetPageHeightF(page);
  require(page_w > 0 && page_h > 0, "Native page geometry is invalid");
  const float sx = float((rotation % 180 ? full_h : full_w) / page_w);
  const float sy = float((rotation % 180 ? full_w : full_h) / page_h);
  FS_MATRIX matrix{};
  // PDFium first applies its intrinsic crop/rotation/display matrix. This is
  // an additional transform in that normalized top-left page space, not a
  // second PDF.js Y flip (see pinned fpdf_view.cpp, WithMatrix implementation).
  if (rotation == 0) matrix = {sx,0,0,sy,float(-x),float(-y)};
  else if (rotation == 90) matrix = {0,sx,-sy,0,float(full_w-x),float(-y)};
  else if (rotation == 180) matrix = {-sx,0,0,-sy,float(full_w-x),float(full_h-y)};
  else matrix = {0,-sx,sy,0,float(-x),float(full_h-y)};
  out.assign(size_t(w)*h*4,255);
  auto bitmap = FPDFBitmap_CreateEx(w,h,FPDFBitmap_BGRA,out.data(),w*4);
  if (!bitmap) throw Failure("pdf/native-bitmap", "PDFium bitmap allocation failed");
  FPDFBitmap_FillRect(bitmap,0,0,w,h,0xffffffff);
  FS_RECTF clip{0,0,float(w),float(h)};
  const int flags = FPDF_REVERSE_BYTE_ORDER | (request.value("annotations",true) ? FPDF_ANNOT : 0);
  FPDF_RenderPageBitmapWithMatrix(bitmap,page,&matrix,&clip,flags);
  FPDFBitmap_Destroy(bitmap);
  return {{"width",w},{"height",h},{"format","rgba"}};
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
