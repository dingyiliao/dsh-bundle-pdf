#include "worker/worker-runtime.h"

#include <iostream>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

namespace dsh_pdf {
namespace {

uint32_t read_u32(const unsigned char* p) {
  return uint32_t(p[0]) | (uint32_t(p[1]) << 8) |
         (uint32_t(p[2]) << 16) | (uint32_t(p[3]) << 24);
}

void write_u32(unsigned char* p, uint32_t n) {
  for (unsigned i = 0; i < 4; ++i) {
    p[i] = static_cast<unsigned char>(n >> (i * 8));
  }
}

void write_reply(const nlohmann::json& value,
                 const std::vector<unsigned char>& payload = {}) {
  const auto text = value.dump();
  if (text.size() > max_json || payload.size() > max_reply_payload) {
    throw Failure("pdf/native-reply-too-large",
                  "Native reply exceeds protocol limit");
  }
  unsigned char prefix[8];
  write_u32(prefix, static_cast<uint32_t>(text.size()));
  write_u32(prefix + 4, static_cast<uint32_t>(payload.size()));
  std::cout.write(reinterpret_cast<const char*>(prefix), 8);
  std::cout.write(text.data(), static_cast<std::streamsize>(text.size()));
  if (!payload.empty()) {
    std::cout.write(reinterpret_cast<const char*>(payload.data()),
                    static_cast<std::streamsize>(payload.size()));
  }
  std::cout.flush();
}

}  // namespace

int run_worker(const BackendExecutor& execute) {
#ifdef _WIN32
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
#endif
  std::ios::sync_with_stdio(false);
  std::cin.tie(nullptr);

  unsigned char prefix[8];
  while (std::cin.read(reinterpret_cast<char*>(prefix), 8)) {
    const auto json_size = read_u32(prefix);
    const auto payload_size = read_u32(prefix + 4);
    if (!json_size || json_size > max_json || payload_size > max_payload) {
      throw std::runtime_error("Invalid native frame length");
    }
    std::string text(json_size, '\0');
    std::vector<unsigned char> payload(payload_size);
    std::vector<unsigned char> output;
    if (!std::cin.read(text.data(), static_cast<std::streamsize>(json_size)) ||
        (payload_size && !std::cin.read(
            reinterpret_cast<char*>(payload.data()),
            static_cast<std::streamsize>(payload_size)))) {
      break;
    }
    std::string request_id;
    try {
      const auto request = nlohmann::json::parse(text);
      if (!request.contains("requestId") ||
          !request["requestId"].is_string()) {
        throw Failure("pdf/native-request", "Request identity is required");
      }
      request_id = request["requestId"].get<std::string>();
      const auto value = execute(request, payload, output);
      write_reply({{"requestId", request_id}, {"ok", true}, {"value", value}},
                  output);
    } catch (const Failure& error) {
      write_reply({{"requestId", request_id}, {"ok", false},
                   {"error", {{"code", error.code},
                               {"message", error.what()}}}});
    } catch (const std::exception&) {
      write_reply({{"requestId", request_id}, {"ok", false},
                   {"error", {{"code", "pdf/native-request"},
                               {"message", "Invalid native command"}}}});
    }
  }
  return 0;
}

}  // namespace dsh_pdf
