#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

struct pb_msgdesc_s;

namespace margelo::nitro::nitroprotobuf {

enum class FieldType {
  Bool,
  Int32,
  Int64,
  UInt32,
  UInt64,
  SInt32,
  SInt64,
  Fixed32,
  Fixed64,
  SFixed32,
  SFixed64,
  Float,
  Double,
  String,
  Bytes,
  Enum,
  Message,
};

struct FieldInfo {
  const char* name;
  uint32_t tag;
  FieldType type;
  bool repeated;
  bool is_oneof;
  bool is_map;
  const char* type_name;
};

struct MessageInfo {
  const char* name;
  const pb_msgdesc_s* descriptor;
  size_t struct_size;
  const FieldInfo* fields;
  size_t field_count;
  void (*init_default)(void*);
};

const MessageInfo* getMessageInfo(const std::string& name);
const MessageInfo* getMessageInfo(const pb_msgdesc_s* descriptor);
std::vector<std::string> getMessageNames();
const FieldInfo* findFieldByName(const MessageInfo& message, const std::string& name);

} // namespace margelo::nitro::nitroprotobuf
