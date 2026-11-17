// Imported from Lody Mobile; maintained as platform-owned appearance code.

package app.lody.android.designsystem

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/**
 * Lucide-derived icons shared with iOS. Use with `Icon(LodyIcons.Inbox, contentDescription, tint = ...)`;
 * size with `Modifier.size(LodyIconSize.md)`.
 */
object LodyIcons {
    val Inbox: ImageVector by lazy {
        lodyIcon(
            "Inbox",
            "M22 12L16 12L14 15L10 15L8 12L2 12",
            "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z",
        )
    }

    val Session: ImageVector by lazy {
        lodyIcon(
            "Session",
            "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
        )
    }

    val Sessions: ImageVector by lazy {
        lodyIcon(
            "Sessions",
            "M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z",
            "M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1",
        )
    }

    val Project: ImageVector by lazy {
        lodyIcon(
            "Project",
            "M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v5",
            "M11 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0Z",
            "M18 19c-2.8 0-5-2.2-5-5v8",
            "M18 19a2 2 0 1 0 4 0a2 2 0 1 0 -4 0Z",
        )
    }

    val ProjectGroup: ImageVector by lazy {
        lodyIcon(
            "ProjectGroup",
            "M20 17a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3.9a2 2 0 0 1-1.69-.9l-.81-1.2a2 2 0 0 0-1.67-.9H8a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2Z",
            "M2 8v11a2 2 0 0 0 2 2h14",
        )
    }

    val Folder: ImageVector by lazy {
        lodyIcon(
            "Folder",
            "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
        )
    }

    val File: ImageVector by lazy {
        lodyIcon(
            "File",
            "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z",
            "M14 2v4a2 2 0 0 0 2 2h4",
        )
    }

    val FileCode: ImageVector by lazy {
        lodyIcon(
            "FileCode",
            "M4 22h14a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v4",
            "M14 2v4a2 2 0 0 0 2 2h4",
            "m5 12-3 3 3 3",
            "m9 18 3-3-3-3",
        )
    }

    val Search: ImageVector by lazy {
        lodyIcon(
            "Search",
            "m21 21-4.34-4.34",
            "M3 11a8 8 0 1 0 16 0a8 8 0 1 0 -16 0Z",
        )
    }

    val Settings: ImageVector by lazy {
        lodyIcon(
            "Settings",
            "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
            "M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0Z",
        )
    }

    val Compose: ImageVector by lazy {
        lodyIcon(
            "Compose",
            "M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7",
            "M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z",
        )
    }

    val More: ImageVector by lazy {
        lodyIcon(
            "More",
            "M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0Z",
            "M18 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0Z",
            "M4 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0Z",
        )
    }

    val Filter: ImageVector by lazy {
        lodyIcon(
            "Filter",
            "M3 6h18",
            "M7 12h10",
            "M10 18h4",
        )
    }

    val Sort: ImageVector by lazy {
        lodyIcon(
            "Sort",
            "m21 16-4 4-4-4",
            "M17 20V4",
            "m3 8 4-4 4 4",
            "M7 4v16",
        )
    }

    val Plus: ImageVector by lazy {
        lodyIcon(
            "Plus",
            "M5 12h14",
            "M12 5v14",
        )
    }

    val Clock: ImageVector by lazy {
        lodyIcon(
            "Clock",
            "M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0Z",
            "M12 6v6l4 2",
        )
    }

    val Play: ImageVector by lazy {
        lodyIcon(
            "Play",
            "M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z",
        )
    }

    val Pause: ImageVector by lazy {
        lodyIcon(
            "Pause",
            "M15 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z",
            "M6 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z",
        )
    }

    val Close: ImageVector by lazy {
        lodyIcon(
            "Close",
            "M18 6 6 18",
            "m6 6 12 12",
        )
    }

    val Check: ImageVector by lazy {
        lodyIcon(
            "Check",
            "M20 6 9 17l-5-5",
        )
    }

    val Back: ImageVector by lazy {
        lodyIcon(
            "Back",
            "m15 18-6-6 6-6",
        )
    }

    val Forward: ImageVector by lazy {
        lodyIcon(
            "Forward",
            "m9 18 6-6-6-6",
        )
    }

    val Expand: ImageVector by lazy {
        lodyIcon(
            "Expand",
            "m6 9 6 6 6-6",
        )
    }

    val Collapse: ImageVector by lazy {
        lodyIcon(
            "Collapse",
            "m18 15-6-6-6 6",
        )
    }

    val Send: ImageVector by lazy {
        lodyIcon(
            "Send",
            "m5 12 7-7 7 7",
            "M12 19V5",
        )
    }

    val Stop: ImageVector by lazy {
        lodyIcon(
            "Stop",
            "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2Z",
        )
    }

    val Attach: ImageVector by lazy {
        lodyIcon(
            "Attach",
            "m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551",
        )
    }

    val Image: ImageVector by lazy {
        lodyIcon(
            "Image",
            "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2Z",
            "M7 9a2 2 0 1 0 4 0a2 2 0 1 0 -4 0Z",
            "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21",
        )
    }

    val Mic: ImageVector by lazy {
        lodyIcon(
            "Mic",
            "M12 19v3",
            "M19 10v2a7 7 0 0 1-14 0v-2",
            "M12 2h0a3 3 0 0 1 3 3v7a3 3 0 0 1 -3 3h0a3 3 0 0 1 -3 -3v-7a3 3 0 0 1 3 -3Z",
        )
    }

    val AtSign: ImageVector by lazy {
        lodyIcon(
            "AtSign",
            "M8 12a4 4 0 1 0 8 0a4 4 0 1 0 -8 0Z",
            "M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8",
        )
    }

    val Copy: ImageVector by lazy {
        lodyIcon(
            "Copy",
            "M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-10a2 2 0 0 1 2 -2Z",
            "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2",
        )
    }

    val Edit: ImageVector by lazy {
        lodyIcon(
            "Edit",
            "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",
            "m15 5 4 4",
        )
    }

    val Trash: ImageVector by lazy {
        lodyIcon(
            "Trash",
            "M3 6h18",
            "M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6",
            "M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2",
            "M10 11L10 17",
            "M14 11L14 17",
        )
    }

    val Share: ImageVector by lazy {
        lodyIcon(
            "Share",
            "M12 2v13",
            "m16 6-4-4-4 4",
            "M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8",
        )
    }

    val Download: ImageVector by lazy {
        lodyIcon(
            "Download",
            "M12 15V3",
            "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4",
            "m7 10 5 5 5-5",
        )
    }

    val Link: ImageVector by lazy {
        lodyIcon(
            "Link",
            "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",
            "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
        )
    }

    val ExternalLink: ImageVector by lazy {
        lodyIcon(
            "ExternalLink",
            "M15 3h6v6",
            "M10 14 21 3",
            "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
        )
    }

    val Refresh: ImageVector by lazy {
        lodyIcon(
            "Refresh",
            "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8",
            "M21 3v5h-5",
            "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16",
            "M8 16H3v5",
        )
    }

    val Undo: ImageVector by lazy {
        lodyIcon(
            "Undo",
            "M9 14 4 9l5-5",
            "M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11",
        )
    }

    val Star: ImageVector by lazy {
        lodyIcon(
            "Star",
            "M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z",
        )
    }

    val Pin: ImageVector by lazy {
        lodyIcon(
            "Pin",
            "M12 17v5",
            "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z",
        )
    }

    val Bell: ImageVector by lazy {
        lodyIcon(
            "Bell",
            "M10.268 21a2 2 0 0 0 3.464 0",
            "M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326",
        )
    }

    val Mail: ImageVector by lazy {
        lodyIcon(
            "Mail",
            "m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7",
            "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z",
        )
    }

    val ArrowLeft: ImageVector by lazy {
        lodyIcon(
            "ArrowLeft",
            "m12 19-7-7 7-7",
            "M19 12H5",
        )
    }

    val ArrowRight: ImageVector by lazy {
        lodyIcon(
            "ArrowRight",
            "M5 12h14",
            "m12 5 7 7-7 7",
        )
    }

    val EyeOff: ImageVector by lazy {
        lodyIcon(
            "EyeOff",
            "M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49",
            "M14.084 14.158a3 3 0 0 1-4.242-4.242",
            "M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143",
            "m2 2 20 20",
        )
    }

    val Eye: ImageVector by lazy {
        lodyIcon(
            "Eye",
            "M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0",
            "M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0Z",
        )
    }

    val Lock: ImageVector by lazy {
        lodyIcon(
            "Lock",
            "M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-7a2 2 0 0 1 2 -2Z",
            "M7 11V7a5 5 0 0 1 10 0v4",
        )
    }

    val User: ImageVector by lazy {
        lodyIcon(
            "User",
            "M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2",
            "M8 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0Z",
        )
    }

    val Agent: ImageVector by lazy {
        lodyIcon(
            "Agent",
            "M12 8V4H8",
            "M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-8a2 2 0 0 1 2 -2Z",
            "M2 14h2",
            "M20 14h2",
            "M15 13v2",
            "M9 13v2",
        )
    }

    val Sparkles: ImageVector by lazy {
        lodyIcon(
            "Sparkles",
            "M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z",
            "M20 3v4",
            "M22 5h-4",
            "M4 17v2",
            "M5 18H3",
        )
    }

    val Terminal: ImageVector by lazy {
        lodyIcon(
            "Terminal",
            "M12 19h8",
            "m4 17 6-6-6-6",
        )
    }

    val Machine: ImageVector by lazy {
        lodyIcon(
            "Machine",
            "M18 5a2 2 0 0 1 2 2v8.526a2 2 0 0 0 .212.897l1.068 2.127a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45l1.068-2.127A2 2 0 0 0 4 15.526V7a2 2 0 0 1 2-2z",
            "M20.054 15.987H3.946",
        )
    }

    val Desktop: ImageVector by lazy {
        lodyIcon(
            "Desktop",
            "M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-10a2 2 0 0 1 2 -2Z",
            "M8 21L16 21",
            "M12 17L12 21",
        )
    }

    val Server: ImageVector by lazy {
        lodyIcon(
            "Server",
            "M4 2h16a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-4a2 2 0 0 1 2 -2Z",
            "M4 14h16a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-4a2 2 0 0 1 2 -2Z",
            "M6 6L6.01 6",
            "M6 18L6.01 18",
        )
    }

    val Cloud: ImageVector by lazy {
        lodyIcon(
            "Cloud",
            "M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z",
        )
    }

    val Branch: ImageVector by lazy {
        lodyIcon(
            "Branch",
            "M6 3L6 15",
            "M15 6a3 3 0 1 0 6 0a3 3 0 1 0 -6 0Z",
            "M3 18a3 3 0 1 0 6 0a3 3 0 1 0 -6 0Z",
            "M18 9a9 9 0 0 1-9 9",
        )
    }

    val Commit: ImageVector by lazy {
        lodyIcon(
            "Commit",
            "M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0Z",
            "M3 12L9 12",
            "M15 12L21 12",
        )
    }

    val PullRequest: ImageVector by lazy {
        lodyIcon(
            "PullRequest",
            "M15 18a3 3 0 1 0 6 0a3 3 0 1 0 -6 0Z",
            "M3 6a3 3 0 1 0 6 0a3 3 0 1 0 -6 0Z",
            "M13 6h3a2 2 0 0 1 2 2v7",
            "M6 9L6 21",
            strokeWidth = 2.25f,
        )
    }

    val PullRequestClosed: ImageVector by lazy {
        lodyIcon(
            "PullRequestClosed",
            "M3 6a3 3 0 1 0 6 0a3 3 0 1 0 -6 0Z",
            "M6 9v12",
            "m21 3-6 6",
            "m21 9-6-6",
            "M18 11.5V15",
            "M15 18a3 3 0 1 0 6 0a3 3 0 1 0 -6 0Z",
            strokeWidth = 2.25f,
        )
    }

    val PullRequestDraft: ImageVector by lazy {
        lodyIcon(
            "PullRequestDraft",
            "M15 18a3 3 0 1 0 6 0a3 3 0 1 0 -6 0Z",
            "M3 6a3 3 0 1 0 6 0a3 3 0 1 0 -6 0Z",
            "M18 6V5",
            "M18 11v-1",
            "M6 9L6 21",
            strokeWidth = 2.25f,
        )
    }

    val Github: ImageVector by lazy {
        lodyIcon(
            "Github",
            "M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4",
            "M9 18c-4.51 2-5-2-7-2",
        )
    }

    val Hand: ImageVector by lazy {
        lodyIcon(
            "Hand",
            "M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2",
            "M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2",
            "M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8",
            "M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15",
        )
    }

    /** Lucide `fold-vertical`: squash and merge. */
    val Squash: ImageVector by lazy {
        lodyIcon(
            "Squash",
            "M12 22v-6", "M12 8V2", "M4 12H2", "M10 12H8", "M16 12h-2", "M22 12h-2",
            "m15 19-3-3-3 3", "m15 5-3 3-3-3",
        )
    }

    /** Lucide `layers`: rebase and merge. */
    val Rebase: ImageVector by lazy {
        lodyIcon(
            "Rebase",
            "M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z",
            "m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65",
            "m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65",
        )
    }

    val Merge: ImageVector by lazy {
        lodyIcon(
            "Merge",
            "M15 18a3 3 0 1 0 6 0a3 3 0 1 0 -6 0Z",
            "M3 6a3 3 0 1 0 6 0a3 3 0 1 0 -6 0Z",
            "M6 21V9a9 9 0 0 0 9 9",
            strokeWidth = 2.25f,
        )
    }

    val Diff: ImageVector by lazy {
        lodyIcon(
            "Diff",
            "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z",
            "M9 10h6",
            "M12 13V7",
            "M9 17h6",
        )
    }

    val StateIdle: ImageVector by lazy {
        lodyIcon(
            "StateIdle",
            "M10.1 2.182a10 10 0 0 1 3.8 0",
            "M13.9 21.818a10 10 0 0 1-3.8 0",
            "M17.609 3.721a10 10 0 0 1 2.69 2.7",
            "M2.182 13.9a10 10 0 0 1 0-3.8",
            "M20.279 17.609a10 10 0 0 1-2.7 2.69",
            "M21.818 10.1a10 10 0 0 1 0 3.8",
            "M3.721 6.391a10 10 0 0 1 2.7-2.69",
            "M6.391 20.279a10 10 0 0 1-2.69-2.7",
        )
    }

    val StateRunning: ImageVector by lazy {
        lodyIcon(
            "StateRunning",
            "M21 12a9 9 0 1 1-6.219-8.56",
        )
    }

    val StateWaiting: ImageVector by lazy {
        lodyIcon(
            "StateWaiting",
            "M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0Z",
            "M10 15L10 9",
            "M14 15L14 9",
        )
    }

    val StateDone: ImageVector by lazy {
        lodyIcon(
            "StateDone",
            "M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0Z",
            "m9 12 2 2 4-4",
        )
    }

    val StateFailed: ImageVector by lazy {
        lodyIcon(
            "StateFailed",
            "M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0Z",
            "m15 9-6 6",
            "m9 9 6 6",
        )
    }

    val Alert: ImageVector by lazy {
        lodyIcon(
            "Alert",
            "M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0Z",
            "M12 8L12 12",
            "M12 16L12.01 16",
        )
    }

    val Info: ImageVector by lazy {
        lodyIcon(
            "Info",
            "M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0Z",
            "M12 16v-4",
            "M12 8h.01",
        )
    }

    val Sun: ImageVector by lazy {
        lodyIcon(
            "Sun",
            "M8 12a4 4 0 1 0 8 0a4 4 0 1 0 -8 0Z",
            "M12 2v2",
            "M12 20v2",
            "m4.93 4.93 1.41 1.41",
            "m17.66 17.66 1.41 1.41",
            "M2 12h2",
            "M20 12h2",
            "m6.34 17.66-1.41 1.41",
            "m19.07 4.93-1.41 1.41",
        )
    }

    val Moon: ImageVector by lazy {
        lodyIcon(
            "Moon",
            "M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z",
        )
    }

    val LogOut: ImageVector by lazy {
        lodyIcon(
            "LogOut",
            "m16 17 5-5-5-5",
            "M21 12H9",
            "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4",
        )
    }

    val PermissionWarning: ImageVector by lazy {
        lodyIcon(
            "PermissionWarning",
            "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
            "M12 8v4",
            "M12 16h.01",
        )
    }

    val PermissionPlan: ImageVector by lazy {
        lodyIcon(
            "PermissionPlan",
            "m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z",
            "M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0Z",
        )
    }

    val PermissionDefault: ImageVector by lazy {
        lodyIcon(
            "PermissionDefault",
            "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
        )
    }

    val all: List<Pair<String, ImageVector>> by lazy {
        listOf(
            "inbox" to Inbox,
            "session" to Session,
            "sessions" to Sessions,
            "project" to Project,
            "projectGroup" to ProjectGroup,
            "folder" to Folder,
            "file" to File,
            "fileCode" to FileCode,
            "search" to Search,
            "settings" to Settings,
            "compose" to Compose,
            "more" to More,
            "filter" to Filter,
            "sort" to Sort,
            "plus" to Plus,
            "clock" to Clock,
            "play" to Play,
            "pause" to Pause,
            "close" to Close,
            "check" to Check,
            "back" to Back,
            "forward" to Forward,
            "expand" to Expand,
            "collapse" to Collapse,
            "send" to Send,
            "stop" to Stop,
            "attach" to Attach,
            "image" to Image,
            "mic" to Mic,
            "atSign" to AtSign,
            "copy" to Copy,
            "edit" to Edit,
            "trash" to Trash,
            "share" to Share,
            "link" to Link,
            "externalLink" to ExternalLink,
            "refresh" to Refresh,
            "undo" to Undo,
            "star" to Star,
            "pin" to Pin,
            "bell" to Bell,
            "eye" to Eye,
            "eyeOff" to EyeOff,
            "mail" to Mail,
            "arrowLeft" to ArrowLeft,
            "arrowRight" to ArrowRight,
            "lock" to Lock,
            "user" to User,
            "agent" to Agent,
            "sparkles" to Sparkles,
            "terminal" to Terminal,
            "machine" to Machine,
            "desktop" to Desktop,
            "server" to Server,
            "cloud" to Cloud,
            "branch" to Branch,
            "commit" to Commit,
            "pullRequest" to PullRequest,
            "pullRequestClosed" to PullRequestClosed,
            "pullRequestDraft" to PullRequestDraft,
            "github" to Github,
            "hand" to Hand,
            "merge" to Merge,
            "diff" to Diff,
            "stateIdle" to StateIdle,
            "stateRunning" to StateRunning,
            "stateWaiting" to StateWaiting,
            "stateDone" to StateDone,
            "stateFailed" to StateFailed,
            "alert" to Alert,
            "info" to Info,
            "sun" to Sun,
            "moon" to Moon,
            "logOut" to LogOut,
            "permissionWarning" to PermissionWarning,
            "permissionPlan" to PermissionPlan,
            "permissionDefault" to PermissionDefault,
        )
    }
}

private fun lodyIcon(name: String, vararg paths: String, strokeWidth: Float = 1.75f): ImageVector =
    ImageVector.Builder(
        name = "Lody.$name",
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
    ).apply {
        for (d in paths) {
            addPath(
                pathData = addPathNodes(d),
                stroke = SolidColor(Color.Black),
                strokeLineWidth = strokeWidth,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            )
        }
    }.build()
