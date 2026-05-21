#include "HybridProtobuf.hpp"

#include "ProtobufCodec.hpp"
#include "ProtobufRegistry.hpp"
#include <stdexcept>

namespace margelo::nitro::nitroprotobuf {

std::shared_ptr<ArrayBuffer> HybridProtobuf::encode(const std::string& messageName, const std::shared_ptr<AnyMap>& message) {
  const MessageInfo* info = getMessageInfo(messageName);
  if (info == nullptr) {
    throw std::runtime_error("Unknown message: " + messageName);
  }
  return encodeMessage(*info, message);
}

std::shared_ptr<AnyMap> HybridProtobuf::decode(const std::string& messageName, const std::shared_ptr<ArrayBuffer>& data) {
  const MessageInfo* info = getMessageInfo(messageName);
  if (info == nullptr) {
    throw std::runtime_error("Unknown message: " + messageName);
  }
  return decodeMessage(*info, data);
}

double HybridProtobuf::byteLength(const std::string& messageName, const std::shared_ptr<AnyMap>& message) {
  const MessageInfo* info = getMessageInfo(messageName);
  if (info == nullptr) {
    throw std::runtime_error("Unknown message: " + messageName);
  }
  return static_cast<double>(encodedByteLength(*info, message));
}

std::vector<std::string> HybridProtobuf::listMessages() {
  return getMessageNames();
}

} // namespace margelo::nitro::nitroprotobuf
