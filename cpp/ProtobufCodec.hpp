#pragma once

#include "ArrayBuffer.hpp"
#include "AnyMap.hpp"
#include "ProtobufRegistry.hpp"
#include <memory>

namespace margelo::nitro::nitroprotobuf {

std::shared_ptr<ArrayBuffer> encodeMessage(const MessageInfo& info, const std::shared_ptr<AnyMap>& message);
std::shared_ptr<AnyMap> decodeMessage(const MessageInfo& info, const std::shared_ptr<ArrayBuffer>& data);

} // namespace margelo::nitro::nitroprotobuf
