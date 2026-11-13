#pragma once

#include <vector>

#include "json.hpp"

namespace dsh_pdf {

/**
 * Process-independent boundary for PDF behavior. The worker owns framing and
 * lifecycle; a backend owns document facts and mutations. The current backend
 * is PDFium, but another implementation can satisfy this contract without
 * changing the Node.js transport or command loop.
 */
class PdfBackend {
 public:
  virtual ~PdfBackend() = default;
  virtual nlohmann::json execute(const nlohmann::json& request,
                                 std::vector<unsigned char>& payload,
                                 std::vector<unsigned char>& output) = 0;
};

}  // namespace dsh_pdf
