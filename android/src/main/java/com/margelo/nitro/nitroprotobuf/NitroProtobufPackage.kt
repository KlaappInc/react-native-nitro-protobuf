package com.margelo.nitro.nitroprotobuf

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class NitroProtobufPackage : BaseReactPackage() {
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
