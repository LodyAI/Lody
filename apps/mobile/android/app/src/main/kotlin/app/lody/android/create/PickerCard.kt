package app.lody.android.create

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.lody.android.designsystem.LodyIconSize
import app.lody.android.designsystem.LodyIcons
import app.lody.android.designsystem.LodyRadius
import app.lody.android.designsystem.LodySize
import app.lody.android.designsystem.LodySpacing
import app.lody.android.designsystem.LodyTheme
import app.lody.android.home.AgentMark

// Shared pickers: new chat's computer / project lines and run-config rows, and the Agent Role
// editor's computer and Agent lines.

internal data class PickerOption(
    val id: String,
    val title: String,
    val selected: Boolean,
    val subtitle: String = "",
    val icon: ImageVector? = null,
    val disabled: Boolean = false,
    /** An agent's provider (cliType to agentType): leads with its mark instead of [icon]. */
    val agent: Pair<String, String>? = null,
    /** An Agent Role's emoji, shown instead of an icon. */
    val emoji: String? = null,
    val repository: String? = null,
)

/** The option's leading mark: the agent's provider mark, else its icon. */
@Composable
internal fun OptionMark(option: PickerOption, size: androidx.compose.ui.unit.Dp) {
    val tint = LodyTheme.colors.iconSecondary
    when {
        option.repository != null -> app.lody.android.home.RepositoryIcon(option.repository, size, opacity = 0.8f)
        option.emoji != null -> Box(Modifier.size(size), contentAlignment = Alignment.Center) {
            Text(option.emoji, fontSize = with(androidx.compose.ui.platform.LocalDensity.current) { (size * 0.85f).toSp() })
        }
        option.agent != null -> AgentMark(option.agent.first, option.agent.second, tint, Modifier.size(size))
        option.icon != null -> Icon(option.icon, contentDescription = null, tint = tint, modifier = Modifier.size(size))
    }
}

/**
 * A plain full-width line (no fill, as iOS); its options expand in place right below it. The
 * panel is bottom-anchored, so the list is revealed from its top edge and moves up with the
 * layout instead of sliding against it.
 */
@Composable
internal fun PickerCard(
    icon: ImageVector,
    title: String,
    placeholder: Boolean,
    options: List<PickerOption>,
    open: Boolean,
    onToggle: () -> Unit,
    onPick: (String) -> Unit,
    searchOptions: List<PickerOption>? = null,
    searchPlaceholder: String = "",
    expandAllOn: String? = null,
    onSearchFocus: (Boolean) -> Unit = {},
    scopeLabel: String = "",
    repository: String? = null,
) {
    val colors = LodyTheme.colors
    Column {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = LodySize.controlLg)
                .clip(RoundedCornerShape(LodyRadius.md))
                .clickable(enabled = options.isNotEmpty(), role = Role.Button, onClick = onToggle)
                .semantics { contentDescription = title }
                .padding(horizontal = LodySpacing.xs),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(LodySpacing.md),
        ) {
            if (repository != null) app.lody.android.home.RepositoryIcon(repository, LodyIconSize.md, opacity = 0.8f)
            else Icon(icon, contentDescription = null, tint = colors.iconSecondary, modifier = Modifier.size(LodyIconSize.md))
            Text(
                title,
                style = LodyTheme.typography.body,
                color = if (placeholder) colors.textTertiary else colors.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.MiddleEllipsis,
                modifier = Modifier.weight(1f),
            )
            if (options.isNotEmpty()) PopupIndicator()
        }
        AnimatedVisibility(
            open,
            enter = expandVertically(expandFrom = Alignment.Top) + fadeIn(),
            exit = shrinkVertically(shrinkTowards = Alignment.Top) + fadeOut(),
        ) {
            Column {
                if (scopeLabel.isNotEmpty()) {
                    Text(
                        scopeLabel,
                        style = LodyTheme.typography.footnote,
                        color = colors.textTertiary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(horizontal = LodySpacing.xs, vertical = LodySpacing.xs),
                    )
                }
                OptionList(options, searchOptions, searchPlaceholder, onPick, expandAllOn, onSearchFocus = onSearchFocus)
            }
        }
    }
}

/** The pop-up indicator (⌃⌄), drawn as a stacked up / down pair. */
@Composable
internal fun PopupIndicator() {
    val tint = LodyTheme.colors.iconTertiary
    Column {
        Icon(LodyIcons.Collapse, contentDescription = null, tint = tint, modifier = Modifier.size(LodyIconSize.xs))
        Icon(LodyIcons.Expand, contentDescription = null, tint = tint, modifier = Modifier.size(LodyIconSize.xs))
    }
}

/** The expanded options, aligned with the line (no indent or surface): search, then rows. */
@Composable
internal fun OptionList(
    options: List<PickerOption>,
    searchOptions: List<PickerOption>?,
    searchPlaceholder: String,
    onPick: (String) -> Unit,
    expandAllOn: String?,
    expandsToContent: Boolean = false,
    onSearchFocus: (Boolean) -> Unit = {},
) {
    val dismissKeyboard = rememberKeyboardDismissal()
    val colors = LodyTheme.colors
    val type = LodyTheme.typography
    var query by remember { mutableStateOf("") }
    var all by remember { mutableStateOf(false) }
    val term = query.trim()
    val shown = when {
        term.isNotEmpty() -> (searchOptions ?: options).filter { "${it.title} ${it.subtitle}".contains(term, ignoreCase = true) }
        all && searchOptions != null -> searchOptions
        else -> options
    }
    Column(Modifier.fillMaxWidth()) {
        if (searchOptions != null || options.size > 8) {
            Row(
                Modifier.fillMaxWidth().heightIn(min = LodySize.controlMd).padding(horizontal = LodySpacing.xs),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(LodySpacing.md),
            ) {
                Icon(LodyIcons.Search, contentDescription = null, tint = colors.iconTertiary, modifier = Modifier.size(LodyIconSize.md))
                BasicTextField(
                    value = query,
                    onValueChange = { query = it },
                    singleLine = true,
                    textStyle = type.body.copy(color = colors.textPrimary),
                    cursorBrush = SolidColor(colors.accentDefault),
                    modifier = Modifier.weight(1f).onFocusChanged { onSearchFocus(it.isFocused) },
                    decorationBox = { inner ->
                        Box {
                            if (query.isEmpty()) Text(searchPlaceholder, style = type.body, color = colors.textPlaceholder)
                            inner()
                        }
                    },
                )
            }
        }
        val optionContent: @Composable (PickerOption) -> Unit = { option ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = LodySize.listRow)
                        .clip(RoundedCornerShape(LodyRadius.md))
                        .clickable(enabled = !option.disabled, role = Role.Button) { dismissKeyboard(); if (option.id == expandAllOn) all = true; onPick(option.id) }
                        .semantics { selected = option.selected }
                        .padding(horizontal = LodySpacing.xs, vertical = LodySpacing.xs),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(LodySpacing.md),
                ) {
                    OptionMark(option, LodyIconSize.md)
                    Column(Modifier.weight(1f)) {
                        Text(option.title, style = type.body, color = colors.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (option.subtitle.isNotEmpty()) {
                            Text(option.subtitle, style = type.footnote, color = colors.textTertiary, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
                        }
                    }
                    if (option.selected) Icon(LodyIcons.Check, contentDescription = null, tint = colors.accentFg, modifier = Modifier.size(LodyIconSize.sm))
                }
        }
        if (expandsToContent) {
            Column { shown.forEach { option -> androidx.compose.runtime.key(option.id) { optionContent(option) } } }
        } else {
            LazyColumn(Modifier.heightIn(max = 280.dp)) {
                items(shown, key = { it.id }) { option -> optionContent(option) }
            }
        }
    }
}

