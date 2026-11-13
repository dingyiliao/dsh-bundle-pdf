#include <string>

#include "json.hpp"
#include "worker-runtime.cpp"

// Exercise the reply-size guard without exposing a test-only command in the
// production worker. The binary is built only by the coverage runner.
int main() {
  try {
    dsh_pdf::write_reply({{"value", std::string(3 * 1024 * 1024, 'x')}});
    return 2;
  } catch (const dsh_pdf::Failure& error) {
    return error.code == "pdf/native-reply-too-large" ? 0 : 3;
  }
}
