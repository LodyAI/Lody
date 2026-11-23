#import <AppKit/AppKit.h>
#include <node_api.h>
#include <cstring>

// Probe-only: Electron supplies an NSView* in getNativeWindowHandle().
static napi_value DisableAnimation(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  void* bytes = nullptr;
  size_t length = 0;
  bool is_buffer = false;
  if (argc != 1 || napi_is_buffer(env, args[0], &is_buffer) != napi_ok ||
      !is_buffer || napi_get_buffer_info(env, args[0], &bytes, &length) != napi_ok ||
      length != sizeof(void*) || ![NSThread isMainThread]) {
    napi_throw_type_error(env, nullptr, "Expected an Electron native window handle on the main thread");
    return nullptr;
  }
  void* pointer = nullptr;
  std::memcpy(&pointer, bytes, sizeof(pointer));
  NSView* view = (__bridge NSView*)pointer;
  NSWindow* window = view.window;
  if (!window) {
    napi_throw_error(env, nullptr, "Native window is unavailable");
    return nullptr;
  }
  window.animationBehavior = NSWindowAnimationBehaviorNone;
  napi_value result;
  napi_get_boolean(env, window.animationBehavior == NSWindowAnimationBehaviorNone, &result);
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "disableAnimation", NAPI_AUTO_LENGTH, DisableAnimation, nullptr, &fn);
  napi_set_named_property(env, exports, "disableAnimation", fn);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
