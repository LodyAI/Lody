enum PushPermissionLaunchRequest {
  static func perform(_ request: () -> Void) {
    request()
  }
}
