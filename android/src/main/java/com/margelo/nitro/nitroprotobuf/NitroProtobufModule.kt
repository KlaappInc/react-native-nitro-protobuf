package com.margelo.nitro.nitroprotobuf

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.module.annotations.ReactModule
import com.facebook.soloader.SoLoader

@ReactModule(name = NitroProtobufModule.NAME)
class NitroProtobufModule(
  reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = NAME

  companion object {
    const val NAME = "NitroProtobuf"

    init {
      SoLoader.loadLibrary("NitroProtobuf")
    }
  }
}
