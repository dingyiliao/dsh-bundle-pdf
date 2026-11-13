// Exercise native worker internals without adding a test command to the
// shipped protocol. This translation unit is built only by the coverage runner.
#define main dsh_pdf_native_worker_main
#include "backend/pdfium/pdfium-worker.cpp"
#undef main

#include <fstream>
#include <iterator>
#include <limits>

bool rejects_geometry(bool has_bounds, int rotation, float width, float height, const char* message) {
  try { validate_document_page_geometry(has_bounds, rotation, width, height); }
  catch (const Failure& error) {
    return error.code == "pdf/native-document-info" && std::string_view(error.what()) == message;
  }
  return false;
}

int main(int argc, char** argv) {
  if (argc != 2) return 1;
  std::ifstream input(argv[1], std::ios::binary);
  if (!input) return 2;
  const std::vector<char> fixture(std::istreambuf_iterator<char>{input}, {});
  if (fixture.empty()) return 3;

  // PDFium usually normalizes malformed page dictionaries before these API
  // results reach the worker. Test each invalid result at that boundary.
  if (!rejects_geometry(false, 0, 300, 400, "PDFium could not read a page's effective bounds")
    || !rejects_geometry(true, -1, 300, 400, "PDFium could not read a page rotation")
    || !rejects_geometry(true, 4, 300, 400, "PDFium could not read a page rotation")
    || !rejects_geometry(true, 0, 0, 400, "PDFium could not read a page display size")
    || !rejects_geometry(true, 0, std::numeric_limits<float>::infinity(), 400,
      "PDFium could not read a page display size")
    || !rejects_geometry(true, 0, 300, -1, "PDFium could not read a page display size")
    || !rejects_geometry(true, 0, 300, std::numeric_limits<float>::quiet_NaN(),
      "PDFium could not read a page display size")) return 7;

  FPDF_InitLibrary();
  int result = 0;
  {
    Document document;
    document.bytes.assign(fixture.begin(), fixture.end());
    document.handle = FPDF_LoadMemDocument(document.bytes.data(), static_cast<int>(document.bytes.size()), nullptr);
    if (!document.handle) result = 4;
    else {
      document.count = FPDF_GetPageCount(document.handle);
      document.formType = FPDF_GetFormType(document.handle);
      if (document.count != 1 || document.formType != FORMTYPE_ACRO_FORM) result = 5;
      else {
        document.initializeForm();
        auto* callbacks = &document.formHost.callbacks;
        callbacks->FFI_Invalidate(callbacks, nullptr, 0, 0, 0, 0);
        const auto page = callbacks->FFI_GetPage(callbacks, document.handle, 0);
        if (!page || callbacks->FFI_GetRotation(callbacks, page) != 0
          || callbacks->FFI_GetPage(callbacks, nullptr, 0) != nullptr
          || callbacks->FFI_GetPage(callbacks, document.handle, -1) != nullptr) result = 6;
      }
    }
  }
  FPDF_DestroyLibrary();
  return result;
}
