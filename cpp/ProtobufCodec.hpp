#pragma once

#include <NitroModules/ArrayBuffer.hpp>
#include <NitroModules/AnyMap.hpp>
#include "ProtobufRegistry.hpp"
#include <memory>

namespace margelo::nitro::nitroprotobuf {

std::shared_ptr<ArrayBuffer> encodeMessage(const MessageInfo& info, const std::shared_ptr<AnyMap>& message);
std::shared_ptr<AnyMap> decodeMessage(const MessageInfo& info, const std::shared_ptr<ArrayBuffer>& data);

// Encoded byte length of `message` without allocating the output buffer
// (validates + populates the struct, then nanopb's pb_get_encoded_size).
size_t encodedByteLength(const MessageInfo& info, const std::shared_ptr<AnyMap>& message);

} // namespace margelo::nitro::nitroprotobuf
