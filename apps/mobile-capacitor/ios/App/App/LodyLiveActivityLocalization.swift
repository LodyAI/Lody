import Foundation

private final class LodyLiveActivityLocalizationBundleToken {}

func lodyLiveActivityLocalized(_ key: String) -> String {
    NSLocalizedString(
        key,
        tableName: "Localizable",
        bundle: Bundle(for: LodyLiveActivityLocalizationBundleToken.self),
        value: key,
        comment: ""
    )
}

func lodyLiveActivityStatusLabel(_ status: LodyConversationActivityStatus) -> String {
    switch status {
    case .permission:
        return lodyLiveActivityLocalized("liveActivity.status.permission")
    case .question:
        return lodyLiveActivityLocalized("liveActivity.status.question")
    case .running:
        return lodyLiveActivityLocalized("liveActivity.status.running")
    case .unread:
        return lodyLiveActivityLocalized("liveActivity.status.unread")
    }
}

func lodyLiveActivityPermissionResponseShortLabel(_ state: LodyPermissionResponseState) -> String {
    switch state {
    case .sending:
        return lodyLiveActivityLocalized("liveActivity.permission.response.sending.short")
    case .allowed:
        return lodyLiveActivityLocalized("liveActivity.permission.response.allowed.short")
    case .rejected:
        return lodyLiveActivityLocalized("liveActivity.permission.response.rejected.short")
    case .failed:
        return lodyLiveActivityLocalized("liveActivity.permission.response.failed.short")
    case .timedOut:
        return lodyLiveActivityLocalized("liveActivity.permission.response.timedOut.short")
    }
}

func lodyLiveActivityConversationLabel(
    _ item: LodyConversationLiveActivityAttributes.ConversationItem
) -> String {
    if let responseState = item.permissionResponseState {
        return lodyLiveActivityPermissionResponseShortLabel(responseState)
    }
    return lodyLiveActivityStatusLabel(item.status)
}
