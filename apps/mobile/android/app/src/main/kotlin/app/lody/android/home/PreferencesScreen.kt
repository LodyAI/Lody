package app.lody.android.home

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import app.lody.android.R
import app.lody.android.designsystem.*
import app.lody.android.runtime.RoostPreferences

/**
 * iOS `PreferencesController`: language and notifications open the system's own pages for this
 * app, then the chat's queued-message behaviour. No hint copy and no group label on notifications.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun PreferencesScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    val locale = LocalConfiguration.current.locales[0]
    var behavior by remember { mutableStateOf(AppPreferences.queuedMessageBehavior(context)) }
    var developer by remember { mutableStateOf(RoostPreferences.developer(context)) }
    var roost by remember { mutableStateOf(RoostPreferences.experiment(context)) }
    var menu by remember { mutableStateOf(false) }
    BackHandler(onBack = onBack)
    val open = { intent: Intent ->
        runCatching { context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }.onFailure {
            context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
        Unit
    }
    Scaffold(containerColor = LodyTheme.colors.bgBase, topBar = {
        Row(Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = LodySpacing.sm), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(LodyIcons.Back, stringResource(R.string.settings_agent_back)) }
            Text(stringResource(R.string.settings_preferences), Modifier.weight(1f), style = LodyTheme.typography.headline, color = LodyTheme.colors.textPrimary)
        }
    }) { padding ->
        LazyColumn(Modifier.fillMaxSize(), contentPadding = padding) {
            item {
                SettingsGroup {
                    val language = locale.getDisplayLanguage(locale).replaceFirstChar { it.titlecase(locale) }
                    SettingsLine(stringResource(R.string.preferences_language), LodyIcons.Info, language, onClick = {
                        open(if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
                            Intent(Settings.ACTION_APP_LOCALE_SETTINGS, Uri.fromParts("package", context.packageName, null))
                        else Intent(Settings.ACTION_LOCALE_SETTINGS))
                    })
                }
            }
            item {
                SettingsGroup {
                    SettingsLine(stringResource(R.string.preferences_notifications), LodyIcons.Bell, onClick = {
                        open(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName))
                    })
                }
            }
            item {
                SettingsGroup(stringResource(R.string.preferences_chat)) {
                    Box {
                        SettingsLine(stringResource(R.string.preferences_queued), LodyIcons.Send, onClick = { menu = true }, trailing = {
                            Text(stringResource(if (behavior == AppPreferences.GUIDE) R.string.preferences_queued_guide else R.string.preferences_queued_queue),
                                style = LodyTheme.typography.body, color = LodyTheme.colors.textSecondary)
                        })
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, modifier = Modifier.align(Alignment.CenterEnd)) {
                            listOf(AppPreferences.QUEUE to R.string.preferences_queued_queue, AppPreferences.GUIDE to R.string.preferences_queued_guide).forEach { (value, label) ->
                                DropdownMenuItem(text = { Text(stringResource(label)) }, trailingIcon = {
                                    if (value == behavior) Icon(LodyIcons.Check, null, Modifier.size(LodyIconSize.sm))
                                }, onClick = {
                                    menu = false
                                    behavior = value
                                    AppPreferences.saveQueuedMessageBehavior(context, value)
                                })
                            }
                        }
                    }
                }
            }
            item {
                SettingsGroup(stringResource(R.string.settings_developer)) {
                    SettingsLine(stringResource(R.string.settings_developer_mode), LodyIcons.Settings, trailing = {
                        Switch(checked = developer, onCheckedChange = {
                            developer = it
                            RoostPreferences.setDeveloper(context, it)
                        })
                    })
                }
            }
            if (developer) {
                item {
                    SettingsGroup {
                        SettingsLine(stringResource(R.string.settings_roost_history), LodyIcons.Server,
                            subtitle = stringResource(R.string.settings_roost_history_hint), trailing = {
                                Switch(checked = roost, onCheckedChange = {
                                    roost = it
                                    RoostPreferences.setExperiment(context, it)
                                })
                            })
                    }
                }
            }
        }
    }
}
