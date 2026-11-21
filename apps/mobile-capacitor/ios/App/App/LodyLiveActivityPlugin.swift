import OneSignalFramework
import OneSignalLiveActivities
import ActivityKit
import Capacitor
import Foundation

fileprivate struct LodyLiveActivityPermissionAlert {
    let title: String
    let body: String
}

@available(iOS 16.1, *)
@MainActor
private final class LodyLiveActivityManager {
    static let shared = LodyLiveActivityManager()

    // MainActor is reentrant across awaits. A newer sync/end invalidates an older
    // sync before it can create an activity after teardown. No persisted epochs.
    private var summaryRevision: UInt64 = 0

    private var didSetupOneSignalLiveActivities = false
    func setupOneSignalLiveActivities() -> [String: Any] {
        if !didSetupOneSignalLiveActivities {
            OneSignal.LiveActivities.setup(LodyConversationLiveActivityAttributes.self)
            didSetupOneSignalLiveActivities = true
        }
        return ["configured": true]
    }
    func setupPushLiveActivities() -> [String: Any] { ["configured": true] }

    func syncConversationSummary(
        activityId: String,
        workspaceId: String,
        workspaceName: String,
        totalCount: Int,
        statusCounts: LodyConversationLiveActivityAttributes.ContentState.StatusCounts,
        items: [LodyConversationLiveActivityAttributes.ConversationItem],
        permissionAlert: LodyLiveActivityPermissionAlert?
    ) async throws -> [String: Any] {
        summaryRevision &+= 1
        let revision = summaryRevision
        if items.isEmpty {
            await endConversationSummary(activityId: activityId)
            return ["activityId": activityId, "ended": true]
        }

        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            return ["activityId": activityId, "activitiesEnabled": false]
        }

        await endStaleConversationSummaries(
            activityId: activityId, workspaceId: workspaceId, revision: revision
        )
        guard revision == summaryRevision else {
            return ["activityId": activityId, "superseded": true]
        }

        let state = LodyConversationLiveActivityAttributes.ContentState(
            totalCount: totalCount,
            statusCounts: statusCounts,
            items: items,
            updatedAt: Date().timeIntervalSince1970 * 1000
        )

        if let permissionAlert {
            let activity: Activity<LodyConversationLiveActivityAttributes>
            if let existing = findActivity(activityId: activityId) {
                activity = existing
            } else {
                activity = try requestPushBackedConversationSummaryActivity(
                    activityId: activityId,
                    workspaceId: workspaceId,
                    workspaceName: workspaceName,
                    state: permissionFocusedState(state)
                )
            }
            await update(activity, state: permissionFocusedState(state), permissionAlert: permissionAlert)
            return buildResult(activityId: activityId, nativeActivityId: activity.id)
        }

        if let existing = findActivity(activityId: activityId) {
            await update(existing, state: state, permissionAlert: permissionAlert)
            return buildResult(activityId: activityId, nativeActivityId: existing.id)
        }

        let activity = try requestPushBackedConversationSummaryActivity(
            activityId: activityId,
            workspaceId: workspaceId,
            workspaceName: workspaceName,
            state: state
        )
        return buildResult(activityId: activityId, nativeActivityId: activity.id)
    }

    private func requestPushBackedConversationSummaryActivity(
        activityId: String,
        workspaceId: String,
        workspaceName: String,
        state: LodyConversationLiveActivityAttributes.ContentState
    ) throws -> Activity<LodyConversationLiveActivityAttributes> {
        let attributes = LodyConversationLiveActivityAttributes(
            activityId: activityId,
            workspaceId: workspaceId,
            workspaceName: workspaceName,
            onesignal: OneSignalLiveActivityAttributeData.create(activityId: activityId)
        )
        if #available(iOS 16.2, *) {
            return try Activity<LodyConversationLiveActivityAttributes>.request(
                attributes: attributes,
                content: activityContent(state: state),
                pushType: .token
            )
        }
        return try Activity<LodyConversationLiveActivityAttributes>.request(
            attributes: attributes,
            contentState: state,
            pushType: .token
        )
    }

    func endConversationSummary(activityId: String) async {
        summaryRevision &+= 1
        guard let activity = findActivity(activityId: activityId) else {
            return
        }
        await endActivity(activity)
    }

    private func endStaleConversationSummaries(
        activityId: String, workspaceId: String, revision: UInt64
    ) async {
        for activity in Activity<LodyConversationLiveActivityAttributes>.activities
            where activity.attributes.workspaceId == workspaceId &&
            activity.attributes.activityId != activityId {
            guard revision == summaryRevision else { return }
            await endActivity(activity)
        }
    }

    private func endActivity(_ activity: Activity<LodyConversationLiveActivityAttributes>) async {
        if #available(iOS 16.2, *) {
            let state = activity.content.state
            await activity.end(activityContent(state: state), dismissalPolicy: .immediate)
        } else {
            await activity.end(using: activity.contentState, dismissalPolicy: .immediate)
        }
    }

    private func findActivity(
        activityId: String
    ) -> Activity<LodyConversationLiveActivityAttributes>? {
        Activity<LodyConversationLiveActivityAttributes>.activities.first {
            $0.attributes.activityId == activityId
        }
    }

    private func update(
        _ activity: Activity<LodyConversationLiveActivityAttributes>,
        state: LodyConversationLiveActivityAttributes.ContentState,
        permissionAlert: LodyLiveActivityPermissionAlert?
    ) async {
        if #available(iOS 16.2, *) {
            await activity.update(
                activityContent(state: state),
                alertConfiguration: alertConfiguration(permissionAlert)
            )
        } else {
            await activity.update(using: state)
        }
    }

    private func permissionFocusedState(
        _ state: LodyConversationLiveActivityAttributes.ContentState
    ) -> LodyConversationLiveActivityAttributes.ContentState {
        guard let permissionIndex = state.items.firstIndex(where: { $0.status == .permission }) else {
            return state
        }
        var items = state.items
        let permissionItem = items.remove(at: permissionIndex)
        items.insert(permissionItem, at: 0)
        return LodyConversationLiveActivityAttributes.ContentState(
            totalCount: state.totalCount,
            statusCounts: state.statusCounts,
            items: items,
            updatedAt: state.updatedAt,
            onesignal: state.onesignal
        )
    }

    @available(iOS 16.2, *)
    private func alertConfiguration(
        _ permissionAlert: LodyLiveActivityPermissionAlert?
    ) -> AlertConfiguration? {
        guard let permissionAlert else {
            return nil
        }
        return AlertConfiguration(
            title: "\(permissionAlert.title)",
            body: "\(permissionAlert.body)",
            sound: .default
        )
    }

    @available(iOS 16.2, *)
    private func activityContent(
        state: LodyConversationLiveActivityAttributes.ContentState
    ) -> ActivityContent<LodyConversationLiveActivityAttributes.ContentState> {
        ActivityContent(
            state: state,
            staleDate: Date(timeIntervalSinceNow: 30 * 60),
            relevanceScore: relevanceScore(for: state)
        )
    }

    private func relevanceScore(
        for state: LodyConversationLiveActivityAttributes.ContentState
    ) -> Double {
        guard let first = state.items.first else {
            return 0
        }
        switch first.status {
        case .question:
            return 100
        case .permission:
            return 90
        case .running:
            return 70
        case .unread:
            return 40
        }
    }

    private func buildResult(activityId: String, nativeActivityId: String) -> [String: Any] {
        return [
            "activityId": activityId,
            "nativeActivityId": nativeActivityId,
            "activitiesEnabled": true,
        ]
    }
}

@objc(LodyLiveActivityPlugin)
public final class LodyLiveActivityPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LodyLiveActivityPlugin"
    public let jsName = "LodyLiveActivity"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setupOneSignalLiveActivities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "configurePushTokens", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setupPushLiveActivities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "configurePermissionActions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "syncConversationSummary", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "endConversationSummary", returnType: CAPPluginReturnPromise),
    ]

    @objc public func configurePushTokens(_ call: CAPPluginCall) {
        let installationId = call.getString("installationId") ?? ""
        let enabled = call.getBool("enabled") ?? false
        let language = call.getString("language") ?? "en"
        Task { @MainActor in
            if #available(iOS 16.1, *) {
                LodyActivityPushTokens.shared.configure(installationId: installationId, enabled: enabled, language: language)
            }
            call.resolve()
        }
    }

    @objc public func setupOneSignalLiveActivities(_ call: CAPPluginCall) {
        guard #available(iOS 16.1, *) else { call.resolve(["configured": false]); return }
        Task { @MainActor in
            call.resolve(LodyLiveActivityManager.shared.setupOneSignalLiveActivities())
        }
    }

    @objc public func setupPushLiveActivities(_ call: CAPPluginCall) {
        guard #available(iOS 16.1, *) else {
            call.resolve(["configured": false])
            return
        }

        Task { @MainActor in
            call.resolve(LodyLiveActivityManager.shared.setupPushLiveActivities())
        }
    }

    @objc public func configurePermissionActions(_ call: CAPPluginCall) {
        guard let convexSiteUrl = call.getString("convexSiteUrl") else {
            call.reject("Missing convexSiteUrl.")
            return
        }

        let authToken = call.getString("authToken")
        LodyLiveActivityPermissionActionStore.save(
            authToken: authToken,
            convexSiteUrl: convexSiteUrl
        )
        Task { @MainActor in
            if #available(iOS 16.1, *) { LodyActivityPushTokens.shared.resume() }
        }
        call.resolve([:])
    }

    @objc public func syncConversationSummary(_ call: CAPPluginCall) {
        guard #available(iOS 16.1, *) else {
            call.unavailable("Live Activities require iOS 16.1 or newer.")
            return
        }
        guard let activityId = call.getString("activityId"),
              let workspaceId = call.getString("workspaceId"),
              let workspaceName = call.getString("workspaceName") else {
            call.reject("Missing activityId, workspaceId, or workspaceName.")
            return
        }

        let totalCount = call.getInt("totalCount") ?? 0
        guard let statusCounts = parseStatusCounts(call.getObject("statusCounts")) else {
            call.reject("Missing or invalid statusCounts.")
            return
        }
        let permissionAlert = parsePermissionAlert(call.getObject("permissionAlert"))
        var items: [LodyConversationLiveActivityAttributes.ConversationItem] = []
        for raw in call.getArray("items") ?? [] {
            guard let rawItem = raw as? JSObject,
                  let item = parseConversationItem(rawItem) else {
                continue
            }
            items.append(item)
        }

        Task { @MainActor in
            do {
                let result = try await LodyLiveActivityManager.shared.syncConversationSummary(
                    activityId: activityId,
                    workspaceId: workspaceId,
                    workspaceName: workspaceName,
                    totalCount: totalCount,
                    statusCounts: statusCounts,
                    items: items,
                    permissionAlert: permissionAlert
                )
                call.resolve(result)
            } catch {
                call.reject("Failed to sync Live Activity.", nil, error)
            }
        }
    }

    @objc public func endConversationSummary(_ call: CAPPluginCall) {
        guard #available(iOS 16.1, *) else {
            call.resolve([:])
            return
        }
        guard let activityId = call.getString("activityId") else {
            call.reject("Missing activityId.")
            return
        }

        Task { @MainActor in
            await LodyLiveActivityManager.shared.endConversationSummary(activityId: activityId)
            call.resolve([:])
        }
    }

    @available(iOS 16.1, *)
    private func parseConversationItem(
        _ raw: JSObject
    ) -> LodyConversationLiveActivityAttributes.ConversationItem? {
        guard let id = raw["id"] as? String,
              let statusRaw = raw["status"] as? String,
              let status = LodyConversationActivityStatus(rawValue: statusRaw),
              let statusLabel = raw["statusLabel"] as? String,
              let agentLogoText = raw["agentLogoText"] as? String,
              let title = raw["title"] as? String else {
            return nil
        }

        let agentLogoKind = raw["agentLogoKind"] as? String ?? "agent"
        let permissionRequestId = raw["permissionRequestId"] as? String
        let permissionCommand = raw["permissionCommand"] as? String
        let updatedAt = raw["updatedAt"] as? Double ?? 0
        let updatedAtLabel = raw["updatedAtLabel"] as? String ?? ""
        return LodyConversationLiveActivityAttributes.ConversationItem(
            id: id,
            status: status,
            statusLabel: statusLabel,
            permissionRequestId: permissionRequestId,
            permissionCommand: permissionCommand,
            agentLogoKind: agentLogoKind,
            agentLogoText: agentLogoText,
            title: title,
            updatedAt: updatedAt,
            updatedAtLabel: updatedAtLabel
        )
    }

    @available(iOS 16.1, *)
    private func parseStatusCounts(
        _ raw: JSObject?
    ) -> LodyConversationLiveActivityAttributes.ContentState.StatusCounts? {
        guard let raw,
              let permission = parseOptionalInt(raw["permission"]),
              let question = parseOptionalInt(raw["question"]),
              let running = parseOptionalInt(raw["running"]),
              let unread = parseOptionalInt(raw["unread"]) else {
            return nil
        }

        return LodyConversationLiveActivityAttributes.ContentState.StatusCounts(
            permission: permission,
            question: question,
            running: running,
            unread: unread
        )
    }

    @available(iOS 16.1, *)
    private func parsePermissionAlert(
        _ raw: JSObject?
    ) -> LodyLiveActivityPermissionAlert? {
        guard let raw,
              let title = normalizeString(raw["title"]),
              let body = normalizeString(raw["body"]) else {
            return nil
        }
        return LodyLiveActivityPermissionAlert(title: title, body: body)
    }

    private func normalizeString(_ value: Any?) -> String? {
        guard let value = value as? String else {
            return nil
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func parseOptionalInt(_ value: Any?) -> Int? {
        if let value = value as? Int {
            return value
        }
        if let value = value as? Double {
            return Int(value)
        }
        if let value = value as? String {
            return Int(value)
        }
        return nil
    }

}


@available(iOS 16.1, *)
@MainActor
final class LodyActivityPushTokens {
    static let shared = LodyActivityPushTokens()
    private var tasks: [Task<Void, Never>] = []
    private var observed = Set<String>()
    private var installationId = ""
    private var language = "en"
    private var generation = 0

    func resume() {
        let defaults = UserDefaults.standard
        configure(installationId: defaults.string(forKey: "LodyPushInstallation") ?? "",
                  enabled: defaults.bool(forKey: "LodyPushEnabled"),
                  language: defaults.string(forKey: "LodyPushLanguage") ?? "en")
    }
    func configure(installationId: String, enabled: Bool, language: String) {
        UserDefaults.standard.set(enabled ? installationId : "", forKey: "LodyPushInstallation")
        UserDefaults.standard.set(enabled, forKey: "LodyPushEnabled")
        UserDefaults.standard.set(language, forKey: "LodyPushLanguage")
        generation += 1
        tasks.forEach { $0.cancel() }
        tasks.removeAll()
        observed.removeAll()
        self.installationId = enabled ? installationId : ""
        self.language = language
        guard enabled, !installationId.isEmpty else { return }
        let epoch = generation
        for activity in Activity<LodyConversationLiveActivityAttributes>.activities { observe(activity, epoch: epoch) }
        tasks.append(Task { [weak self] in
            for await activity in Activity<LodyConversationLiveActivityAttributes>.activityUpdates {
                guard !Task.isCancelled else { return }
                self?.observe(activity, epoch: epoch)
            }
        })
        if #available(iOS 17.2, *) {
            tasks.append(Task { [weak self] in
                if let token = Activity<LodyConversationLiveActivityAttributes>.pushToStartToken {
                    await self?.upload(token, purpose: "activity-start", epoch: epoch)
                }
                for await token in Activity<LodyConversationLiveActivityAttributes>.pushToStartTokenUpdates {
                    guard !Task.isCancelled else { return }
                    await self?.upload(token, purpose: "activity-start", epoch: epoch)
                }
            })
        }
    }
    private func observe(_ activity: Activity<LodyConversationLiveActivityAttributes>, epoch: Int) {
        guard observed.insert(activity.id).inserted else { return }
        tasks.append(Task { [weak self] in
            if let token = activity.pushToken { await self?.upload(token, purpose: "activity", epoch: epoch, activity: activity) }
            for await token in activity.pushTokenUpdates {
                guard !Task.isCancelled else { return }
                await self?.upload(token, purpose: "activity", epoch: epoch, activity: activity)
            }
        })
    }
    private func upload(_ token: Data, purpose: String, epoch: Int, activity: Activity<LodyConversationLiveActivityAttributes>? = nil) async {
        guard epoch == generation, !installationId.isEmpty,
              let config = LodyLiveActivityPermissionActionStore.configuration() else { return }
        var body: [String: Any] = ["installationId": installationId, "language": language, "purpose": purpose,
                                  "token": token.map { String(format: "%02x", $0) }.joined()]
        if let activity {
            body["activityId"] = activity.attributes.activityId
            body["workspaceId"] = activity.attributes.workspaceId
        }
        var request = URLRequest(url: config.convexSiteUrl.appendingPathComponent("api/live-activity/push-token"))
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("Bearer \(config.authToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            if (response as? HTTPURLResponse)?.statusCode != 200 { NSLog("[push] Activity token registration rejected") }
        } catch { NSLog("[push] Activity token registration failed") }
    }
}
