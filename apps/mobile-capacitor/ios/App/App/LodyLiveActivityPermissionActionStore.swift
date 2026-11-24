import Foundation

struct LodyLiveActivityPermissionActionConfiguration {
    let authToken: String
    let convexSiteUrl: URL
}

enum LodyLiveActivityPermissionActionStore {
    static let appGroupIdentifier = "group.ai.lody.mobile.onesignal"

    private static let enabledKey = "LodyLiveActivityPermissionActionsEnabled"

    static func permissionActionConfiguration(
        from defaults: UserDefaults? = UserDefaults(suiteName: appGroupIdentifier)
    ) -> LodyLiveActivityPermissionActionConfiguration? {
        guard defaults?.bool(forKey: enabledKey) == true else { return nil }
        return configuration(from: defaults)
    }

    private static let authTokenKey = "LodyLiveActivityPermissionActionAuthToken"
    private static let convexSiteUrlKey = "LodyLiveActivityPermissionActionConvexSiteUrl"

    static func save(
        authToken: String?, convexSiteUrl: String?, permissionActionsEnabled: Bool = false,
        to defaults: UserDefaults? = UserDefaults(suiteName: appGroupIdentifier)
    ) {
        guard let defaults else {
            return
        }

        defaults.set(permissionActionsEnabled, forKey: enabledKey)
        let normalizedAuthToken = normalizeString(authToken)
        let normalizedSiteUrl = normalizeURLString(convexSiteUrl)
        if let normalizedSiteUrl {
            defaults.set(normalizedSiteUrl, forKey: convexSiteUrlKey)
        }

        if let authToken = normalizedAuthToken {
            defaults.set(authToken, forKey: authTokenKey)
        } else {
            defaults.removeObject(forKey: authTokenKey)
        }
        _ = defaults.synchronize()
    }

    static func configuration(
        from defaults: UserDefaults? = UserDefaults(suiteName: appGroupIdentifier)
    ) -> LodyLiveActivityPermissionActionConfiguration? {
        guard let defaults else {
            return nil
        }

        let authToken = normalizeString(defaults.string(forKey: authTokenKey))
        let rawSiteUrl = normalizeURLString(defaults.string(forKey: convexSiteUrlKey))
        guard let authToken,
              let rawSiteUrl,
              let convexSiteUrl = URL(string: rawSiteUrl) else {
            return nil
        }

        return LodyLiveActivityPermissionActionConfiguration(
            authToken: authToken,
            convexSiteUrl: convexSiteUrl
        )
    }

    private static func normalizeString(_ value: String?) -> String? {
        guard let value else {
            return nil
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func normalizeURLString(_ value: String?) -> String? {
        guard var value = normalizeString(value) else {
            return nil
        }
        while value.hasSuffix("/") {
            value.removeLast()
        }
        return value.isEmpty ? nil : value
    }
}
