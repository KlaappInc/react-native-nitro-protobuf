#include "Base64.hpp"

#include <stdexcept>

namespace margelo::nitro::nitroprotobuf {

namespace {
constexpr char kEncodeTable[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

int decodeChar(char value) {
  if (value >= 'A' && value <= 'Z') return value - 'A';
  if (value >= 'a' && value <= 'z') return value - 'a' + 26;
  if (value >= '0' && value <= '9') return value - '0' + 52;
  if (value == '+') return 62;
  if (value == '/') return 63;
  return -1;
}
} // namespace

std::string base64Encode(const uint8_t* data, size_t length) {
  if (length == 0) {
    return {};
  }

  std::string output;
  output.reserve(((length + 2) / 3) * 4);

  for (size_t i = 0; i < length; i += 3) {
    const uint32_t b0 = data[i];
    const uint32_t b1 = (i + 1 < length) ? data[i + 1] : 0;
    const uint32_t b2 = (i + 2 < length) ? data[i + 2] : 0;
    const uint32_t triple = (b0 << 16) | (b1 << 8) | b2;

    output.push_back(kEncodeTable[(triple >> 18) & 0x3F]);
    output.push_back(kEncodeTable[(triple >> 12) & 0x3F]);
    output.push_back((i + 1 < length) ? kEncodeTable[(triple >> 6) & 0x3F] : '=');
    output.push_back((i + 2 < length) ? kEncodeTable[triple & 0x3F] : '=');
  }

  return output;
}

std::vector<uint8_t> base64Decode(const std::string& input) {
  std::vector<uint8_t> output;
  output.reserve((input.size() / 4) * 3);

  int buffer = 0;
  int bits = -8;

  for (char value : input) {
    if (value == '\r' || value == '\n' || value == ' ' || value == '\t') {
      continue;
    }
    if (value == '=') {
      break;
    }
    const int decoded = decodeChar(value);
    if (decoded < 0) {
      throw std::runtime_error("Invalid base64 character");
    }
    buffer = (buffer << 6) | decoded;
    bits += 6;
    if (bits >= 0) {
      output.push_back(static_cast<uint8_t>((buffer >> bits) & 0xFF));
      bits -= 8;
    }
  }

  return output;
}

} // namespace margelo::nitro::nitroprotobuf
