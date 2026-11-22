#include "../src/passkey_bridge.mm"
#include <objc/runtime.h>
#include <cassert>
#include <cstdlib>

@interface SyntheticAuthorization : NSObject
@property(nonatomic, strong) id credential;
@end
@implementation SyntheticAuthorization
@end

static void *watched = nullptr;
static bool erased = false;
void operator delete(void *pointer) noexcept {
  if (pointer == watched) {
    erased = true;
    for (size_t i = 0; i < 32; ++i)
      if (static_cast<unsigned char *>(pointer)[i] != 0) std::abort();
    watched = nullptr;
  }
  std::free(pointer);
}
int main() {
  @autoreleasepool {
    if (@available(macOS 15.0, *)) {
      SyntheticAuthorization *authorization = [SyntheticAuthorization new];
      id registration =
          class_createInstance([ASAuthorizationPlatformPublicKeyCredentialRegistration class], 0);
      id assertion =
          class_createInstance([ASAuthorizationPlatformPublicKeyCredentialAssertion class], 0);
      for (bool registering : {false, true}) {
        for (id credential :
             @[ [NSObject new], registering ? assertion : registration, [NSNull null] ]) {
          Outcome outcome;
          outcome.registration = registering;
          authorization.credential = credential;
          Fill(&outcome, (ASAuthorization *)authorization);
          assert(outcome.errorCode == "failed");
          assert(outcome.credentialId.empty());
          assert(outcome.prfFirst.empty());
        }
        Outcome outcome;
        outcome.registration = registering;
        Fill(&outcome, nil);
        assert(outcome.errorCode == "failed");
      }
      // Observe PRF bytes before the allocator overwrites them, for normal,
      // failed/cancelled and environment-shutdown cleanup.
      for (const char *code : {"", "failed", "cancelled"}) {
        Outcome *outcome = new Outcome();
        outcome->errorCode = code;
        outcome->prfFirst.assign(32, 0xa5);
        watched = outcome->prfFirst.data();
        erased = false;
        if (code[0])
          delete outcome;
        else
          Settle(nullptr, nullptr, nullptr, outcome);
        assert(erased);
      }
    } else {
      return 77;  // This suite requires macOS 15+, rather than silently passing.
    }
  }
}
