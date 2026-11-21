import Foundation
import ActivityKit
import OneSignalLiveActivities

@available(iOS 16.1, *)
public enum LodyConversationActivityStatus: String, Codable, Hashable {
    case permission
    case question
    case running
    case unread
}

@available(iOS 16.1, *)
public enum LodyPermissionResponseState: String, Codable, Hashable {
    case sending
    case allowed
    case rejected
    case failed
    case timedOut
}

@available(iOS 16.1, *)
public struct LodyConversationLiveActivityAttributes: OneSignalLiveActivityAttributes {
    public struct ConversationItem: Codable, Hashable {
        public var id: String
        public var status: LodyConversationActivityStatus
        public var statusLabel: String
        public var permissionRequestId: String?
        public var permissionCommand: String?
        public var permissionResponseState: LodyPermissionResponseState?
        public var agentLogoKind: String
        public var agentLogoText: String
        public var title: String
        public var updatedAt: Double
        public var updatedAtLabel: String

        public init(
            id: String,
            status: LodyConversationActivityStatus,
            statusLabel: String,
            permissionRequestId: String? = nil,
            permissionCommand: String? = nil,
            permissionResponseState: LodyPermissionResponseState? = nil,
            agentLogoKind: String,
            agentLogoText: String,
            title: String,
            updatedAt: Double,
            updatedAtLabel: String
        ) {
            self.id = id
            self.status = status
            self.statusLabel = statusLabel
            self.permissionRequestId = permissionRequestId
            self.permissionCommand = permissionCommand
            self.permissionResponseState = permissionResponseState
            self.agentLogoKind = agentLogoKind
            self.agentLogoText = agentLogoText
            self.title = title
            self.updatedAt = updatedAt
            self.updatedAtLabel = updatedAtLabel
        }
    }

    public struct ContentState: Codable, Hashable, OneSignalLiveActivityContentState {
        public struct StatusCounts: Codable, Hashable {
            public var permission: Int
            public var question: Int
            public var running: Int
            public var unread: Int

            public init(permission: Int, question: Int, running: Int, unread: Int) {
                self.permission = permission
                self.question = question
                self.running = running
                self.unread = unread
            }
        }

        public var totalCount: Int
        public var statusCounts: StatusCounts
        public var items: [ConversationItem]
        public var updatedAt: Double
        public var onesignal: OneSignalLiveActivityContentStateData?

        public init(
            totalCount: Int,
            statusCounts: StatusCounts,
            items: [ConversationItem],
            updatedAt: Double,
            onesignal: OneSignalLiveActivityContentStateData? = nil
        ) {
            self.totalCount = totalCount
            self.statusCounts = statusCounts
            self.items = items
            self.updatedAt = updatedAt
            self.onesignal = onesignal
        }
    }

    public var activityId: String
    public var workspaceId: String
    public var workspaceName: String
    public var onesignal: OneSignalLiveActivityAttributeData

    public init(
        activityId: String,
        workspaceId: String,
        workspaceName: String,
        onesignal: OneSignalLiveActivityAttributeData
    ) {
        self.activityId = activityId
        self.workspaceId = workspaceId
        self.workspaceName = workspaceName
        self.onesignal = onesignal
    }
    // Direct APNs starts have no vendor envelope. Preserve the common ActivityKit
    // type while letting the OneSignal SDK attach its metadata when selected.
    private enum CodingKeys: String, CodingKey {
        case activityId, workspaceId, workspaceName, onesignal
    }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        activityId = try values.decode(String.self, forKey: .activityId)
        workspaceId = try values.decode(String.self, forKey: .workspaceId)
        workspaceName = try values.decode(String.self, forKey: .workspaceName)
        onesignal = try values.decodeIfPresent(OneSignalLiveActivityAttributeData.self, forKey: .onesignal)
            ?? OneSignalLiveActivityAttributeData.create(activityId: activityId)
    }

}
