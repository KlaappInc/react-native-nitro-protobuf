#pragma once

#include "HybridProtobufSpec.hpp"

namespace margelo::nitro::nitroprotobuf {

class HybridProtobuf : public HybridProtobufSpec {
public:
  HybridProtobuf() : HybridObject(TAG) {}

  std::shared_ptr<ArrayBuffer> encode(const std::string& messageName, const std::shared_ptr<AnyMap>& message) override;
  std::shared_ptr<AnyMap> decode(const std::string& messageName, const std::shared_ptr<ArrayBuffer>& data) override;
  double byteLength(const std::string& messageName, const std::shared_ptr<AnyMap>& message) override;
  std::vector<std::string> listMessages() override;
};

} // namespace margelo::nitro::nitroprotobuf
