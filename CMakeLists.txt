cmake_minimum_required(VERSION 3.10)
project(GameDetector)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Trouver OpenCV
find_package(OpenCV REQUIRED)
if(NOT OpenCV_FOUND)
    message(FATAL_ERROR "OpenCV not found")
endif()

# --- Tesseract (plateforme spécifique) ---
if (WIN32)
    # Utiliser les chemins vcpkg (Windows)
    set(TESSERACT_INCLUDE_DIR "${CMAKE_SOURCE_DIR}/vcpkg/installed/x64-windows/include")
    set(TESSERACT_LIB_RELEASE "${CMAKE_SOURCE_DIR}/vcpkg/installed/x64-windows/lib/tesseract55.lib")
    set(TESSERACT_LIB_DEBUG   "${CMAKE_SOURCE_DIR}/vcpkg/installed/x64-windows/debug/lib/tesseract55d.lib")

    include_directories(${TESSERACT_INCLUDE_DIR})

    if (CMAKE_BUILD_TYPE STREQUAL "Debug")
        set(TESSERACT_LIB ${TESSERACT_LIB_DEBUG})
    else()
        set(TESSERACT_LIB ${TESSERACT_LIB_RELEASE})
    endif()
else()
    # Utiliser pkg-config pour Linux/macOS
    find_package(PkgConfig REQUIRED)
    pkg_check_modules(TESSERACT REQUIRED tesseract)
    if(NOT TESSERACT_FOUND)
        message(FATAL_ERROR "Tesseract not found")
    endif()
    include_directories(${TESSERACT_INCLUDE_DIRS})
    set(TESSERACT_LIB ${TESSERACT_LIBRARIES})
endif()

# Nom de l’exécutable selon OS
if(${CMAKE_SYSTEM_NAME} STREQUAL "Linux")
    set(EXECUTABLE_NAME "linux")
elseif(${CMAKE_SYSTEM_NAME} STREQUAL "Darwin")
    set(EXECUTABLE_NAME "darwin")
elseif(${CMAKE_SYSTEM_NAME} STREQUAL "Windows")
    set(EXECUTABLE_NAME "windows")
else()
    set(EXECUTABLE_NAME "GameDetector")
endif()

add_executable(${EXECUTABLE_NAME} src/detector/script.cpp)

target_link_libraries(${EXECUTABLE_NAME}
    ${OpenCV_LIBS}
    ${TESSERACT_LIB}
)
