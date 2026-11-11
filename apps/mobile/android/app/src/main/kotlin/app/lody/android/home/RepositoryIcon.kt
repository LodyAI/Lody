package app.lody.android.home

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.Dp
import app.lody.android.designsystem.*

/**
 * Web sidebar identity: the repository owner's cached avatar, gently muted unless [muted] is
 * false (Home's project group labels keep the original colours).
 */
@Composable
fun RepositoryIcon(repository: String?, size: Dp = LodyIconSize.sm, opacity: Float = 0.6f, muted: Boolean = true) {
    val url = repository?.let(ProjectCards::ownerAvatar)
    var image by remember(url) { mutableStateOf(url?.let(AvatarImages::cached)) }
    LaunchedEffect(url) { if (url != null && image == null) image = AvatarImages.load(url) { image = it } }
    val loaded = image
    val modifier = Modifier.size(size).clip(RoundedCornerShape(size / 5))
    if (loaded == null) {
        Icon(LodyIcons.Github, contentDescription = null, tint = LodyTheme.colors.iconSecondary, modifier = modifier)
    } else {
        val filter = remember { ColorFilter.colorMatrix(ColorMatrix().apply { setToSaturation(0.55f) }) }
        Image(loaded, contentDescription = null, contentScale = ContentScale.Crop,
            modifier = modifier, alpha = if (muted) opacity else 1f, colorFilter = if (muted) filter else null)
    }
}
