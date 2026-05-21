require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "NitroProtobuf"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  s.platforms    = { :ios => min_ios_version_supported, :visionos => 1.0 }
  s.source       = { :git => "https://github.com/KlaappInc/react-native-nitro-protobuf.git", :tag => "#{s.version}" }

  s.source_files = [
    # Implementation (Swift)
    "ios/**/*.{swift}",
    # Autolinking/Registration (Objective-C++)
    "ios/**/*.{m,mm}",
    # Implementation (C++ objects)
    "cpp/**/*.{hpp,cpp,c}",
    # Generated protos + registry
    "generated/**/*.{h,hpp,c,cpp}",
  ]

  s.pod_target_xcconfig = {
    # generated/ on the search path so well-known-type sources resolve their
    # subpath include (e.g. generated/google/protobuf/timestamp.pb.c includes
    # "google/protobuf/timestamp.pb.h"); mirrors the Android CMake include dir.
    'HEADER_SEARCH_PATHS' =>
      '$(inherited) "$(PODS_TARGET_SRCROOT)/cpp/nanopb" "$(PODS_TARGET_SRCROOT)/generated"',
  }

  load 'nitrogen/generated/ios/NitroProtobuf+autolinking.rb'
  add_nitrogen_files(s)

  s.dependency 'React-jsi'
  s.dependency 'React-callinvoker'
  install_modules_dependencies(s)
end
