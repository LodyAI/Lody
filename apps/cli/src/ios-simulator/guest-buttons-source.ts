/** Fixed, bundled source compiled with the host's simulator SDK. No caller source or flags. */
export const guestButtonsSource = String.raw`
#import <Foundation/Foundation.h>
#import <objc/message.h>
#import <dlfcn.h>
#import <mach/mach_time.h>
#import <signal.h>
#import <unistd.h>

@interface LodyButtonProperties : NSObject
@end
@implementation LodyButtonProperties
- (id)propertyForKey:(NSString *)key forService:(id)service {
  return (@{@"PrimaryUsagePage": @11, @"PrimaryUsage": @1,
    @"DeviceUsagePairs": @[@{@"DeviceUsagePage": @11, @"DeviceUsage": @1}],
    @"Transport": @"CoreDevice", @"Product": @"Lody simulator buttons",
    @"Built-In": @YES, @"VendorID": @0, @"ProductID": @0,
    @"VersionNumber": @0, @"ReportInterval": @8000})[key];
}
- (BOOL)setProperty:(id)value forKey:(NSString *)key forService:(id)service { return YES; }
- (id)copyEventMatching:(id)matching forService:(id)service { return nil; }
- (BOOL)setOutputEvent:(id)event forService:(id)service { return YES; }
- (void)notification:(uint32_t)type withProperty:(id)property forService:(id)service {}
@end
static volatile sig_atomic_t stopping = 0;
static void stop(int sig) { stopping = 1; }
int main(void) {
 @autoreleasepool {
  signal(SIGTERM, stop); signal(SIGINT, stop);
  dlopen("/System/Library/PrivateFrameworks/HID.framework/HID", RTLD_NOW);
  void *lib = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_NOW);
  CFTypeRef (*event)(CFAllocatorRef,uint64_t,uint32_t,uint32_t,Boolean,uint32_t) =
    dlsym(lib, "IOHIDEventCreateKeyboardEvent");
  id service = [[NSClassFromString(@"HIDVirtualEventService") alloc] init];
  if (!event || !service) return 1;
  LodyButtonProperties *properties = [LodyButtonProperties new];
  ((void (*)(id,SEL,id))objc_msgSend)(service,sel_registerName("setDelegate:"),properties);
  dispatch_queue_t queue = dispatch_queue_create("ai.lody.simulator.buttons", DISPATCH_QUEUE_SERIAL);
  ((void (*)(id,SEL,id))objc_msgSend)(service,sel_registerName("setDispatchQueue:"),queue);
  ((void (*)(id,SEL))objc_msgSend)(service,sel_registerName("activate"));
  if (!((uint64_t (*)(id,SEL))objc_msgSend)(service,sel_registerName("serviceID"))) return 1;
  // The guest enumerates the newly registered service asynchronously.
  usleep(300000);
  if (!stopping) { puts("ready"); fflush(stdout); }
  char line[64];
  while (!stopping && fgets(line,sizeof(line),stdin)) {
    unsigned sequence = 0; char name[32], extra;
    if (sscanf(line,"%u %31s %c",&sequence,name,&extra) != 2 || !sequence) break;
    unsigned usage = 0, count = 1;
    if (!strcmp(name,"home")) usage = 64;
    else if (!strcmp(name,"app-switcher")) { usage = 64; count = 2; }
    else if (!strcmp(name,"lock")) usage = 48;
    else break;
    BOOL ok = YES;
    for (unsigned i=0; i<count && !stopping; i++) {
      CFTypeRef down = event(kCFAllocatorDefault,mach_absolute_time(),12,usage,true,0);
      if (!down) { ok = NO; break; }
      BOOL sent = ((BOOL (*)(id,SEL,id))objc_msgSend)(service,sel_registerName("dispatchEvent:"),(__bridge id)down);
      CFRelease(down);
      usleep(100000);
      // Always release a submitted down, including a shutdown during the hold.
      CFTypeRef up = event(kCFAllocatorDefault,mach_absolute_time(),12,usage,false,0);
      BOOL released = up && ((BOOL (*)(id,SEL,id))objc_msgSend)(service,sel_registerName("dispatchEvent:"),(__bridge id)up);
      if (up) CFRelease(up);
      ok = ok && sent && released;
      if (i+1<count) usleep(150000);
    }
    if (stopping) break;
    printf("%u %s\n",sequence,ok ? "ok" : "error"); fflush(stdout);
    if (!ok) break;
  }
  ((void (*)(id,SEL))objc_msgSend)(service,sel_registerName("cancel"));
  return 0;
 }
}
`;
