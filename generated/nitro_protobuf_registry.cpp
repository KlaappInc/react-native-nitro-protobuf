// This file is auto-generated. Do not edit.
#include "../cpp/ProtobufRegistry.hpp"
#include "example.pb.h"

namespace margelo::nitro::nitroprotobuf {

static void init_default_acme_Address(void* message) {
  *static_cast<acme_Address*>(message) = acme_Address_init_default;
}

static const FieldInfo k_acme_Address_fields[] = {
  {"street", 1, FieldType::String, false, false, false, nullptr},
  {"zip", 2, FieldType::UInt32, false, false, false, nullptr},
};

static void init_default_acme_User(void* message) {
  *static_cast<acme_User*>(message) = acme_User_init_default;
}

static const FieldInfo k_acme_User_fields[] = {
  {"id", 1, FieldType::UInt32, false, false, false, nullptr},
  {"name", 2, FieldType::String, false, false, false, nullptr},
  {"avatar", 3, FieldType::Bytes, false, false, false, nullptr},
  {"scores", 4, FieldType::Int32, true, false, false, nullptr},
  {"active", 5, FieldType::Bool, false, false, false, nullptr},
  {"address", 6, FieldType::Message, false, false, false, ".acme.Address"},
  {"tags", 7, FieldType::String, true, false, false, nullptr},
  {"delta", 8, FieldType::Int64, false, false, false, nullptr},
  {"big", 9, FieldType::UInt64, false, false, false, nullptr},
  {"ratio", 10, FieldType::Float, false, false, false, nullptr},
  {"weight", 11, FieldType::Double, false, false, false, nullptr},
};

static const MessageInfo kMessages[] = {
  {"acme.Address", &acme_Address_msg, sizeof(acme_Address), k_acme_Address_fields, sizeof(k_acme_Address_fields) / sizeof(k_acme_Address_fields[0]), init_default_acme_Address},
  {"acme.User", &acme_User_msg, sizeof(acme_User), k_acme_User_fields, sizeof(k_acme_User_fields) / sizeof(k_acme_User_fields[0]), init_default_acme_User},
};

const MessageInfo* getMessageInfo(const std::string& name) {
  for (const auto& message : kMessages) {
    if (name == message.name) {
      return &message;
    }
  }
  return nullptr;
}

const MessageInfo* getMessageInfo(const pb_msgdesc_s* descriptor) {
  for (const auto& message : kMessages) {
    if (descriptor == message.descriptor) {
      return &message;
    }
  }
  return nullptr;
}

std::vector<std::string> getMessageNames() {
  std::vector<std::string> names;
  names.reserve(sizeof(kMessages) / sizeof(kMessages[0]));
  for (const auto& message : kMessages) {
    names.emplace_back(message.name);
  }
  return names;
}

const FieldInfo* findFieldByName(const MessageInfo& message, const std::string& name) {
  for (size_t i = 0; i < message.field_count; i++) {
    const FieldInfo& field = message.fields[i];
    if (name == field.name) {
      return &field;
    }
  }
  return nullptr;
}

} // namespace margelo::nitro::nitroprotobuf
