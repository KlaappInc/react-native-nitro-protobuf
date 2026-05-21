#include "ProtobufCodec.hpp"

#include "Base64.hpp"
#include "nanopb/pb_common.h"
#include "nanopb/pb_decode.h"
#include "nanopb/pb_encode.h"
#include <cctype>
#include <cstddef>
#include <cstring>
#include <stdexcept>
#include <string_view>
#include <unordered_map>
#include <utility>

namespace margelo::nitro::nitroprotobuf {

using AnyObject = std::unordered_map<std::string, AnyValue>;

namespace {

// O(1) field lookup. findFieldByName (registry) is linear, so populateMessage
// was O(fields x entries). Build a name -> FieldInfo index once per descriptor.
// thread_local (no locking): encode/decode are JS-thread-only by contract, and
// FieldInfo::name has static storage so string_view keys stay valid.
const FieldInfo* findFieldCached(const MessageInfo& info, const std::string& name) {
  thread_local std::unordered_map<const pb_msgdesc_s*,
                                  std::unordered_map<std::string_view, const FieldInfo*>>
      cache;
  auto& index = cache[info.descriptor];
  if (index.empty() && info.field_count > 0) {
    index.reserve(info.field_count);
    for (size_t i = 0; i < info.field_count; i++) {
      index.emplace(std::string_view(info.fields[i].name), &info.fields[i]);
    }
  }
  const auto it = index.find(std::string_view(name));
  return it != index.end() ? it->second : nullptr;
}

// Parse a numeric string fully: no leftover (non-space) chars, no exception
// leak, range-checked. Returns false on any failure so callers keep their
// bool-return contract instead of letting an STL exception escape.
bool parseFullDouble(const std::string& s, double& out) {
  try {
    size_t pos = 0;
    double v = std::stod(s, &pos);
    while (pos < s.size() && std::isspace(static_cast<unsigned char>(s[pos]))) pos++;
    if (pos != s.size()) return false;
    out = v;
    return true;
  } catch (const std::exception&) {
    return false;
  }
}

bool parseFullInt64(const std::string& s, int64_t& out) {
  try {
    size_t pos = 0;
    long long v = std::stoll(s, &pos);
    while (pos < s.size() && std::isspace(static_cast<unsigned char>(s[pos]))) pos++;
    if (pos != s.size()) return false;
    out = static_cast<int64_t>(v);
    return true;
  } catch (const std::exception&) {
    return false;
  }
}

bool parseFullUInt64(const std::string& s, uint64_t& out) {
  try {
    size_t lead = 0;
    while (lead < s.size() && std::isspace(static_cast<unsigned char>(s[lead]))) lead++;
    if (lead < s.size() && s[lead] == '-') return false; // stoull wraps negatives
    size_t pos = 0;
    unsigned long long v = std::stoull(s, &pos);
    while (pos < s.size() && std::isspace(static_cast<unsigned char>(s[pos]))) pos++;
    if (pos != s.size()) return false;
    out = static_cast<uint64_t>(v);
    return true;
  } catch (const std::exception&) {
    return false;
  }
}

std::string toFieldPath(const MessageInfo& message, const FieldInfo& field) {
  return std::string(message.name) + "." + field.name;
}

void ensureSupportedField(const MessageInfo& message, const FieldInfo& field, const pb_field_iter_t& iter) {
  if (field.is_map) {
    throw std::runtime_error("Map fields are not supported: " + toFieldPath(message, field));
  }
  if (PB_ATYPE(iter.type) != PB_ATYPE_STATIC) {
    throw std::runtime_error("Only static nanopb fields are supported: " + toFieldPath(message, field));
  }
  if (PB_LTYPE(iter.type) == PB_LTYPE_SUBMSG_W_CB) {
    throw std::runtime_error("Callback submessages are not supported: " + toFieldPath(message, field));
  }
}

bool isNullValue(const AnyValue& value) {
  return std::holds_alternative<NullType>(value);
}

bool getBoolValue(const AnyValue& value, bool& out) {
  if (const auto* v = std::get_if<bool>(&value)) {
    out = *v;
    return true;
  }
  return false;
}

bool getDoubleValue(const AnyValue& value, double& out) {
  if (const auto* v = std::get_if<double>(&value)) {
    out = *v;
    return true;
  }
  if (const auto* v = std::get_if<int64_t>(&value)) {
    out = static_cast<double>(*v);
    return true;
  }
  if (const auto* v = std::get_if<std::string>(&value)) {
    return parseFullDouble(*v, out);
  }
  return false;
}

bool getInt64Value(const AnyValue& value, int64_t& out) {
  if (const auto* v = std::get_if<int64_t>(&value)) {
    out = *v;
    return true;
  }
  if (const auto* v = std::get_if<double>(&value)) {
    out = static_cast<int64_t>(*v);
    return true;
  }
  if (const auto* v = std::get_if<std::string>(&value)) {
    return parseFullInt64(*v, out);
  }
  return false;
}

bool getUInt64Value(const AnyValue& value, uint64_t& out) {
  if (const auto* v = std::get_if<int64_t>(&value)) {
    if (*v < 0) return false;
    out = static_cast<uint64_t>(*v);
    return true;
  }
  if (const auto* v = std::get_if<double>(&value)) {
    if (*v < 0) return false;
    out = static_cast<uint64_t>(*v);
    return true;
  }
  if (const auto* v = std::get_if<std::string>(&value)) {
    return parseFullUInt64(*v, out);
  }
  return false;
}

bool getStringValue(const AnyValue& value, std::string& out) {
  if (const auto* v = std::get_if<std::string>(&value)) {
    out = *v;
    return true;
  }
  return false;
}

bool getArrayValue(const AnyValue& value, AnyArray& out) {
  if (const auto* v = std::get_if<AnyArray>(&value)) {
    out = *v;
    return true;
  }
  return false;
}

bool getObjectValue(const AnyValue& value, AnyObject& out) {
  if (const auto* v = std::get_if<AnyObject>(&value)) {
    out = *v;
    return true;
  }
  return false;
}

std::vector<uint8_t> getBytesValue(const AnyValue& value) {
  if (const auto* v = std::get_if<std::string>(&value)) {
    return base64Decode(*v);
  }
  if (const auto* v = std::get_if<AnyArray>(&value)) {
    std::vector<uint8_t> bytes;
    bytes.reserve(v->size());
    for (const auto& item : *v) {
      double number = 0;
      if (const auto* d = std::get_if<double>(&item)) {
        number = *d;
      } else if (const auto* i = std::get_if<int64_t>(&item)) {
        number = static_cast<double>(*i);
      } else {
        throw std::runtime_error("Byte array elements must be numbers");
      }
      if (number < 0 || number > 255) {
        throw std::runtime_error("Byte array elements must be in range [0, 255]");
      }
      bytes.push_back(static_cast<uint8_t>(number));
    }
    return bytes;
  }
  throw std::runtime_error("Bytes fields must be base64 strings or number arrays");
}

template <typename T>
void writeScalar(void* dest, T value) {
  std::memcpy(dest, &value, sizeof(T));
}

template <typename T>
T readScalar(const void* src) {
  T value{};
  std::memcpy(&value, src, sizeof(T));
  return value;
}

void setStringValue(void* dest, size_t capacity, const std::string& value) {
  if (capacity == 0) {
    throw std::runtime_error("String field has zero capacity");
  }
  if (value.size() >= capacity) {
    throw std::runtime_error("String length " + std::to_string(value.size()) +
                             " exceeds max_length " + std::to_string(capacity - 1));
  }
  std::memset(dest, 0, capacity);
  std::memcpy(dest, value.data(), value.size());
}

void setBytesValue(const pb_field_iter_t& iter, void* dest, const std::vector<uint8_t>& bytes) {
  const auto ltype = PB_LTYPE(iter.type);
  if (ltype == PB_LTYPE_FIXED_LENGTH_BYTES) {
    if (bytes.size() > iter.data_size) {
      throw std::runtime_error("Fixed-length bytes size " + std::to_string(bytes.size()) +
                               " exceeds max_size " + std::to_string(iter.data_size));
    }
    std::memset(dest, 0, iter.data_size);
    std::memcpy(dest, bytes.data(), bytes.size());
    return;
  }

  if (ltype != PB_LTYPE_BYTES) {
    throw std::runtime_error("Unexpected bytes field type");
  }

  constexpr size_t header = offsetof(pb_bytes_array_t, bytes);
  if (iter.data_size < header) {
    throw std::runtime_error("Invalid bytes field layout (data_size < header)");
  }
  auto* array = reinterpret_cast<pb_bytes_array_t*>(dest);
  const size_t maxSize = iter.data_size - header;
  if (bytes.size() > maxSize) {
    throw std::runtime_error("Bytes size " + std::to_string(bytes.size()) +
                             " exceeds max_size " + std::to_string(maxSize));
  }
  array->size = static_cast<pb_size_t>(bytes.size());
  if (!bytes.empty()) {
    std::memcpy(array->bytes, bytes.data(), bytes.size());
  }
}

AnyValue decodeSingleValue(const MessageInfo& messageInfo, const FieldInfo& fieldInfo, const pb_field_iter_t& iter, size_t index);

void populateMessage(const MessageInfo& info, void* message, const AnyObject& object) {
  // Initialize the field iterator once; pb_field_iter_find wraps from the
  // current position, so it can be reused across entries instead of
  // re-running pb_field_iter_begin for every key.
  pb_field_iter_t iter{};
  const bool iterReady = pb_field_iter_begin(&iter, info.descriptor, message);
  for (const auto& entry : object) {
    if (isNullValue(entry.second)) {
      continue;
    }
    const FieldInfo* fieldInfo = findFieldCached(info, entry.first);
    if (fieldInfo == nullptr) {
      throw std::runtime_error("Unknown field: " + std::string(entry.first));
    }
    if (!iterReady || !pb_field_iter_find(&iter, fieldInfo->tag)) {
      throw std::runtime_error("Failed to find field: " + toFieldPath(info, *fieldInfo));
    }

    ensureSupportedField(info, *fieldInfo, iter);

    if (fieldInfo->repeated) {
      const auto htype = PB_HTYPE(iter.type);
      if (htype != PB_HTYPE_REPEATED && htype != PB_HTYPE_FIXARRAY) {
        throw std::runtime_error("Field is not repeated in nanopb: " + toFieldPath(info, *fieldInfo));
      }
      AnyArray values;
      if (!getArrayValue(entry.second, values)) {
        throw std::runtime_error("Expected array for field: " + toFieldPath(info, *fieldInfo));
      }
      const pb_size_t maxCount = iter.array_size;
      if (values.size() > maxCount) {
        throw std::runtime_error("Array exceeds max_count for field: " + toFieldPath(info, *fieldInfo));
      }
      if (PB_HTYPE(iter.type) == PB_HTYPE_REPEATED && iter.pSize != nullptr) {
        *reinterpret_cast<pb_size_t*>(iter.pSize) = static_cast<pb_size_t>(values.size());
      }
      for (size_t i = 0; i < values.size(); i++) {
        const AnyValue& item = values[i];
        auto* data = static_cast<uint8_t*>(iter.pData) + (i * iter.data_size);
        switch (fieldInfo->type) {
          case FieldType::Bool: {
            bool value = false;
            if (!getBoolValue(item, value)) {
              throw std::runtime_error("Expected boolean for field: " + toFieldPath(info, *fieldInfo));
            }
            writeScalar(data, value);
            break;
          }
          case FieldType::Int32:
          case FieldType::SInt32:
          case FieldType::SFixed32:
          case FieldType::Enum: {
            int64_t value = 0;
            if (!getInt64Value(item, value)) {
              throw std::runtime_error("Expected int32 for field: " + toFieldPath(info, *fieldInfo));
            }
            writeScalar<int32_t>(data, static_cast<int32_t>(value));
            break;
          }
          case FieldType::UInt32:
          case FieldType::Fixed32: {
            uint64_t value = 0;
            if (!getUInt64Value(item, value)) {
              throw std::runtime_error("Expected uint32 for field: " + toFieldPath(info, *fieldInfo));
            }
            writeScalar<uint32_t>(data, static_cast<uint32_t>(value));
            break;
          }
          case FieldType::Int64:
          case FieldType::SInt64:
          case FieldType::SFixed64: {
            int64_t value = 0;
            if (!getInt64Value(item, value)) {
              throw std::runtime_error("Expected int64 for field: " + toFieldPath(info, *fieldInfo));
            }
            writeScalar<int64_t>(data, value);
            break;
          }
          case FieldType::UInt64:
          case FieldType::Fixed64: {
            uint64_t value = 0;
            if (!getUInt64Value(item, value)) {
              throw std::runtime_error("Expected uint64 for field: " + toFieldPath(info, *fieldInfo));
            }
            writeScalar<uint64_t>(data, value);
            break;
          }
          case FieldType::Float: {
            double value = 0;
            if (!getDoubleValue(item, value)) {
              throw std::runtime_error("Expected float for field: " + toFieldPath(info, *fieldInfo));
            }
            writeScalar<float>(data, static_cast<float>(value));
            break;
          }
          case FieldType::Double: {
            double value = 0;
            if (!getDoubleValue(item, value)) {
              throw std::runtime_error("Expected double for field: " + toFieldPath(info, *fieldInfo));
            }
            writeScalar<double>(data, value);
            break;
          }
          case FieldType::String: {
            std::string value;
            if (!getStringValue(item, value)) {
              throw std::runtime_error("Expected string for field: " + toFieldPath(info, *fieldInfo));
            }
            setStringValue(data, iter.data_size, value);
            break;
          }
          case FieldType::Bytes: {
            setBytesValue(iter, data, getBytesValue(item));
            break;
          }
          case FieldType::Message: {
            AnyObject nestedObject;
            if (!getObjectValue(item, nestedObject)) {
              throw std::runtime_error("Expected object for field: " + toFieldPath(info, *fieldInfo));
            }
            const MessageInfo* nestedInfo = getMessageInfo(iter.submsg_desc);
            if (nestedInfo == nullptr) {
              throw std::runtime_error("Unknown submessage for field: " + toFieldPath(info, *fieldInfo));
            }
            if (nestedInfo->init_default != nullptr) {
              nestedInfo->init_default(data);
            }
            populateMessage(*nestedInfo, data, nestedObject);
            break;
          }
        }
      }
    } else {
      const auto htype = PB_HTYPE(iter.type);
      if (htype == PB_HTYPE_OPTIONAL && iter.pSize != nullptr) {
        *reinterpret_cast<bool*>(iter.pSize) = true;
      } else if (htype == PB_HTYPE_ONEOF && iter.pSize != nullptr) {
        // Select this union member; nanopb encodes only the member whose tag
        // matches which_<oneof>. Setting it per provided member is last-wins,
        // consistent with proto oneof semantics (the union is shared).
        *reinterpret_cast<pb_size_t*>(iter.pSize) = static_cast<pb_size_t>(iter.tag);
      }

      auto* data = static_cast<uint8_t*>(iter.pData);
      const AnyValue& value = entry.second;

      switch (fieldInfo->type) {
        case FieldType::Bool: {
          bool decoded = false;
          if (!getBoolValue(value, decoded)) {
            throw std::runtime_error("Expected boolean for field: " + toFieldPath(info, *fieldInfo));
          }
          writeScalar(data, decoded);
          break;
        }
        case FieldType::Int32:
        case FieldType::SInt32:
        case FieldType::SFixed32:
        case FieldType::Enum: {
          int64_t decoded = 0;
          if (!getInt64Value(value, decoded)) {
            throw std::runtime_error("Expected int32 for field: " + toFieldPath(info, *fieldInfo));
          }
          writeScalar<int32_t>(data, static_cast<int32_t>(decoded));
          break;
        }
        case FieldType::UInt32:
        case FieldType::Fixed32: {
          uint64_t decoded = 0;
          if (!getUInt64Value(value, decoded)) {
            throw std::runtime_error("Expected uint32 for field: " + toFieldPath(info, *fieldInfo));
          }
          writeScalar<uint32_t>(data, static_cast<uint32_t>(decoded));
          break;
        }
        case FieldType::Int64:
        case FieldType::SInt64:
        case FieldType::SFixed64: {
          int64_t decoded = 0;
          if (!getInt64Value(value, decoded)) {
            throw std::runtime_error("Expected int64 for field: " + toFieldPath(info, *fieldInfo));
          }
          writeScalar<int64_t>(data, decoded);
          break;
        }
        case FieldType::UInt64:
        case FieldType::Fixed64: {
          uint64_t decoded = 0;
          if (!getUInt64Value(value, decoded)) {
            throw std::runtime_error("Expected uint64 for field: " + toFieldPath(info, *fieldInfo));
          }
          writeScalar<uint64_t>(data, decoded);
          break;
        }
        case FieldType::Float: {
          double decoded = 0;
          if (!getDoubleValue(value, decoded)) {
            throw std::runtime_error("Expected float for field: " + toFieldPath(info, *fieldInfo));
          }
          writeScalar<float>(data, static_cast<float>(decoded));
          break;
        }
        case FieldType::Double: {
          double decoded = 0;
          if (!getDoubleValue(value, decoded)) {
            throw std::runtime_error("Expected double for field: " + toFieldPath(info, *fieldInfo));
          }
          writeScalar<double>(data, decoded);
          break;
        }
        case FieldType::String: {
          std::string decoded;
          if (!getStringValue(value, decoded)) {
            throw std::runtime_error("Expected string for field: " + toFieldPath(info, *fieldInfo));
          }
          setStringValue(data, iter.data_size, decoded);
          break;
        }
        case FieldType::Bytes: {
          setBytesValue(iter, data, getBytesValue(value));
          break;
        }
        case FieldType::Message: {
          AnyObject nestedObject;
          if (!getObjectValue(value, nestedObject)) {
            throw std::runtime_error("Expected object for field: " + toFieldPath(info, *fieldInfo));
          }
          const MessageInfo* nestedInfo = getMessageInfo(iter.submsg_desc);
          if (nestedInfo == nullptr) {
            throw std::runtime_error("Unknown submessage for field: " + toFieldPath(info, *fieldInfo));
          }
          if (nestedInfo->init_default != nullptr) {
            nestedInfo->init_default(data);
          }
          populateMessage(*nestedInfo, data, nestedObject);
          break;
        }
      }
    }
  }
}

// Whether a found field is set and should be surfaced on decode:
//   - SINGULAR (implicit proto3): always (zero/empty is a valid value)
//   - OPTIONAL (explicit presence): the has-bit
//   - ONEOF: the which_<oneof> selector equals this member's tag
//   - REPEATED/FIXARRAY: non-empty
bool fieldIsPresent(const pb_field_iter_t& iter) {
  const auto htype = PB_HTYPE(iter.type);
  if (htype == PB_HTYPE_OPTIONAL && iter.pSize != nullptr) {
    return *reinterpret_cast<const bool*>(iter.pSize);
  }
  if (htype == PB_HTYPE_ONEOF && iter.pSize != nullptr) {
    return *reinterpret_cast<const pb_size_t*>(iter.pSize) == iter.tag;
  }
  if (htype == PB_HTYPE_REPEATED || htype == PB_HTYPE_FIXARRAY) {
    const pb_size_t count =
        iter.pSize != nullptr ? *reinterpret_cast<const pb_size_t*>(iter.pSize) : iter.array_size;
    return count > 0;
  }
  return true;
}

AnyValue decodeSingleValue(const MessageInfo& messageInfo, const FieldInfo& fieldInfo, const pb_field_iter_t& iter, size_t index) {
  const auto* data = static_cast<const uint8_t*>(iter.pData) + (index * iter.data_size);
  switch (fieldInfo.type) {
    case FieldType::Bool:
      return AnyValue(readScalar<bool>(data));
    case FieldType::Int32:
    case FieldType::SInt32:
    case FieldType::SFixed32:
    case FieldType::Enum:
      return AnyValue(static_cast<double>(readScalar<int32_t>(data)));
    case FieldType::UInt32:
    case FieldType::Fixed32:
      return AnyValue(static_cast<double>(readScalar<uint32_t>(data)));
    case FieldType::Int64:
    case FieldType::SInt64:
    case FieldType::SFixed64:
      return AnyValue(std::to_string(readScalar<int64_t>(data)));
    case FieldType::UInt64:
    case FieldType::Fixed64:
      return AnyValue(std::to_string(readScalar<uint64_t>(data)));
    case FieldType::Float:
      return AnyValue(static_cast<double>(readScalar<float>(data)));
    case FieldType::Double:
      return AnyValue(readScalar<double>(data));
    case FieldType::String: {
      const auto* str = reinterpret_cast<const char*>(data);
      return AnyValue(std::string(str, strnlen(str, iter.data_size)));
    }
    case FieldType::Bytes: {
      const auto ltype = PB_LTYPE(iter.type);
      if (ltype == PB_LTYPE_FIXED_LENGTH_BYTES) {
        return AnyValue(base64Encode(data, iter.data_size));
      }
      if (ltype == PB_LTYPE_BYTES) {
        const auto* array = reinterpret_cast<const pb_bytes_array_t*>(data);
        return AnyValue(base64Encode(array->bytes, array->size));
      }
      throw std::runtime_error("Unexpected bytes field type");
    }
    case FieldType::Message: {
      const MessageInfo* nestedInfo = getMessageInfo(iter.submsg_desc);
      if (nestedInfo == nullptr) {
        throw std::runtime_error("Unknown submessage for field: " + toFieldPath(messageInfo, fieldInfo));
      }
      auto nestedMap = AnyMap::make(nestedInfo->field_count);
      auto& nestedOut = nestedMap->getMap();
      pb_field_iter_t nestedIter{};
      if (!pb_field_iter_begin_const(&nestedIter, nestedInfo->descriptor, data)) {
        return AnyValue(std::move(nestedOut));
      }

      for (size_t i = 0; i < nestedInfo->field_count; i++) {
        const FieldInfo& nestedField = nestedInfo->fields[i];
        if (!pb_field_iter_find(&nestedIter, nestedField.tag)) {
          continue;
        }
        ensureSupportedField(*nestedInfo, nestedField, nestedIter);
        if (!fieldIsPresent(nestedIter)) {
          continue;
        }

        if (nestedField.repeated) {
          const pb_size_t count =
              nestedIter.pSize != nullptr ? *reinterpret_cast<const pb_size_t*>(nestedIter.pSize) : nestedIter.array_size;
          AnyArray array;
          array.reserve(count);
          for (size_t j = 0; j < count; j++) {
            array.emplace_back(decodeSingleValue(*nestedInfo, nestedField, nestedIter, j));
          }
          nestedOut.emplace(nestedField.name, AnyValue(std::move(array)));
        } else {
          nestedOut.emplace(nestedField.name, decodeSingleValue(*nestedInfo, nestedField, nestedIter, 0));
        }
      }
      return AnyValue(std::move(nestedOut));
    }
  }
  throw std::runtime_error("Unsupported field type");
}

std::shared_ptr<AnyMap> decodeMessageInternal(const MessageInfo& info, const void* message) {
  auto map = AnyMap::make(info.field_count);
  auto& out = map->getMap();
  pb_field_iter_t iter{};
  const bool iterReady = pb_field_iter_begin_const(&iter, info.descriptor, message);

  for (size_t i = 0; i < info.field_count; i++) {
    const FieldInfo& field = info.fields[i];
    if (!iterReady || !pb_field_iter_find(&iter, field.tag)) {
      continue;
    }
    ensureSupportedField(info, field, iter);

    if (!fieldIsPresent(iter)) {
      continue;
    }

    if (field.repeated) {
      const pb_size_t count = iter.pSize != nullptr ? *reinterpret_cast<const pb_size_t*>(iter.pSize) : iter.array_size;
      AnyArray array;
      array.reserve(count);
      for (size_t j = 0; j < count; j++) {
        array.emplace_back(decodeSingleValue(info, field, iter, j));
      }
      out.emplace(field.name, AnyValue(std::move(array)));
    } else {
      out.emplace(field.name, decodeSingleValue(info, field, iter, 0));
    }
  }

  return map;
}

std::shared_ptr<ArrayBuffer> encodeFromObject(const MessageInfo& info, const AnyObject& object) {
  std::vector<uint8_t> storage(info.struct_size);
  if (info.init_default != nullptr) {
    info.init_default(storage.data());
  }

  populateMessage(info, storage.data(), object);

  size_t encodedSize = 0;
  if (!pb_get_encoded_size(&encodedSize, info.descriptor, storage.data())) {
    throw std::runtime_error("Failed to compute encoded size");
  }

  std::vector<uint8_t> output(encodedSize);
  pb_ostream_t stream = pb_ostream_from_buffer(output.data(), output.size());
  if (!pb_encode(&stream, info.descriptor, storage.data())) {
    const char* errorMessage = stream.errmsg ? stream.errmsg : "Unknown encode error";
    throw std::runtime_error(std::string("Failed to encode message: ") + errorMessage);
  }

  output.resize(stream.bytes_written);
  return ArrayBuffer::move(std::move(output));
}

} // namespace

std::shared_ptr<ArrayBuffer> encodeMessage(const MessageInfo& info, const std::shared_ptr<AnyMap>& message) {
  if (message == nullptr) {
    throw std::runtime_error("Message object is null");
  }
  return encodeFromObject(info, message->getMap());
}

size_t encodedByteLength(const MessageInfo& info, const std::shared_ptr<AnyMap>& message) {
  if (message == nullptr) {
    throw std::runtime_error("Message object is null");
  }
  std::vector<uint8_t> storage(info.struct_size);
  if (info.init_default != nullptr) {
    info.init_default(storage.data());
  }
  populateMessage(info, storage.data(), message->getMap());

  size_t encodedSize = 0;
  if (!pb_get_encoded_size(&encodedSize, info.descriptor, storage.data())) {
    throw std::runtime_error("Failed to compute encoded size");
  }
  return encodedSize;
}

std::shared_ptr<AnyMap> decodeMessage(const MessageInfo& info, const std::shared_ptr<ArrayBuffer>& data) {
  if (data == nullptr) {
    throw std::runtime_error("Data buffer is null");
  }
  if (data->data() == nullptr || data->size() == 0) {
    throw std::runtime_error("Data buffer is empty");
  }

  std::vector<uint8_t> storage(info.struct_size);
  if (info.init_default != nullptr) {
    info.init_default(storage.data());
  }

  pb_istream_t stream = pb_istream_from_buffer(data->data(), data->size());
  if (!pb_decode(&stream, info.descriptor, storage.data())) {
    const char* errorMessage = stream.errmsg ? stream.errmsg : "Unknown decode error";
    throw std::runtime_error(std::string("Failed to decode message: ") + errorMessage);
  }

  return decodeMessageInternal(info, storage.data());
}

} // namespace margelo::nitro::nitroprotobuf
