#include <jni.h>
#include "NitroProtobufOnLoad.hpp"

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  return margelo::nitro::nitroprotobuf::initialize(vm);
}
