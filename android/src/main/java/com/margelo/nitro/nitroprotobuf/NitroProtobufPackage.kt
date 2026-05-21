package com.margelo.nitro.nitroprotobuf

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class NitroProtobufPackage : BaseReactPackage() {
  init {
    // Eagerly load the native library so the C++ `Protobuf` HybridObject is
    // registered (via JNI_OnLoad -> registerAllNatives) before JS runs
    // `NitroModules.createHybridObject('Protobuf')` at import time. Relying on
    // NitroProtobufModule's lazy static init is too late — the TurboModule is
    // only touched after the HybridObject is already created.
    NitroProtobufOnLoad.initializeNative()
  }

  override fun getModule(
    name: String,
    reactContext: ReactApplicationContext,
  ): NativeModule? {
    return if (name == NitroProtobufModule.NAME) {
      NitroProtobufModule(reactContext)
    } else {
      null
    }
  }

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider {
    return ReactModuleInfoProvider {
      val moduleInfos: MutableMap<String, ReactModuleInfo> = HashMap()
      val isTurboModule: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
      moduleInfos[NitroProtobufModule.NAME] =
        ReactModuleInfo(
          NitroProtobufModule.NAME,
          NitroProtobufModule.NAME,
          canOverrideExistingModule = false,
          needsEagerInit = false,
          isCxxModule = false,
          isTurboModule = isTurboModule,
        )
      moduleInfos
    }
  }
}
