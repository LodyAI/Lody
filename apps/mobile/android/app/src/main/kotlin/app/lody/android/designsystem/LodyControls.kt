@file:OptIn(androidx.compose.material3.ExperimentalMaterial3ExpressiveApi::class)

package app.lody.android.designsystem

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.size
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.dp

/** Expressive controls with the existing Lody geometry. No page-level spacing belongs here. */
@Composable
fun LodyButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    shape: Shape = ButtonDefaults.shape,
    colors: ButtonColors = ButtonDefaults.buttonColors(),
    elevation: ButtonElevation? = ButtonDefaults.buttonElevation(),
    border: BorderStroke? = null,
    contentPadding: PaddingValues = ButtonDefaults.ContentPadding,
    interactionSource: MutableInteractionSource? = null,
    content: @Composable RowScope.() -> Unit,
) = Button(
    onClick = onClick, modifier = modifier, enabled = enabled,
    shapes = ButtonDefaults.shapes(shape = shape), colors = colors,
    elevation = elevation, border = border, contentPadding = contentPadding,
    interactionSource = interactionSource, content = content,
)

@Composable
fun LodyTextButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    colors: ButtonColors = ButtonDefaults.textButtonColors(),
    contentPadding: PaddingValues = ButtonDefaults.TextButtonContentPadding,
    content: @Composable RowScope.() -> Unit,
) = TextButton(
    onClick = onClick, modifier = modifier, enabled = enabled,
    shapes = ButtonDefaults.shapes(shape = ButtonDefaults.textShape),
    colors = colors, contentPadding = contentPadding, content = content,
)

@Composable
fun LodyIconButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    colors: IconButtonColors = IconButtonDefaults.iconButtonColors(),
    content: @Composable () -> Unit,
) = IconButton(
    onClick = onClick, modifier = modifier.size(LodySize.controlLg), enabled = enabled,
    shapes = IconButtonDefaults.shapes(), colors = colors, content = content,
)

/** For existing fixed-size controls (send, new chat). The caller owns their occupied bounds. */
@Composable
fun LodyFilledIconButton(
    onClick: () -> Unit,
    modifier: Modifier,
    enabled: Boolean = true,
    colors: IconButtonColors = IconButtonDefaults.filledIconButtonColors(),
    content: @Composable () -> Unit,
) {
    CompositionLocalProvider(LocalMinimumInteractiveComponentSize provides 0.dp) {
        FilledIconButton(
            onClick = onClick, modifier = modifier, enabled = enabled,
            shapes = IconButtonDefaults.shapes(), colors = colors, content = content,
        )
    }
}

/** M3E indeterminate loading, constrained by each existing inline indicator's bounds. */
@Composable
fun LodyLoadingIndicator(
    modifier: Modifier = Modifier,
    color: androidx.compose.ui.graphics.Color = MaterialTheme.colorScheme.primary,
) = LoadingIndicator(modifier = modifier, color = color)
