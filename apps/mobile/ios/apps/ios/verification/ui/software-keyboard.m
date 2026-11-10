// Host-only CoreSimulator setup, using the same per-device API as idb.
// Never linked into LodyKit or shipped with the app.
#import <Foundation/Foundation.h>
#import <dlfcn.h>

@interface NSObject (SimulatorKeyboard)
+ (id)sharedServiceContextForDeveloperDir:(NSString *)path error:(NSError **)error;
- (id)defaultDeviceSetWithError:(NSError **)error;
- (NSDictionary *)devicesByUDID;
- (BOOL)setHardwareKeyboardEnabled:(BOOL)enabled keyboardType:(unsigned char)type error:(NSError **)error;
@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 3) { fprintf(stderr, "Usage: software-keyboard DEVELOPER_DIR UDID\n"); return 1; }
    if (!dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW)) {
      fprintf(stderr, "%s\n", dlerror()); return 1;
    }
    NSError *error = nil;
    id service = [NSClassFromString(@"SimServiceContext") sharedServiceContextForDeveloperDir:@(argv[1]) error:&error];
    id set = [service defaultDeviceSetWithError:&error];
    NSUUID *udid = [[NSUUID alloc] initWithUUIDString:@(argv[2])];
    id device = udid ? [set devicesByUDID][udid] : nil;
    if (!device || ![device setHardwareKeyboardEnabled:NO keyboardType:0 error:&error]) {
      fprintf(stderr, "Cannot enable software keyboard: %s\n", error.description.UTF8String ?: "device not found"); return 1;
    }
  }
  return 0;
}
