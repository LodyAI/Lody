package app.lody.android.chat

import android.text.format.DateUtils
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import app.lody.android.R
import app.lody.android.designsystem.*
import app.lody.android.runtime.SessionUsage
import java.text.DateFormat
import java.text.NumberFormat
import java.util.Date
import kotlin.math.roundToInt

@Composable
internal fun SessionUsageButton(usage: SessionUsage?) {
    if (usage == null || !usage.visible) return
    var open by remember { mutableStateOf(false) }
    val colors = LodyTheme.colors
    val label = if (usage.compacting) stringResource(R.string.usage_compacting)
        else stringResource(R.string.usage_open, (usage.triggerPercent ?: 0.0).roundToInt())
    Box {
        TextButton(onClick = { open = true }, modifier = Modifier.semantics { contentDescription = label }) {
            if (usage.compacting) CircularProgressIndicator(Modifier.size(LodyIconSize.sm), color = colors.textSecondary)
            else {
                CircularProgressIndicator(progress = { ((usage.triggerPercent ?: 0.0) / 100).toFloat() },
                    modifier = Modifier.size(LodyIconSize.sm), color = colors.textSecondary, trackColor = colors.fillSecondary)
                Text("${usage.triggerPercent!!.roundToInt()}%", style = LodyTheme.typography.caption, color = colors.textSecondary)
            }
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            Column(Modifier.widthIn(max = LodySize.controlLg * 7).padding(LodySpacing.md), verticalArrangement = Arrangement.spacedBy(LodySpacing.sm)) {
                if (usage.compacting) Text(stringResource(R.string.usage_compacting), style = LodyTheme.typography.caption)
                else usage.context?.let { context ->
                    UsageMeter(stringResource(R.string.usage_context), context.percent)
                    val numbers = NumberFormat.getNumberInstance()
                    Text(stringResource(R.string.usage_tokens, numbers.format(context.used), numbers.format(context.size)), style = LodyTheme.typography.caption)
                }
                usage.quota?.let { quota ->
                    if (usage.context != null || usage.compacting) HorizontalDivider()
                    UsageQuotaView(quota)
                }
            }
        }
    }
}

@Composable
private fun UsageMeter(label: String, percent: Double) {
    val used = stringResource(R.string.usage_used, percent.roundToInt())
    Column(verticalArrangement = Arrangement.spacedBy(LodySpacing.xxs)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(label, style = LodyTheme.typography.caption, modifier = Modifier.weight(1f))
            Text(used, style = LodyTheme.typography.caption)
        }
        LinearProgressIndicator(progress = { (percent / 100).toFloat() }, modifier = Modifier.fillMaxWidth().semantics { contentDescription = "$label: $used" }, color = LodyTheme.colors.textSecondary, trackColor = LodyTheme.colors.fillSecondary)
    }
}

@Composable
private fun ResetTime(epochSeconds: Double) {
    var absolute by remember(epochSeconds) { mutableStateOf(false) }
    val millis = (epochSeconds * 1000).toLong()
    val time = if (absolute) DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(millis))
        else DateUtils.getRelativeTimeSpanString(millis, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS).toString()
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(stringResource(R.string.usage_resets, time), style = LodyTheme.typography.caption, modifier = Modifier.weight(1f))
        TextButton(onClick = { absolute = !absolute }) {
            Text(stringResource(if (absolute) R.string.usage_relative else R.string.usage_absolute), style = LodyTheme.typography.caption)
        }
    }
}

@Composable
internal fun UsageQuotaView(quota: app.lody.android.runtime.UsageQuota) {
    Column(verticalArrangement = Arrangement.spacedBy(LodySpacing.sm)) {
                    Text(quota.name ?: stringResource(R.string.usage_model), style = LodyTheme.typography.subhead)
                    if (quota.windows.sortedByDescending { it.duration ?: 0.0 }.isEmpty()) Text(stringResource(R.string.usage_unavailable), style = LodyTheme.typography.caption)
                    quota.windows.sortedByDescending { it.duration ?: 0.0 }.forEach { window ->
                        val duration = when (window.duration) {
                            604800.0 -> stringResource(R.string.usage_weekly)
                            18000.0 -> stringResource(R.string.usage_five_hours)
                            null -> stringResource(R.string.usage_title)
                            else -> {
                                val seconds = window.duration
                                val unit = if (seconds % 86400 == 0.0) 86400 else if (seconds % 3600 == 0.0) 3600 else 60
                                stringResource(if (unit == 86400) R.string.usage_days else if (unit == 3600) R.string.usage_hours else R.string.usage_minutes, NumberFormat.getNumberInstance().format(seconds / unit))
                            }
                        }
                        UsageMeter(listOfNotNull(duration, window.label).joinToString(" · "), window.usedPercent)
                        window.resetsAt?.let { ResetTime(it) }
                    }
    }
}
