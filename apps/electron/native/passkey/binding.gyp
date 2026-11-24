{
  "targets": [
    {
      "target_name": "passkey_bridge",
      "sources": ["src/passkey_bridge.mm"],
      "xcode_settings": {
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "CLANG_CXX_LIBRARY": "libc++",
        "MACOSX_DEPLOYMENT_TARGET": "12.0",
        "OTHER_CFLAGS": ["-ObjC++"],
        "OTHER_LDFLAGS": ["-framework AppKit", "-framework AuthenticationServices"]
      }
    }
  ]
}
