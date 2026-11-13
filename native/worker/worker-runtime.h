#pragma once

#include <cstdint>
#include <functional>
#include <stdexcept>
#include <string>
#include <vector>

#include "json.hpp"

namespace dsh_pdf {

constexpr uint32_t max_json = 2 * 1024 * 1024;
constexpr uint32_t max_payload = 256 * 1024 * 1024;
constexpr uint32_t max_reply_payload = 8 * 1024 * 1024;

struct Failure : std::runtime_error {
  std::string code;
  Failure(std::string c, std::string m)
      : std::runtime_error(std::move(m)), code(std::move(c)) {}
};

using BackendExecutor = std::function<nlohmann::json(
    const nlohmann::json&, std::vector<unsigned char>&,
    std::vector<unsigned char>&)>;

int run_worker(const BackendExecutor& execute);

}  // namespace dsh_pdf
