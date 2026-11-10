package app.lody.android.home

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import app.lody.android.R
import app.lody.android.auth.Workspace
import app.lody.android.designsystem.*

/** iOS SettingsSections ordering, with platform-native sheets for account/workspace selection. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SettingsHome(state: ChatListUiState, padding: PaddingValues, onSelectWorkspace: (Workspace) -> Unit, onSignOut: () -> Unit, onAgents: () -> Unit, onPreferences: () -> Unit, onRoles: () -> Unit, onDeferred: () -> Unit) {
    var sheet by remember { mutableStateOf<String?>(null) }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = padding) {
        item {
            SettingsGroup {
                SettingsLine(state.accountName.ifEmpty { "—" }, LodyIcons.User, state.accountEmail, onClick = { sheet = "account" }, leading = {
                    Avatar(state.accountImage, state.accountName.ifEmpty { "?" }, LodySize.avatarLg)
                })
            }
        }
        item {
            SettingsGroup(stringResource(R.string.settings_personal)) {
                SettingsLine(stringResource(R.string.settings_preferences), LodyIcons.Settings, stringResource(R.string.settings_preferences_hint), onPreferences)
            }
        }
        item {
            SettingsGroup(stringResource(R.string.settings_workspace_named, state.workspaceName)) {
                SettingsLine(stringResource(R.string.settings_workspace_general), LodyIcons.ProjectGroup, stringResource(R.string.settings_workspace_hint), { sheet = "workspace" })
                SettingsLine(stringResource(R.string.settings_agents), LodyIcons.Sparkles, onClick = onAgents)
                SettingsLine(stringResource(R.string.settings_roles), LodyIcons.User, onClick = onRoles)
                SettingsLine(stringResource(R.string.settings_shortcuts), LodyIcons.File, onClick = onDeferred)
                SettingsLine(stringResource(R.string.settings_projects), LodyIcons.Folder, onClick = onDeferred)
                SettingsLine(stringResource(R.string.settings_github), LodyIcons.Github, onClick = onDeferred)
                SettingsLine(stringResource(R.string.settings_usage), LodyIcons.StateRunning, onClick = onDeferred)
                SettingsLine(stringResource(R.string.settings_shares), LodyIcons.Link, onClick = onDeferred)
            }
        }
        item {
            SettingsGroup(stringResource(R.string.settings_sessions)) {
                SettingsLine(stringResource(R.string.settings_archived), LodyIcons.Inbox, onClick = onDeferred)
            }
        }
        item {
            SettingsGroup(stringResource(R.string.settings_additional)) {
                SettingsLine(stringResource(R.string.settings_about), LodyIcons.Info, stringResource(R.string.settings_about_hint), onDeferred)
                SettingsLine(stringResource(R.string.settings_diagnostics), LodyIcons.StateRunning, onClick = onDeferred)
            }
        }
    }
    if (sheet != null) ModalBottomSheet(onDismissRequest = { sheet = null }, containerColor = LodyTheme.colors.bgBase) {
        if (sheet == "workspace") {
            SettingsHeading(stringResource(R.string.home_settings_workspace))
            state.workspaces.forEach { workspace ->
                SettingsLine(workspace.name, if (workspace.id == state.workspaceId) LodyIcons.Check else LodyIcons.ProjectGroup, onClick = {
                    sheet = null
                    if (workspace.id != state.workspaceId) onSelectWorkspace(workspace)
                }, leading = { Avatar(workspace.image, workspace.name, LodySize.avatarMd) })
            }
        } else {
            SettingsHeading(state.accountName)
            TextButton(onClick = { sheet = null; onSignOut() }, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.home_sign_out), color = LodyTheme.colors.dangerDefault)
            }
        }
        Spacer(Modifier.height(LodySpacing.xxl))
    }
}

@Composable
internal fun SettingsHeading(title: String) {
    Text(title, style = LodyTheme.typography.footnote, color = LodyTheme.colors.textSecondary,
        modifier = Modifier.padding(horizontal = LodySpacing.xxl, vertical = LodySpacing.md))
}

@Composable
internal fun SettingsGroup(title: String? = null, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.padding(horizontal = LodySpacing.lg, vertical = LodySpacing.sm)) {
        if (title != null) Text(title, style = LodyTheme.typography.footnote, color = LodyTheme.colors.textSecondary,
            modifier = Modifier.padding(start = LodySpacing.sm, bottom = LodySpacing.sm))
        Column(Modifier.fillMaxWidth(), content = content)
    }
}

@Composable
internal fun SettingsLine(title: String, icon: ImageVector, subtitle: String? = null, onClick: (() -> Unit)? = null, leading: (@Composable () -> Unit)? = null, trailing: (@Composable () -> Unit)? = null) {
    Row(Modifier.fillMaxWidth().heightIn(min = LodySize.controlLg)
        .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
        .padding(horizontal = LodySpacing.lg, vertical = LodySpacing.md),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LodySpacing.md)) {
        if (leading != null) leading() else Icon(icon, null, Modifier.size(LodyIconSize.md), tint = LodyTheme.colors.textSecondary)
        Column(Modifier.weight(1f)) {
            Text(title, style = LodyTheme.typography.body, color = LodyTheme.colors.textPrimary)
            if (!subtitle.isNullOrBlank()) Text(subtitle, style = LodyTheme.typography.footnote, color = LodyTheme.colors.textSecondary)
        }
        if (trailing != null) trailing() else if (onClick != null) Icon(LodyIcons.Forward, null, Modifier.size(LodyIconSize.sm), tint = LodyTheme.colors.textSecondary)
    }
}
