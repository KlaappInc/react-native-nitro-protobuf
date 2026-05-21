import { NitroModules } from 'react-native-nitro-modules'

import type { Protobuf as ProtobufSpec } from './specs/Protobuf.nitro'

export const NitroProtobuf =
  NitroModules.createHybridObject<ProtobufSpec>('Protobuf')

export type { ProtobufSpec as Protobuf }
