enum NativeLoginMethod: Sendable {
  case email(String, String)
  case register(String, String, String)
  case resendVerification(String)
  case apple, google, github, discord
}
