import Foundation

final class StickyDefaults: UserDefaults {
    var keepAuthKeys = false
    override func removeObject(forKey key: String) {
        if keepAuthKeys && key.hasPrefix(LodyNativeResetCredentials.prefix) { return }
        super.removeObject(forKey: key)
    }
}

let suite = "lody-reset-test-" + UUID().uuidString
let defaults = StickyDefaults(suiteName: suite)!
defer { defaults.removePersistentDomain(forName: suite) }
let authKey = LodyNativeResetCredentials.prefix + "_cookie"
let futureKey = LodyNativeResetCredentials.prefix + "_future_token"
let retained = ["LodyDiagnostics.installId", "LodyStartupTheme", "CapacitorStorage.other_cookie"]
for key in [authKey, futureKey] + retained { defaults.set("synthetic", forKey: key) }
let policy = LodyNativeResetCredentials(defaults: defaults)
var sharedCookiePresent = true
var pushLoggedOut = false
let cleared = policy.clear(clearSharedCookies: {
    sharedCookiePresent = false
    // Model another native SDK immediately recreating its unrelated cookie.
    sharedCookiePresent = true
}, logoutPush: { pushLoggedOut = true })
precondition(cleared && sharedCookiePresent && pushLoggedOut)
precondition(defaults.object(forKey: authKey) == nil)
precondition(defaults.object(forKey: futureKey) == nil)
for key in retained { precondition(defaults.string(forKey: key) == "synthetic") }

defaults.set("synthetic", forKey: authKey)
defaults.keepAuthKeys = true
for boot in 1...6 {
    // A fresh policy instance reads persisted failure state on every boot.
    let nextBoot = LodyNativeResetCredentials(defaults: defaults)
    let success = nextBoot.clear(clearSharedCookies: {}, logoutPush: {})
    precondition(!success)
    precondition(nextBoot.shouldBlockBoot(afterCleanupSucceeded: success) == (boot <= 3))
}
// Successful cleanup resets the budget.
defaults.keepAuthKeys = false
precondition(policy.clear(clearSharedCookies: {}, logoutPush: {}))
defaults.set("synthetic", forKey: authKey)
defaults.keepAuthKeys = true
precondition(policy.shouldBlockBoot(afterCleanupSucceeded: false))
// Acknowledgement or a new explicit reset starts a fresh budget.
policy.resetFailureCount()
for boot in 1...4 {
    precondition(policy.shouldBlockBoot(afterCleanupSucceeded: false) == (boot <= 3))
}
print("native reset credential policy passed")
