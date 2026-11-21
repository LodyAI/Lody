import ActivityKit
import AppIntents
import Foundation

@available(iOS 17.0, iOSApplicationExtension 17.0, *)
struct LodyLiveActivityPermissionResponseIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Respond to Lody Permission"
    static var openAppWhenRun: Bool = false

    @Parameter(title: "Activity ID")
    var activityId: String

    @Parameter(title: "Workspace ID")
    var workspaceId: String

    @Parameter(title: "Session ID")
    var sessionId: String

    @Parameter(title: "Request ID")
    var requestId: String

    @Parameter(title: "Action")
    var action: String

    init() {
        self.activityId = ""
        self.workspaceId = ""
        self.sessionId = ""
        self.requestId = ""
        self.action = ""
    }

    init(activityId: String, workspaceId: String, sessionId: String, requestId: String, action: String) {
        self.activityId = activityId
        self.workspaceId = workspaceId
        self.sessionId = sessionId
        self.requestId = requestId
        self.action = action
    }

    func perform() async throws -> some IntentResult {
        guard action == "allow" || action == "reject" else {
            throw LodyLiveActivityPermissionIntentError.invalidAction
        }
        await updatePermissionActivities(responseState: .sending)
        guard let configuration = LodyLiveActivityPermissionActionStore.configuration() else {
            await updatePermissionActivities(responseState: .failed)
            return .result()
        }

        let endpoint = configuration.convexSiteUrl
            .appendingPathComponent("api")
            .appendingPathComponent("live-activity")
            .appendingPathComponent("permission-response")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 10
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(configuration.authToken)", forHTTPHeaderField: "Authorization")
        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: [
                "activityId": activityId,
                "workspaceId": workspaceId,
                "sessionId": sessionId,
                "requestId": requestId,
                "action": action,
            ])
        } catch {
            await updatePermissionActivities(responseState: .failed)
            return .result()
        }

        do {
            let (_, httpResponse) = try await performPermissionRequest(request)

            guard (200..<300).contains(httpResponse.statusCode) else {
                throw LodyLiveActivityPermissionIntentError.rejected(httpResponse.statusCode)
            }
            await updatePermissionActivities(responseState: successResponseState)
        } catch {
            await updatePermissionActivities(responseState: isTimeout(error) ? .timedOut : .failed)
            return .result()
        }

        return .result()
    }

    private var successResponseState: LodyPermissionResponseState {
        action == "allow" ? .allowed : .rejected
    }

    private func performPermissionRequest(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        try await withThrowingTaskGroup(of: LodyLiveActivityPermissionRequestResult.self) { group in
            group.addTask {
                let (data, response) = try await URLSession.shared.data(for: request)
                return LodyLiveActivityPermissionRequestResult(data: data, response: response)
            }
            group.addTask {
                try await Task.sleep(nanoseconds: 10_000_000_000)
                throw LodyLiveActivityPermissionIntentError.timedOut
            }

            guard let result = try await group.next() else {
                throw LodyLiveActivityPermissionIntentError.invalidResponse
            }
            group.cancelAll()

            guard let httpResponse = result.response as? HTTPURLResponse else {
                throw LodyLiveActivityPermissionIntentError.invalidResponse
            }
            return (result.data, httpResponse)
        }
    }

    private func updatePermissionActivities(responseState: LodyPermissionResponseState) async {
        for activity in matchingActivities() {
            let currentState = activity.content.state
            guard let nextState = currentState.updatingPermissionResponse(
                sessionId: sessionId,
                requestId: requestId,
                responseState: responseState
            ) else {
                continue
            }
            await activity.update(
                ActivityContent(
                    state: nextState,
                    staleDate: Date(timeIntervalSinceNow: 5 * 60),
                    relevanceScore: 100
                )
            )
        }
    }

    private func matchingActivities() -> [Activity<LodyConversationLiveActivityAttributes>] {
        return Activity<LodyConversationLiveActivityAttributes>.activities.filter {
            $0.attributes.activityId == activityId
        }
    }

    private func isTimeout(_ error: Error) -> Bool {
        if case LodyLiveActivityPermissionIntentError.timedOut = error {
            return true
        }
        guard let urlError = error as? URLError else {
            return false
        }
        return urlError.code == .timedOut
    }
}

@available(iOS 17.0, iOSApplicationExtension 17.0, *)
struct LodyLiveActivityPermissionFeedbackIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Open Lody Permission"
    static var openAppWhenRun: Bool = true

    @Parameter(title: "Activity ID")
    var activityId: String

    @Parameter(title: "Session ID")
    var sessionId: String

    @Parameter(title: "Request ID")
    var requestId: String

    init() {
        self.activityId = ""
        self.sessionId = ""
        self.requestId = ""
    }

    init(activityId: String, sessionId: String, requestId: String) {
        self.activityId = activityId
        self.sessionId = sessionId
        self.requestId = requestId
    }

    func perform() async throws -> some IntentResult {
        for activity in matchingActivities() {
            let currentState = activity.content.state
            guard let nextState = currentState.clearingPermissionResponse(
                sessionId: sessionId,
                requestId: requestId
            ) else {
                continue
            }
            await activity.update(
                ActivityContent(
                    state: nextState,
                    staleDate: Date(timeIntervalSinceNow: 5 * 60),
                    relevanceScore: 100
                )
            )
        }
        return .result()
    }

    private func matchingActivities() -> [Activity<LodyConversationLiveActivityAttributes>] {
        return Activity<LodyConversationLiveActivityAttributes>.activities.filter {
            $0.attributes.activityId == activityId
        }
    }
}

@available(iOS 17.0, iOSApplicationExtension 17.0, *)
private struct LodyLiveActivityPermissionRequestResult {
    let data: Data
    let response: URLResponse
}

@available(iOS 17.0, iOSApplicationExtension 17.0, *)
private extension LodyConversationLiveActivityAttributes.ContentState {
    func updatingPermissionResponse(
        sessionId: String,
        requestId: String,
        responseState: LodyPermissionResponseState
    ) -> LodyConversationLiveActivityAttributes.ContentState? {
        var nextItems = items
        guard let itemIndex = nextItems.firstIndex(where: {
            $0.id == sessionId && $0.permissionRequestId == requestId
        }) ?? nextItems.firstIndex(where: {
            $0.permissionRequestId == requestId
        }) ?? nextItems.firstIndex(where: {
            $0.status == .permission
        }) else {
            return nil
        }

        var item = nextItems[itemIndex]
        item.permissionResponseState = responseState
        item.statusLabel = responseState.liveActivityLabel
        item.updatedAt = Date().timeIntervalSince1970 * 1000
        item.updatedAtLabel = lodyLiveActivityLocalized("liveActivity.time.now")
        nextItems[itemIndex] = item

        return LodyConversationLiveActivityAttributes.ContentState(
            totalCount: totalCount,
            statusCounts: statusCounts,
            items: nextItems,
            updatedAt: Date().timeIntervalSince1970 * 1000,
            onesignal: onesignal
        )
    }

    func clearingPermissionResponse(
        sessionId: String,
        requestId: String
    ) -> LodyConversationLiveActivityAttributes.ContentState? {
        var nextItems = items
        guard let itemIndex = nextItems.firstIndex(where: {
            $0.id == sessionId && $0.permissionRequestId == requestId
        }) ?? nextItems.firstIndex(where: {
            $0.permissionRequestId == requestId
        }) else {
            return nil
        }

        var item = nextItems[itemIndex]
        item.permissionResponseState = nil
        item.statusLabel = item.status.defaultLiveActivityLabel
        item.updatedAt = Date().timeIntervalSince1970 * 1000
        item.updatedAtLabel = lodyLiveActivityLocalized("liveActivity.time.now")
        nextItems[itemIndex] = item

        return LodyConversationLiveActivityAttributes.ContentState(
            totalCount: totalCount,
            statusCounts: statusCounts,
            items: nextItems,
            updatedAt: Date().timeIntervalSince1970 * 1000,
            onesignal: onesignal
        )
    }
}

@available(iOS 17.0, iOSApplicationExtension 17.0, *)
private extension LodyPermissionResponseState {
    var liveActivityLabel: String {
        lodyLiveActivityPermissionResponseShortLabel(self)
    }
}

@available(iOS 17.0, iOSApplicationExtension 17.0, *)
private extension LodyConversationActivityStatus {
    var defaultLiveActivityLabel: String {
        lodyLiveActivityStatusLabel(self)
    }
}

enum LodyLiveActivityPermissionIntentError: Error {
    case invalidAction
    case invalidResponse
    case rejected(Int)
    case timedOut
}
