// AuthenticationServices passkey ceremonies with PRF, for the recovery vault only.
// Real-device ceremonies remain unverified; see ../README.md.
#define __STDC_WANT_LIB_EXT1__ 1
#include <string.h>
#include <memory>

#import <AppKit/AppKit.h>
#import <AuthenticationServices/AuthenticationServices.h>
#import <Security/SecRandom.h>
#include <node_api.h>
#include <string>
#include <vector>

API_AVAILABLE(macos(15.0))
@interface LodyPasskeyCeremony : NSObject <ASAuthorizationControllerDelegate,
                                           ASAuthorizationControllerPresentationContextProviding>
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) ASAuthorizationController *controller;
@property(nonatomic, copy) void (^finish)(ASAuthorization *authorization, NSError *error);
@end

@implementation LodyPasskeyCeremony
- (ASPresentationAnchor)presentationAnchorForAuthorizationController:
    (ASAuthorizationController *)controller {
  return self.window;
}
- (void)authorizationController:(ASAuthorizationController *)controller
    didCompleteWithAuthorization:(ASAuthorization *)authorization {
  self.finish(authorization, nil);
}
- (void)authorizationController:(ASAuthorizationController *)controller
           didCompleteWithError:(NSError *)error {
  self.finish(nil, error);
}
@end

namespace {

struct Outcome {
  ~Outcome() {
    // Unlike memset, memset_s must execute even immediately before deallocation.
    if (!prfFirst.empty()) memset_s(prfFirst.data(), prfFirst.size(), 0, prfFirst.size());
  }

  napi_deferred deferred;
  std::string errorCode;
  bool registration = false;
  std::vector<uint8_t> credentialId;
  bool prfSupported = false;
  bool hasUserHandle = false;
  std::vector<uint8_t> userHandle;
  bool userVerified = false;
  bool hasPrf = false;
  std::vector<uint8_t> prfFirst;
  LodyPasskeyCeremony *ceremony API_AVAILABLE(macos(15.0)) = nil;
};

std::vector<uint8_t> Bytes(NSData *data) {
  if (data.length == 0) return {};
  const uint8_t *start = static_cast<const uint8_t *>(data.bytes);
  return std::vector<uint8_t>(start, start + data.length);
}

napi_value Buffer(napi_env env, const std::vector<uint8_t> &bytes) {
  napi_value out;
  void *target = nullptr;
  napi_value array;
  napi_create_arraybuffer(env, bytes.size(), &target, &array);
  if (!bytes.empty()) memcpy(target, bytes.data(), bytes.size());
  napi_create_typedarray(env, napi_uint8_array, bytes.size(), array, 0, &out);
  return out;
}

void Set(napi_env env, napi_value object, const char *key, napi_value value) {
  napi_set_named_property(env, object, key, value);
}

napi_value Boolean(napi_env env, bool value) {
  napi_value out;
  napi_get_boolean(env, value, &out);
  return out;
}

void Settle(napi_env env, napi_value, void *, void *data) {
  std::unique_ptr<Outcome> outcome(static_cast<Outcome *>(data));
  // N-API also calls this during environment shutdown, without a usable env.
  if (!env) return;
  napi_handle_scope scope;
  if (napi_open_handle_scope(env, &scope) != napi_ok) return;
  if (!outcome->errorCode.empty()) {
    napi_value message, code, error;
    napi_create_string_utf8(env, outcome->errorCode.c_str(), NAPI_AUTO_LENGTH, &message);
    napi_create_string_utf8(env, outcome->errorCode.c_str(), NAPI_AUTO_LENGTH, &code);
    napi_create_error(env, code, message, &error);
    Set(env, error, "code", code);
    napi_reject_deferred(env, outcome->deferred, error);
  } else {
    napi_value result, null;
    napi_get_null(env, &null);
    napi_create_object(env, &result);
    Set(env, result, "credentialId", Buffer(env, outcome->credentialId));
    if (outcome->registration) {
      Set(env, result, "prfSupported", Boolean(env, outcome->prfSupported));
    } else {
      Set(env, result, "userHandle",
          outcome->hasUserHandle ? Buffer(env, outcome->userHandle) : null);
      Set(env, result, "userVerified", Boolean(env, outcome->userVerified));
      Set(env, result, "prfFirst", outcome->hasPrf ? Buffer(env, outcome->prfFirst) : null);
    }
    napi_resolve_deferred(env, outcome->deferred, result);
  }
  napi_close_handle_scope(env, scope);
}

napi_value Property(napi_env env, napi_value object, const char *key) {
  napi_value value = nullptr;
  if (!object || napi_get_named_property(env, object, key, &value) != napi_ok) return nullptr;
  return value;
}

// A nil result means invalid input or a pending JS exception. Callers stop before
// passing it to AuthenticationServices; Run preserves exceptions from JS getters.
NSData *DataOf(napi_env env, napi_value value) {
  if (!value) return nil;
  void *data = nullptr;
  size_t length = 0;
  // Buffer is a Uint8Array too. Check the element type explicitly rather than
  // treating an arbitrary typed array's element count as a byte count.
  napi_typedarray_type type;
  napi_value array;
  size_t offset;
  if (napi_get_typedarray_info(env, value, &type, &length, &data, &array, &offset) != napi_ok ||
      type != napi_uint8_array)
    return nil;
  if (length > 0 && !data) return nil;
  return [NSData dataWithBytes:data length:length];
}

NSString *StringOf(napi_env env, napi_value value) {
  if (!value) return nil;
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return nil;
  std::string text(length + 1, '\0');
  if (napi_get_value_string_utf8(env, value, text.data(), text.size(), &length) != napi_ok)
    return nil;
  return [[NSString alloc] initWithBytes:text.data() length:length encoding:NSUTF8StringEncoding];
}

NSArray<NSData *> *DataArray(napi_env env, napi_value value) {
  if (!value) return nil;
  uint32_t length = 0;
  if (napi_get_array_length(env, value, &length) != napi_ok) return nil;
  NSMutableArray<NSData *> *out = [NSMutableArray arrayWithCapacity:length];
  for (uint32_t index = 0; index < length; index++) {
    napi_value item;
    if (napi_get_element(env, value, index, &item) != napi_ok) return nil;
    NSData *data = DataOf(env, item);
    if (!data) return nil;
    [out addObject:data];
  }
  return out;
}

napi_value InvalidInput(napi_env env) {
  bool pending = false;
  if (napi_is_exception_pending(env, &pending) == napi_ok && !pending)
    napi_throw_type_error(env, nullptr, "Invalid passkey ceremony input");
  return nullptr;
}

NSWindow *WindowOf(NSData *data) {
  if (data.length != sizeof(void *)) return nil;
  NSView *view = (__bridge NSView *)(*reinterpret_cast<void *const *>(data.bytes));
  return view.window;
}

NSData *Challenge() {
  NSMutableData *out = [NSMutableData dataWithLength:32];
  if (SecRandomCopyBytes(kSecRandomDefault, 32, out.mutableBytes) != errSecSuccess) return nil;
  return out;
}

API_AVAILABLE(macos(15.0))
void Fill(Outcome *outcome, ASAuthorization *authorization) {
  id credential = authorization.credential;
  if (outcome->registration &&
      [credential isKindOfClass:[ASAuthorizationPlatformPublicKeyCredentialRegistration class]]) {
    ASAuthorizationPlatformPublicKeyCredentialRegistration *created = credential;
    outcome->credentialId = Bytes(created.credentialID);
    outcome->prfSupported = created.prf != nil && created.prf.isSupported;
    return;
  }
  if (outcome->registration ||
      ![credential isKindOfClass:[ASAuthorizationPlatformPublicKeyCredentialAssertion class]]) {
    outcome->errorCode = "failed";
    return;
  }
  ASAuthorizationPlatformPublicKeyCredentialAssertion *assertion = credential;
  outcome->credentialId = Bytes(assertion.credentialID);
  if (assertion.userID) {
    outcome->hasUserHandle = true;
    outcome->userHandle = Bytes(assertion.userID);
  }
  // WebAuthn authenticator data: rpIdHash (32 bytes), then flags; bit 2 is user verified.
  NSData *authenticatorData = assertion.rawAuthenticatorData;
  outcome->userVerified = authenticatorData.length > 32 &&
                          (static_cast<const uint8_t *>(authenticatorData.bytes)[32] & 0x04) != 0;
  if (assertion.prf.first) {
    outcome->hasPrf = true;
    outcome->prfFirst = Bytes(assertion.prf.first);
  }
}

napi_value Run(napi_env env, napi_callback_info info, bool registration) {
  size_t argc = 1;
  napi_value input = nullptr, promise;
  if (napi_get_cb_info(env, info, &argc, &input, nullptr, nullptr) != napi_ok || argc != 1)
    return InvalidInput(env);
  // Validate all JS values before allocating an Outcome or touching a native window.
  NSData *windowData = DataOf(env, Property(env, input, "window"));
  if (!windowData) return InvalidInput(env);
  NSString *rpId = StringOf(env, Property(env, input, "rpId"));
  if (!rpId) return InvalidInput(env);
  NSData *salt = DataOf(env, Property(env, input, "prfInput"));
  if (!salt) return InvalidInput(env);
  NSString *userName = nil;
  NSData *userHandle = nil;
  if (registration) {
    userName = StringOf(env, Property(env, input, "userName"));
    if (!userName) return InvalidInput(env);
    userHandle = DataOf(env, Property(env, input, "userHandle"));
    if (!userHandle) return InvalidInput(env);
  }
  NSArray<NSData *> *identifiers = DataArray(
      env, Property(env, input, registration ? "excludeCredentialIds" : "allowCredentialIds"));
  if (!identifiers) return InvalidInput(env);
  Outcome *outcome = new Outcome();
  outcome->registration = registration;
  if (napi_create_promise(env, &outcome->deferred, &promise) != napi_ok) {
    delete outcome;
    return nullptr;
  }
  auto reject = [&](const char *code) {
    outcome->errorCode = code;
    Settle(env, nullptr, nullptr, outcome);
    return promise;
  };
  if (@available(macOS 15.0, *)) {
    NSWindow *window = WindowOf(windowData);
    NSData *challenge = Challenge();
    if (!window || !challenge) return reject("unavailable");
    ASAuthorizationPlatformPublicKeyCredentialProvider *provider =
        [[ASAuthorizationPlatformPublicKeyCredentialProvider alloc]
            initWithRelyingPartyIdentifier:rpId];
    ASAuthorizationRequest *request;
    if (registration) {
      ASAuthorizationPlatformPublicKeyCredentialRegistrationRequest *create =
          [provider createCredentialRegistrationRequestWithChallenge:challenge
                                                                name:userName
                                                              userID:userHandle];
      create.userVerificationPreference =
          ASAuthorizationPublicKeyCredentialUserVerificationPreferenceRequired;
      create.prf = [ASAuthorizationPublicKeyCredentialPRFRegistrationInput checkForSupport];
      NSArray<NSData *> *excluded = identifiers;
      if (excluded.count > 0) {
        // Overwriting a listed credential would orphan its wrap, so refuse rather than risk it.
        if (![create respondsToSelector:@selector(setExcludedCredentials:)])
          return reject("exclude-unavailable");
        NSMutableArray *descriptors = [NSMutableArray array];
        for (NSData *identifier in excluded)
          [descriptors addObject:[[ASAuthorizationPlatformPublicKeyCredentialDescriptor alloc]
                                     initWithCredentialID:identifier]];
        [create setValue:descriptors forKey:@"excludedCredentials"];
      }
      request = create;
    } else {
      ASAuthorizationPlatformPublicKeyCredentialAssertionRequest *assert =
          [provider createCredentialAssertionRequestWithChallenge:challenge];
      assert.userVerificationPreference =
          ASAuthorizationPublicKeyCredentialUserVerificationPreferenceRequired;
      ASAuthorizationPublicKeyCredentialPRFAssertionInputValues *values =
          [[ASAuthorizationPublicKeyCredentialPRFAssertionInputValues alloc]
              initWithSaltInput1:salt
                      saltInput2:nil];
      assert.prf =
          [[ASAuthorizationPublicKeyCredentialPRFAssertionInput alloc] initWithInputValues:values
                                                                  perCredentialInputValues:nil];
      NSMutableArray *allowed = [NSMutableArray array];
      for (NSData *identifier in identifiers)
        [allowed addObject:[[ASAuthorizationPlatformPublicKeyCredentialDescriptor alloc]
                               initWithCredentialID:identifier]];
      assert.allowedCredentials = allowed;
      request = assert;
    }
    napi_value name;
    if (napi_create_string_utf8(env, "lody-passkey", NAPI_AUTO_LENGTH, &name) != napi_ok)
      return reject("failed");
    napi_threadsafe_function settle;
    if (napi_create_threadsafe_function(
            env, nullptr, nullptr, name, 0, 1, nullptr, nullptr, nullptr,
            [](napi_env callEnv, napi_value, void *, void *data) {
              Settle(callEnv, nullptr, nullptr, data);
            },
            &settle) != napi_ok)
      return reject("failed");
    LodyPasskeyCeremony *ceremony = [[LodyPasskeyCeremony alloc] init];
    ceremony.window = window;
    ceremony.controller =
        [[ASAuthorizationController alloc] initWithAuthorizationRequests:@[ request ]];
    ceremony.controller.delegate = ceremony;
    ceremony.controller.presentationContextProvider = ceremony;
    outcome->ceremony = ceremony;
    ceremony.finish = ^(ASAuthorization *authorization, NSError *error) {
      if (error) {
        outcome->errorCode =
            error.code == ASAuthorizationErrorCanceled ? "cancelled" : "ceremony-failed";
      } else {
        Fill(outcome, authorization);
      }
      outcome->ceremony = nil;
      if (napi_call_threadsafe_function(settle, outcome, napi_tsfn_nonblocking) != napi_ok)
        delete outcome;
      napi_release_threadsafe_function(settle, napi_tsfn_release);
    };
    [ceremony.controller performRequests];
    return promise;
  }
  return reject("unavailable");
}

napi_value Register(napi_env env, napi_callback_info info) { return Run(env, info, true); }
napi_value Authenticate(napi_env env, napi_callback_info info) { return Run(env, info, false); }
napi_value Available(napi_env env, napi_callback_info) {
  if (@available(macOS 15.0, *)) return Boolean(env, true);
  return Boolean(env, false);
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"available", nullptr, Available, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"register", nullptr, Register, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"authenticate", nullptr, Authenticate, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 3, properties);
  return exports;
}

}  // namespace

NAPI_MODULE(passkey_bridge, Init)
