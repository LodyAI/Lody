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
