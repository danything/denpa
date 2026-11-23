# SPDX-License-Identifier: GPL-2.0-only
#
# denpa-asicen: エージェントが起動する ASICEN 系の機材の子プロセス (main.cpp)。組むのは build.sh から。
#
#   cmake -S agent/asicen -B <組む場所> -DASICEN_SOURCE=<ソースのアーカイブを展開した repository/>
#         -DASICEN_LIBUSB_INCLUDE_DIR=… -DASICEN_LIBUSB_LIBRARY=<静的な libusb-1.0.a>
#         [-DASICEN_LIBUSB_LINK_LIBRARIES=<libusb の Libs.private>] [-DDENPA_ASICEN_MOCK=ON]
#
# 上流の CMakeLists.txt をそのまま読み、使う静的ライブラリだけをリンクする (上流のファイルは変えない)。
# Linux・Android・Windows・macOS のどれでも、libusb と上流の部品を中に入れた 1 つの実行ファイルにする。
cmake_minimum_required(VERSION 3.16)
project(denpa_asicen LANGUAGES C CXX)

set(ASICEN_SOURCE "" CACHE PATH "asicen-userland のソース (ソースのアーカイブの repository/)")
option(DENPA_ASICEN_MOCK "偽の機材で開く --mock を足す。テスト用で、配るものには付けない" OFF)
if(NOT EXISTS "${ASICEN_SOURCE}/CMakeLists.txt")
    message(FATAL_ERROR "ASICEN_SOURCE に asicen-userland のソースを渡してください")
endif()

set(ASICEN_BUILD_PCSC_IFD OFF CACHE BOOL "" FORCE)
set(ASICEN_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(ASICEN_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
set(ASICEN_ENABLE_LIBUSB ON CACHE BOOL "" FORCE)
add_subdirectory("${ASICEN_SOURCE}" asicen-userland EXCLUDE_FROM_ALL)

# 上流の中で決まる置き場 (サブディレクトリの変数は親から見えないので、同じ値を引き直す)
include(FetchContent)
FetchContent_GetProperties(dtv_userland_core SOURCE_DIR dtv_core)
set(px4_root "${ASICEN_SOURCE}/third_party/px4-userland/userland")
file(READ "${ASICEN_SOURCE}/VERSION" asicen_version)
string(STRIP "${asicen_version}" asicen_version)
file(STRINGS "${dtv_core}/CMakeLists.txt" dtv_core_project REGEX "^project\\(dtv_userland_core VERSION ")
string(REGEX REPLACE "^project\\(dtv_userland_core VERSION ([0-9.]+) .*$" "\\1" dtv_core_version "${dtv_core_project}")

find_package(Threads REQUIRED)
add_executable(denpa-asicen main.cpp denpa_asicen.cpp)
target_include_directories(denpa-asicen BEFORE PRIVATE
    ${dtv_core}/adapters/host_daemon/include
    ${dtv_core}/adapters/host_runtime/include
    ${dtv_core}/adapters/host_facade/include
    ${dtv_core}/adapters/host_listener_context/include
    ${dtv_core}/include)
target_include_directories(denpa-asicen PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    "${ASICEN_SOURCE}/userland/tools"
    "${ASICEN_SOURCE}/userland/include"
    "${px4_root}/tools")
target_compile_definitions(denpa-asicen PRIVATE
    ASICEN_USE_DTV_CORE=1
    ASICEN_ENABLE_LIBUSB=1
    ASICEN_PROJECT_VERSION="${asicen_version}"
    DTV_USERLAND_CORE_VERSION="${dtv_core_version}")
# 上流と同じく例外と RTTI を使わない
target_compile_options(denpa-asicen PRIVATE -fno-exceptions -fno-rtti)
target_link_libraries(denpa-asicen PRIVATE
    asicen_libusb asicen_core asicen_hardware_session
    dtv::identity dtv::json dtv::host_listener_context dtv::host_facade dtv::host_tuner
    Threads::Threads)
if(DENPA_ASICEN_MOCK)
    target_sources(denpa-asicen PRIVATE "${ASICEN_SOURCE}/userland/src/px4_mock_backend.cpp")
    target_compile_definitions(denpa-asicen PRIVATE DENPA_ASICEN_MOCK=1)
endif()
if(WIN32)
    # 上流の asicend.exe と同じ。C++ の実行時ライブラリと winpthreads も中に入れ、exe 1 つで動かす
    target_link_libraries(denpa-asicen PRIVATE shell32)
    target_link_options(denpa-asicen PRIVATE -static)
elseif(ANDROID)
    # Android の 16 KB ページの端末でも動くように (上流の Android の実行ファイルと同じ)
    target_link_options(denpa-asicen PRIVATE "-Wl,-z,max-page-size=16384" "-Wl,-z,common-page-size=16384")
endif()
