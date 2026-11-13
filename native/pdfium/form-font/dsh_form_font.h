#ifndef FPDFSDK_DSH_FORM_FONT_H_
#define FPDFSDK_DSH_FORM_FONT_H_

#include <stdint.h>

#include <set>
#include <vector>

#include "core/fxcrt/retain_ptr.h"
#include "core/fxcrt/span.h"

class CPDF_Document;
class CPDF_Font;

// Adds one portable CID font subset shared by all edited widgets. Keeps the
// native widget formatter's existing layout, clipping, borders and alignment.
class ScopedDshFormFont {
 public:
  ScopedDshFormFont();
  ~ScopedDshFormFont();
  ScopedDshFormFont(const ScopedDshFormFont&) = delete;
  ScopedDshFormFont& operator=(const ScopedDshFormFont&) = delete;

  bool Initialize(CPDF_Document* document,
                  pdfium::span<const uint8_t> font_data,
                  const std::set<uint32_t>& characters);

 private:
  RetainPtr<CPDF_Font> font_;
  std::vector<uint32_t> supplementary_;
  bool active_ = false;
};

#endif  // FPDFSDK_DSH_FORM_FONT_H_
