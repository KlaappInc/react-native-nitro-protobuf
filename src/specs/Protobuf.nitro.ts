import type { AnyMap, HybridObject } from 'react-native-nitro-modules'

export interface Protobuf extends HybridObject<{ ios: 'c++'; android: 'c++' }> {
  encode(messageName: string, message: AnyMap): ArrayBuffer
  decode(messageName: string, data: ArrayBuffer): AnyMap
  listMessages(): string[]
}
