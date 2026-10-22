// Exercise PDFium's required form callbacks without adding a test command to
// the shipped native protocol. This translation unit is built only by the
// native coverage runner.
#define main dsh_pdf_native_worker_main
#include "pdfium-worker.cpp"
#undef main

#include <fstream>
#include <iterator>

int main(int argc, char** argv) {
  if (argc != 2) return 1;
  std::ifstream input(argv[1], std::ios::binary);
  if (!input) return 2;
  const std::vector<char> fixture(std::istreambuf_iterator<char>{input}, {});
  if (fixture.empty()) return 3;

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
