// AuthenticationServices passkey ceremonies with PRF, for the recovery vault only.
// This file has never been compiled or run; see ../README.md.
#import <AppKit/AppKit.h>
#import <AuthenticationServices/AuthenticationServices.h>
#import <Security/SecRandom.h>
#include <node_api.h>
#include <string>
#include <vector>

API_AVAILABLE(macos(15.0))
@interface LodyPasskeyCeremony
    : NSObject <ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding>
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
  Outcome *outcome = static_cast<Outcome *>(data);
  napi_handle_scope scope;
  napi_open_handle_scope(env, &scope);
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
  if (!outcome->prfFirst.empty()) memset(outcome->prfFirst.data(), 0, outcome->prfFirst.size());
  napi_close_handle_scope(env, scope);
  delete outcome;
}

napi_value Property(napi_env env, napi_value object, const char *key) {
  napi_value value = nullptr;
  napi_get_named_property(env, object, key, &value);
  return value;
}

NSData *DataOf(napi_env env, napi_value value) {
  void *data = nullptr;
  size_t length = 0;
  bool isBuffer = false;
  napi_is_buffer(env, value, &isBuffer);
  if (isBuffer) {
    napi_get_buffer_info(env, value, &data, &length);
  } else {
    napi_typedarray_type type;
    napi_value array;
    size_t offset;
    napi_get_typedarray_info(env, value, &type, &length, &data, &array, &offset);
  }
  return [NSData dataWithBytes:data length:length];
}

NSString *StringOf(napi_env env, napi_value value) {
  size_t length = 0;
  napi_get_value_string_utf8(env, value, nullptr, 0, &length);
  std::string text(length, '\0');
  napi_get_value_string_utf8(env, value, text.data(), length + 1, &length);
  return [NSString stringWithUTF8String:text.c_str()];
}

NSArray<NSData *> *DataArray(napi_env env, napi_value value) {
  uint32_t length = 0;
  napi_get_array_length(env, value, &length);
  NSMutableArray<NSData *> *out = [NSMutableArray arrayWithCapacity:length];
  for (uint32_t index = 0; index < length; index++) {
    napi_value item;
    napi_get_element(env, value, index, &item);
    [out addObject:DataOf(env, item)];
  }
  return out;
}

NSWindow *WindowOf(napi_env env, napi_value handle) {
  NSData *data = DataOf(env, handle);
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
  if ([credential isKindOfClass:[ASAuthorizationPlatformPublicKeyCredentialRegistration class]]) {
    ASAuthorizationPlatformPublicKeyCredentialRegistration *created = credential;
    outcome->credentialId = Bytes(created.credentialID);
    outcome->prfSupported = created.prf != nil && created.prf.isSupported;
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
  napi_value input, promise;
  napi_get_cb_info(env, info, &argc, &input, nullptr, nullptr);
  Outcome *outcome = new Outcome();
  outcome->registration = registration;
  napi_create_promise(env, &outcome->deferred, &promise);
  auto reject = [&](const char *code) {
    outcome->errorCode = code;
    Settle(env, nullptr, nullptr, outcome);
    return promise;
  };
  if (@available(macOS 15.0, *)) {
    NSWindow *window = WindowOf(env, Property(env, input, "window"));
    NSData *challenge = Challenge();
    if (!window || !challenge) return reject("unavailable");
    ASAuthorizationPlatformPublicKeyCredentialProvider *provider =
        [[ASAuthorizationPlatformPublicKeyCredentialProvider alloc]
            initWithRelyingPartyIdentifier:StringOf(env, Property(env, input, "rpId"))];
    NSData *salt = DataOf(env, Property(env, input, "prfInput"));
    ASAuthorizationRequest *request;
    if (registration) {
      ASAuthorizationPlatformPublicKeyCredentialRegistrationRequest *create =
          [provider createCredentialRegistrationRequestWithChallenge:challenge
                                                                name:StringOf(env, Property(env, input, "userName"))
                                                              userID:DataOf(env, Property(env, input, "userHandle"))];
      create.userVerificationPreference = ASAuthorizationPublicKeyCredentialUserVerificationPreferenceRequired;
      create.prf = [ASAuthorizationPublicKeyCredentialPRFRegistrationInput checkForSupport];
      NSArray<NSData *> *excluded = DataArray(env, Property(env, input, "excludeCredentialIds"));
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
      assert.userVerificationPreference = ASAuthorizationPublicKeyCredentialUserVerificationPreferenceRequired;
      ASAuthorizationPublicKeyCredentialPRFAssertionInputValues *values =
          [[ASAuthorizationPublicKeyCredentialPRFAssertionInputValues alloc] initWithSaltInput1:salt
                                                                                     saltInput2:nil];
      assert.prf = [[ASAuthorizationPublicKeyCredentialPRFAssertionInput alloc]
                 initWithInputValues:values
            perCredentialInputValues:nil];
      NSMutableArray *allowed = [NSMutableArray array];
      for (NSData *identifier in DataArray(env, Property(env, input, "allowCredentialIds")))
        [allowed addObject:[[ASAuthorizationPlatformPublicKeyCredentialDescriptor alloc]
                               initWithCredentialID:identifier]];
      assert.allowedCredentials = allowed;
      request = assert;
    }
    napi_value name;
    napi_create_string_utf8(env, "lody-passkey", NAPI_AUTO_LENGTH, &name);
    napi_threadsafe_function settle;
    napi_create_threadsafe_function(env, nullptr, nullptr, name, 0, 1, nullptr, nullptr, nullptr,
                                    [](napi_env callEnv, napi_value, void *, void *data) {
                                      Settle(callEnv, nullptr, nullptr, data);
                                    },
                                    &settle);
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
      napi_call_threadsafe_function(settle, outcome, napi_tsfn_nonblocking);
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
