#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <mach/mach.h>
#import <objc/message.h>

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 3) return 64;
    uint32_t value = strcmp(argv[2], "landscape") == 0 ? 3 : 1;
    dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW);
    NSString *developer = [[NSProcessInfo processInfo].environment[@"DEVELOPER_DIR"] ?: @"" copy];
    if (developer.length == 0) {
      NSTask *task = [NSTask new];
      task.launchPath = @"/usr/bin/xcode-select";
      task.arguments = @[@"-p"];
      NSPipe *pipe = [NSPipe pipe];
      task.standardOutput = pipe;
      [task launch];
      [task waitUntilExit];
      developer = [[[NSString alloc] initWithData:pipe.fileHandleForReading.readDataToEndOfFile encoding:NSUTF8StringEncoding] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    }
    NSError *error = nil;
    id context = ((id (*)(id, SEL, id, NSError **))objc_msgSend)(NSClassFromString(@"SimServiceContext"), NSSelectorFromString(@"sharedServiceContextForDeveloperDir:error:"), developer, &error);
    id set = ((id (*)(id, SEL, NSError **))objc_msgSend)(context, NSSelectorFromString(@"defaultDeviceSetWithError:"), &error);
    NSDictionary *devices = ((id (*)(id, SEL))objc_msgSend)(set, NSSelectorFromString(@"devicesByUDID"));
    id device = devices[[[NSUUID alloc] initWithUUIDString:@(argv[1])]];
    if (!device) { fprintf(stderr, "no device %s\n", argv[1]); return 66; }
    mach_port_t port = ((mach_port_t (*)(id, SEL, id, NSError **))objc_msgSend)(device, NSSelectorFromString(@"lookup:error:"), @"PurpleWorkspacePort", &error);
    if (port == MACH_PORT_NULL) { fprintf(stderr, "no PurpleWorkspacePort: %s\n", error.description.UTF8String); return 69; }
    uint8_t message[0x70] = {0};
    uint32_t fields[][2] = {{0, 0x13}, {4, 0x6c}, {20, 0x7b}, {24, 0x20032}, {72, 4}, {76, value}};
    for (size_t index = 0; index < sizeof(fields) / sizeof(fields[0]); index++) memcpy(message + fields[index][0], &fields[index][1], 4);
    mach_msg_header_t *header = (mach_msg_header_t *)message;
    header->msgh_remote_port = port;
    kern_return_t result = mach_msg(header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, 0x6c, 0, MACH_PORT_NULL, 1000, MACH_PORT_NULL);
    if (result != KERN_SUCCESS) { fprintf(stderr, "mach_msg failed: %d\n", result); return 70; }
  }
  return 0;
}
