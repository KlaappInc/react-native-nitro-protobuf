project(NitroProtobuf)
cmake_minimum_required(VERSION 3.9.0)

set (PACKAGE_NAME NitroProtobuf)
set (CMAKE_VERBOSE_MAKEFILE ON)
set (CMAKE_CXX_STANDARD 20)

# Define C++ library and add all sources
file(GLOB NITRO_PROTOBUF_CPP_SOURCES "../cpp/*.cpp")
file(GLOB NITRO_PROTOBUF_GENERATED_CPP "../generated/*.cpp")
file(GLOB NITRO_PROTOBUF_GENERATED_C "../generated/*.pb.c")
file(GLOB NITRO_PROTOBUF_NANOPB "../cpp/nanopb/*.c")

add_library(${PACKAGE_NAME} SHARED
        src/main/cpp/cpp-adapter.cpp
        ${NITRO_PROTOBUF_CPP_SOURCES}
        ${NITRO_PROTOBUF_GENERATED_CPP}
        ${NITRO_PROTOBUF_GENERATED_C}
        ${NITRO_PROTOBUF_NANOPB}
)

# Add Nitrogen specs :)
include(${CMAKE_SOURCE_DIR}/../nitrogen/generated/android/NitroProtobuf+autolinking.cmake)

# Set up local includes
include_directories(
        "src/main/cpp"
        "../cpp"
        "../cpp/nanopb"
        "../generated"
)

find_library(LOG_LIB log)

# Link all libraries together
target_link_libraries(
        ${PACKAGE_NAME}
        ${LOG_LIB}
        android                                   # <-- Android core
)
