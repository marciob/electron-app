{
  "targets": [
    {
      "target_name": "systemAudio",
      "sources": ["src/native/SystemAudioCapture.mm"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "frameworks": ["ScreenCaptureKit", "CoreMedia"],
      "xcode_settings": {
        "OTHER_CFLAGS": ["-ObjC++"],
        "MACOSX_DEPLOYMENT_TARGET": "12.3",
        "CLANG_CXX_LIBRARY": "libc++",
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES"
      },
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"]
    }
  ]
} 