#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace margelo::nitro::nitroprotobuf {

std::string base64Encode(const uint8_t* data, size_t length);
std::vector<uint8_t> base64Decode(const std::string& input);

} // namespace margelo::nitro::nitroprotobuf
