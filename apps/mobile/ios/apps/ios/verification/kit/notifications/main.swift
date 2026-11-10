import Foundation

var launchPermissionRequests = 0
PushPermissionLaunchRequest.perform {
  launchPermissionRequests += 1
}
precondition(launchPermissionRequests == 1, "app launch requests notification permission")

var clicks = PushClickBuffer()
clicks.receive(id: "first", route: "/work/sessions/one", userId: "alice")
precondition(clicks.pending?["id"] == "first")
clicks.identify("alice")
precondition(clicks.pending?["id"] == "first", "same-account cold restoration preserves intent")
clicks.receive(id: "second", route: "/work/sessions/two", userId: "alice")
clicks.acknowledge("first")
precondition(clicks.pending?["id"] == "second", "stale JS ack must not erase a newer click")
clicks.identify("bob")
precondition(clicks.pending == nil)
clicks.receive(id: "third", route: "/work/sessions/two", userId: "bob")
clicks.identify(nil)
precondition(clicks.pending == nil)
clicks.receive(id: "bad", route: String(repeating: "/", count: 2049), userId: "bob")
precondition(clicks.pending == nil)
for id: String? in [nil, "", "local-placeholder"] { precondition(!PushClickBuffer.isRegistered(id)) }
precondition(PushClickBuffer.isRegistered("server-assigned-subscription"))
print("PASS: launch permission request, cold click retention, latest-intent acknowledgement, account/logout isolation, subscription placeholders")

// Delivery belongs to the current login session, not a raw account ID alone.
@MainActor final class Backend {
  var configuration = Data(#"{"selfHostedEnabled":true}"#.utf8)
  var binding: [String: String]?
  var owner: String?
  var fail = false
  var failRemoval = false
  var hold: CheckedContinuation<Void, Never>?
  var entered: CheckedContinuation<Void, Never>?
  var suspendRegister = false
  func call(_ session: PushRegistration.Session, _ kind: String, _ path: String, _ args: [String: String]) async throws -> Data {
    if fail { throw NSError(domain: "offline", code: 1) }
    if path == "pushSubscriptions:configuration" { return configuration }
    if path == "pushSubscriptions:unregister", failRemoval { throw NSError(domain: "offline", code: 2) }
    if path == "pushSubscriptions:register" {
      if suspendRegister {
        await withCheckedContinuation { continuation in
          hold = continuation
          entered?.resume(); entered = nil
        }
      }
      binding = args; owner = session.credential
    } else if owner == session.credential { binding = nil; owner = nil }
    return Data("null".utf8)
  }
}
let backend = Backend()
var ready = false
var failures = 0
let registration = PushRegistration(installation: "fixture-installation", call: backend.call,
  changed: { _, registered in ready = registered }, failure: { failures += 1 })
registration.deviceToken(String(repeating: "ab", count: 32), bundle: "ai.lody.actual-test-app")
registration.identify(user: "alice", credential: "session-a")
registration.refresh(authorized: false)
await registration.drain()
precondition(backend.binding == nil && !ready, "denied permission cannot register an installation")
registration.refresh(authorized: true)
await registration.drain()
precondition(backend.binding?["bundleId"] == "ai.lody.actual-test-app" && ready, "APNs binds the running app, not a hardcoded topic")
precondition(backend.binding?["purpose"] == "notification", "notifications never register ActivityKit tokens")
registration.deviceToken(String(repeating: "cd", count: 32), bundle: "ai.lody.actual-test-app")
registration.refresh(authorized: true)
await registration.drain()
precondition(backend.binding?["token"] == String(repeating: "cd", count: 32), "APNs token rotation replaces the current installation token")
registration.refresh(authorized: false)
precondition(!ready, "permission revocation immediately clears readiness")
await registration.drain()
precondition(backend.binding == nil, "permission revocation retires remote delivery")
registration.refresh(authorized: true)
await registration.drain()

backend.configuration = Data(#"{"selfHostedEnabled":false}"#.utf8)
registration.refresh(authorized: true)
await registration.drain()
precondition(registration.provider == .oneSignal && backend.binding == nil, "switching to OneSignal retires direct APNs delivery")
backend.configuration = Data(#"{"selfHostedEnabled":"true"}"#.utf8)
registration.refresh(authorized: true)
await registration.drain()
precondition(registration.provider == .oneSignal && failures == 1, "malformed capability must not select a provider")
backend.configuration = Data(#"{"selfHostedEnabled":true}"#.utf8)
backend.fail = true
registration.refresh(authorized: true)
await registration.drain()
backend.fail = false
registration.refresh(authorized: true)
await registration.drain()
precondition(ready && backend.owner == "session-a", "network failure is retryable on foreground refresh")

// An already-dispatched old write completes before retirement and the successor.
backend.suspendRegister = true
await withCheckedContinuation { continuation in
  backend.entered = continuation
  registration.refresh(authorized: true)
}
registration.identify(user: nil, credential: nil)
precondition(!ready, "logout immediately invalidates native readiness")
registration.identify(user: "alice", credential: "session-b")
registration.refresh(authorized: true)
backend.suspendRegister = false
backend.hold?.resume(); backend.hold = nil
await registration.drain()
precondition(backend.owner == "session-b" && ready, "late old-session registration and cleanup cannot overwrite a new login for the same user")
registration.identify(user: nil, credential: nil)
await registration.drain()
precondition(backend.binding == nil && !ready, "logout drains remote registration without retaining a deliverable installation")
print("PASS: session-authorized APNs lifecycle, exact capability, topic binding, transitions, failure recovery and stale write fencing")

for recipient: String? in [nil, "", "bob", " alice "] {
  precondition(!PushClickBuffer.shouldDisplay(userId: "alice", recipient: recipient, route: "/work/sessions/a", visibleRoute: ""), "missing or mismatched recipients cannot display for a raw account")
}
precondition(!PushClickBuffer.shouldDisplay(userId: nil, recipient: "alice", route: nil, visibleRoute: ""), "signed-out foreground delivery is suppressed")
precondition(!PushClickBuffer.shouldDisplay(userId: "alice", recipient: "alice", route: "/work/sessions/a", visibleRoute: "/work/sessions/a"), "the visible conversation does not notify twice")
precondition(PushClickBuffer.shouldDisplay(userId: "alice", recipient: "alice", route: "/work/sessions/b", visibleRoute: "/work/sessions/a"), "another conversation still notifies its owner")
print("PASS: verified recipient foreground ownership")

let direct: [AnyHashable: Any] = ["route": "/work/sessions/a", "recipientUserId": "alice"]
let wrapped: [AnyHashable: Any] = ["custom": ["i": "push-a", "a": direct]]
precondition(PushClickBuffer.payload(direct)?.recipient == "alice")
precondition(PushClickBuffer.payload(wrapped)?.route == "/work/sessions/a", "cold OneSignal clicks retain their raw owner before SDK initialization")
precondition(PushClickBuffer.payload(["route": "/work/sessions/a"]) == nil, "ownerless pushes are never attributed to the next login")
clicks.receive(id: "push-a", route: "/work/sessions/a", userId: "alice")
clicks.acknowledge("push-a")
clicks.receive(id: "push-a", route: "/work/sessions/a", userId: "alice")
precondition(clicks.pending == nil, "native and SDK callbacks for one click must not navigate twice")
print("PASS: cold provider payload decoding and duplicate click acknowledgement")

registration.identify(user: "alice", credential: "session-c")
registration.refresh(authorized: true)
await registration.drain()
backend.failRemoval = true
registration.identify(user: nil, credential: nil)
registration.identify(user: "bob", credential: "session-d")
registration.refresh(authorized: true)
await registration.drain()
precondition(backend.owner == "session-d" && ready, "persistent retirement failure must not block a new session from safely replacing the installation")
backend.failRemoval = false
registration.identify(user: nil, credential: nil)
await registration.drain()
precondition(backend.binding == nil)
print("PASS: failed cleanup stays push-scoped and does not fence safe replacement")
