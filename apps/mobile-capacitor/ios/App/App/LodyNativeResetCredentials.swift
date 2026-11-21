import Foundation

/// Auth-only recovery policy. Shared URLSession cookies are not login proof.
final class LodyNativeResetCredentials {
    static let prefix = "CapacitorStorage.better-auth"
    private static let failuresKey = "LodyNativeReset.credentialFailures"
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    private var authKeys: [String] {
        defaults.dictionaryRepresentation().keys.filter { $0.hasPrefix(Self.prefix) }
    }

    func clear(clearSharedCookies: () -> Void, logoutPush: () -> Void) -> Bool {
        for key in authKeys {
            defaults.removeObject(forKey: key)
        }
        clearSharedCookies()
        logoutPush()
        // SDKs can recreate unrelated cookies immediately. Only auth Preferences
        // control this result, and re-enumeration includes newly added suffixes.
        let cleared = authKeys.isEmpty
        if cleared { resetFailureCount() }
        return cleared
    }

    /// Three failed boots show recovery; the fourth continues with the web wipe.
    /// This is degraded recovery, not a claim that undeletable credentials vanished.
    func shouldBlockBoot(afterCleanupSucceeded succeeded: Bool) -> Bool {
        if succeeded {
            resetFailureCount()
            return false
        }
        let failures = min(max(defaults.integer(forKey: Self.failuresKey), 0), 3) + 1
        defaults.set(failures, forKey: Self.failuresKey)
        return failures <= 3
    }

    func resetFailureCount() {
        defaults.removeObject(forKey: Self.failuresKey)
    }
}
