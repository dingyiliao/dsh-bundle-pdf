#pragma once

struct SavedPdfWriter : FPDF_FILEWRITE {
  std::vector<unsigned char> bytes;
  const size_t capacity;
  bool limited = false;
  explicit SavedPdfWriter(size_t max_size) : FPDF_FILEWRITE{1, &SavedPdfWriter::append}, capacity(max_size) {}
  static int append(FPDF_FILEWRITE* writer, const void* data, unsigned long length) noexcept {
    auto& result = *static_cast<SavedPdfWriter*>(writer);
    if (length > result.capacity - result.bytes.size()) {
      result.limited = true;
      return 0;
    }
    try {
      const auto* start = static_cast<const unsigned char*>(data);
      result.bytes.insert(result.bytes.end(), start, start + length);
      return 1;
    } catch (...) { return 0; }
  }
};

json save_document_copy(Document& doc, const json& request) {
  if (!can_edit_plain_document(doc)) require_protected_annotation_access(doc);
  doc.metadata.clear_fingerprints();
  doc.saved.clear();
  const auto limit = request.contains("maxBytes") ? integer(request, "maxBytes", 1, max_saved_pdf) : max_saved_pdf;
  SavedPdfWriter result(limit);
  // Do not pass either of the PDFium flags that remove document security.
  if (!FPDF_SaveAsCopy(doc.handle, &result, FPDF_NO_INCREMENTAL) || result.bytes.empty()) {
    throw Failure(result.limited ? "pdf/native-size" : "pdf/native-save",
      result.limited ? "Protected PDF output exceeds the native save budget" : "PDFium could not save the protected copy");
  }
  doc.saved = std::move(result.bytes);
  return {{"size", doc.saved.size()}};
}

json read_saved_chunk(Document& doc, const json& request, std::vector<unsigned char>& out) {
  const int size = static_cast<int>(doc.saved.size());
  require(size > 0, "No saved protected PDF is available");
  const int offset = integer(request, "offset", 0, size - 1);
  const int length = integer(request, "length", 1, std::min<int>(max_reply_payload, size - offset));
  out.assign(doc.saved.begin() + offset, doc.saved.begin() + offset + length);
  return {{"offset", offset}, {"size", size}};
}

