package app.lody.android.auth

import android.app.Activity
import android.content.ActivityNotFoundException
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.max
import androidx.compose.ui.unit.min
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.LifecycleOwner
import app.lody.android.R
import app.lody.android.designsystem.LodyIconSize
import app.lody.android.designsystem.LodyIcons
import app.lody.android.designsystem.LodyLoginColors
import app.lody.android.designsystem.LodyLoginMetrics as M
import app.lody.android.designsystem.LodyMotion
import app.lody.android.designsystem.LodyRadius
import app.lody.android.designsystem.LodySpacing
import app.lody.android.designsystem.LodyStroke
import app.lody.android.designsystem.LodyTheme
import app.lody.android.designsystem.login
import kotlinx.coroutines.Job

private enum class LoginView { Providers, Email }

/** What the last email request was for, so a sent mail reads as "Next steps" or a reset notice. */
private enum class MailRequest { None, Verification, Reset }

/**
 * Native sign-in, laid out as web `/login` (`login-page.tsx`) and kept in step with iOS
 * `OnboardingController`: the dithered jellyfish surface on top, then a bottom-anchored column
 * with the title, one group of equal provider buttons, the email entry and the legal notice. The
 * email view slides in beside the providers and folds the visual away.
 */
@Composable
internal fun NativeSignInScreen(state: AuthState, account: AccountController, activity: Activity) {
    val colors = LodyTheme.login
    val context = LocalContext.current
    val focus = LocalFocusManager.current
    // Passwords are intentionally not saveable: no Bundle, disk, or process restoration.
    var password by remember { mutableStateOf("") }
    var email by rememberSaveable { mutableStateOf("") }
    var name by rememberSaveable { mutableStateOf("") }
    var view by rememberSaveable { mutableStateOf(LoginView.Providers) }
    var register by rememberSaveable { mutableStateOf(false) }
    var problem by remember { mutableStateOf<LoginForm.Problem?>(null) }
    var started by remember { mutableStateOf<LastLoginMethod?>(null) }
    var mail by remember { mutableStateOf(MailRequest.None) }
    var sentTo by remember { mutableStateOf("") }
    var googleJob by remember { mutableStateOf<Job?>(null) }
    val lastUsed = remember { LastLoginMethod.read(context) }
    val working = state.busy || state.browserPending

    // The method that installed the account is remembered once the page goes away signed in.
    val currentStarted by rememberUpdatedState(started)
    DisposableEffect(activity) {
        onDispose {
            googleJob?.cancel()
            val method = currentStarted
            if (method != null && account.state.value.account != null) LastLoginMethod.write(context, method)
        }
    }
    BackHandler(working) { account.cancel() }
    BackHandler(!working && view == LoginView.Email) { view = LoginView.Providers; password = ""; problem = null; mail = MailRequest.None }

    fun browser(provider: BrowserProvider) {
        started = LastLoginMethod.of(provider); problem = null; mail = MailRequest.None
        account.browser(provider) { url ->
            try { CustomTabsIntent.Builder().build().launchUrl(activity, Uri.parse(url)) }
            catch (_: ActivityNotFoundException) { throw AuthFailure("browser_unavailable") }
        }
    }
    fun google() {
        started = LastLoginMethod.Google; problem = null; mail = MailRequest.None
        googleJob = account.google { googleIdToken(activity, it) }
    }
    fun submitEmail() {
        val found = LoginForm.problem(register, name, email, password)
        problem = found
        if (found != null) return
        focus.clearFocus()
        started = LastLoginMethod.Email
        val address = email.trim().lowercase()
        if (register) { mail = MailRequest.Verification; sentTo = address; account.register(name, address, password) }
        else { mail = MailRequest.None; account.login(address, password) }
        password = ""
    }
    fun resend() {
        val address = email.trim()
        if (!LoginForm.isEmail(address)) { problem = LoginForm.Problem.EmailInvalid; return }
        problem = null; mail = MailRequest.Verification; sentTo = address; password = ""
        account.sendVerification(address)
    }
    fun reset() {
        val address = email.trim()
        if (!LoginForm.isEmail(address)) { problem = LoginForm.Problem.EmailInvalid; return }
        problem = null; mail = MailRequest.Reset; password = ""
        account.requestReset(address)
    }

    val verifying = view == LoginView.Email && mail == MailRequest.Verification && !working &&
        (state.notice == "verify_email" || state.notice == "email_sent")
    val error: String? = problem?.let { stringResource(problemText(it)) }
        ?: state.failure?.let { stringResource(authError(it)) }
    val notice: String? = if (!verifying && mail == MailRequest.Reset && state.notice == "email_sent") stringResource(R.string.auth_email_sent) else null

    val insets = WindowInsets.safeDrawing.asPaddingValues()
    Column(
        Modifier.fillMaxSize().background(colors.page)
            .padding(top = max(M.pageInset, insets.calculateTopPadding()))
            .windowInsetsPadding(WindowInsets.navigationBars.union(WindowInsets.ime)),
    ) {
        BoxWithConstraints(Modifier.fillMaxWidth().weight(1f)) {
            val landscape = LocalConfiguration.current.screenHeightDp < 600 &&
                LocalConfiguration.current.screenWidthDp > LocalConfiguration.current.screenHeightDp
            val folded = view == LoginView.Email || landscape
            val target = if (folded) 0.dp else min(M.visualMax, max(M.visualMin, maxHeight * M.visualFraction))
            val visualHeight by animateDpAsState(target, tween(M.transitionMillis, easing = M.transitionEasing), label = "visual")
            val visualAlpha by animateFloatAsState(if (folded) 0f else 1f, tween(M.transitionMillis, easing = M.transitionEasing), label = "visualAlpha")
            val panelHeight = maxHeight - visualHeight
            Column(Modifier.fillMaxSize()) {
                if (visualHeight > 0.dp) LoginVisual(colors, visualAlpha, activity, Modifier.padding(horizontal = M.pageInset).fillMaxWidth().height(visualHeight))
                Column(
                    Modifier.fillMaxWidth().height(panelHeight).verticalScroll(rememberScrollState()),
                ) {
                    Column(
                        Modifier.fillMaxWidth().heightIn(min = panelHeight)
                            .padding(start = M.pageInset + M.columnInset, end = M.pageInset + M.columnInset, top = M.columnTop, bottom = M.pageInset * 2),
                        verticalArrangement = Arrangement.spacedBy(M.sceneGap, Alignment.Bottom),
                    ) {
                        Header(view, register, verifying, working, colors) {
                            view = LoginView.Providers; password = ""; problem = null; mail = MailRequest.None
                        }
                        if (error != null) Banner(error, colors.danger, colors.danger.copy(alpha = 0.06f), colors.danger.copy(alpha = 0.3f))
                        if (notice != null) Banner(notice, colors.secondaryLabel, colors.badgeFill, colors.separator)
                        AnimatedContent(
                            targetState = view, label = "panel",
                            transitionSpec = {
                                val spec = tween<androidx.compose.ui.unit.IntOffset>(M.transitionMillis, easing = M.transitionEasing)
                                val forward = targetState == LoginView.Email
                                slideInHorizontally(spec) { if (forward) it else -it } togetherWith
                                    slideOutHorizontally(spec) { if (forward) -it else it } using
                                    SizeTransform(clip = false) { _, _ -> tween(M.transitionMillis, easing = M.transitionEasing) }
                            },
                        ) { shown ->
                            when (shown) {
                                LoginView.Providers -> ProvidersPanel(
                                    state, started, lastUsed, colors,
                                    onGitHub = { browser(BrowserProvider.GitHub) },
                                    onGoogle = { google() },
                                    onApple = { browser(BrowserProvider.Apple) },
                                    onDiscord = { browser(BrowserProvider.Discord) },
                                    onEmail = { problem = null; mail = MailRequest.None; view = LoginView.Email },
                                    onCancel = { account.cancel() },
                                )
                                LoginView.Email -> if (verifying) {
                                    VerificationPanel(sentTo, state.busy, colors, onResend = { resend() }, onReset = { reset() }) {
                                        view = LoginView.Providers; password = ""; mail = MailRequest.None
                                    }
                                } else {
                                    EmailPanel(
                                        register = register, name = name, email = email, password = password, busy = working,
                                        submitting = working && started == LastLoginMethod.Email,
                                        offerResend = !register && state.failure != null && problem == null, colors = colors,
                                        onName = { name = it.take(200); problem = null },
                                        onEmail = { email = it.take(254); problem = null },
                                        onPassword = { password = it.take(128); problem = null },
                                        onSubmit = { submitEmail() }, onForgot = { reset() }, onResend = { resend() },
                                        onToggle = { register = !register; password = ""; problem = null },
                                    )
                                }
                            }
                        }
                        if (!verifying) Legal(colors)
                    }
                }
            }
        }
    }
}

private fun problemText(problem: LoginForm.Problem): Int = when (problem) {
    LoginForm.Problem.EmailInvalid -> R.string.login_email_invalid
    LoginForm.Problem.PasswordEmpty -> R.string.login_password_empty
    LoginForm.Problem.NameRequired -> R.string.login_name_required
    LoginForm.Problem.PasswordTooShort -> R.string.login_password_too_short
    LoginForm.Problem.PasswordTooLong -> R.string.login_password_too_long
    LoginForm.Problem.PasswordComplexity -> R.string.login_password_complexity
}

@Composable
private fun LoginVisual(colors: LodyLoginColors, alpha: Float, activity: Activity, modifier: Modifier) {
    val owner = activity as? LifecycleOwner
    var surface by remember { mutableStateOf<LoginDitherView?>(null) }
    DisposableEffect(owner, surface) {
        val view = surface ?: return@DisposableEffect onDispose {}
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> view.onResume()
                Lifecycle.Event.ON_PAUSE -> view.onPause()
                else -> Unit
            }
        }
        owner?.lifecycle?.addObserver(observer)
        onDispose { owner?.lifecycle?.removeObserver(observer); view.onPause() }
    }
    AndroidView(
        factory = { LoginDitherView(it).also { view -> surface = view } },
        update = { view ->
            view.setColors(colors.visualPaper.toArgb(), colors.visualInk.toArgb(), colors.page.toArgb())
            view.setVisibleFraction(alpha)
        },
        modifier = modifier,
    )
}

@Composable
private fun Header(view: LoginView, register: Boolean, verifying: Boolean, busy: Boolean, colors: LodyLoginColors, onBack: () -> Unit) {
    val title = when {
        view == LoginView.Providers -> stringResource(R.string.login_title)
        verifying -> stringResource(R.string.login_verification_title)
        register -> stringResource(R.string.login_create_title)
        else -> stringResource(R.string.login_email_title)
    }
    val description = when {
        view == LoginView.Providers -> stringResource(R.string.login_description)
        verifying -> null
        register -> stringResource(R.string.login_create_description)
        else -> stringResource(R.string.login_email_description)
    }
    Column(Modifier.fillMaxWidth()) {
        AnimatedVisibility(view == LoginView.Email, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
            Box(Modifier.padding(bottom = LodySpacing.sm).offset(x = -M.controlInset)) {
                LoginButton(LoginVariant.Ghost, stringResource(R.string.login_back), rememberVectorPainter(LodyIcons.ArrowLeft), enabled = !busy, colors = colors, onClick = onBack, wrap = true)
            }
        }
        AnimatedContent(title to description, label = "header", transitionSpec = { fadeIn(tween(LodyMotion.baseMillis)) togetherWith fadeOut(tween(LodyMotion.baseMillis)) }) { (heading, detail) ->
            Column {
                BasicText(heading, Modifier.semantics { heading() }, style = loginTitle().copy(color = colors.label))
                if (detail != null) {
                    Spacer(Modifier.height(LodySpacing.sm))
                    BasicText(detail, style = LodyTheme.typography.callout.copy(color = colors.secondaryLabel))
                }
            }
        }
    }
}

@Composable
private fun loginTitle(): TextStyle = LodyTheme.typography.largeTitle.copy(fontWeight = FontWeight.W600)

@Composable
private fun Banner(text: String, ink: androidx.compose.ui.graphics.Color, fill: androidx.compose.ui.graphics.Color, edge: androidx.compose.ui.graphics.Color) {
    val shape = RoundedCornerShape(M.errorRadius)
    BasicText(
        text,
        Modifier.fillMaxWidth().clip(shape).background(fill).border(LodyStroke.default, edge, shape).padding(horizontal = LodySpacing.md, vertical = LodySpacing.sm)
            .semantics { liveRegion = LiveRegionMode.Polite },
        style = LodyTheme.typography.footnote.copy(color = ink),
    )
}

@Composable
private fun ProvidersPanel(
    state: AuthState, started: LastLoginMethod?, lastUsed: LastLoginMethod?, colors: LodyLoginColors,
    onGitHub: () -> Unit, onGoogle: () -> Unit, onApple: () -> Unit, onDiscord: () -> Unit, onEmail: () -> Unit, onCancel: () -> Unit,
) {
    val working = state.busy || state.browserPending
    val loading = stringResource(R.string.login_loading)
    val badge: @Composable () -> Unit = { LastUsedBadge(colors) }
    // One group of equal buttons: a provider is a choice, not a recommendation, so none is filled.
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(M.methodGap)) {
        Column(verticalArrangement = Arrangement.spacedBy(M.providerGap)) {
            val rows = listOf(
                Triple(LastLoginMethod.GitHub, R.string.login_github, onGitHub),
                Triple(LastLoginMethod.Google, R.string.login_google, onGoogle),
                Triple(LastLoginMethod.Apple, R.string.login_apple, onApple),
                Triple(LastLoginMethod.Discord, R.string.login_discord, onDiscord),
            )
            for ((kind, label, action) in rows) {
                val painter = when (kind) {
                    LastLoginMethod.GitHub -> rememberVectorPainter(LodyIcons.Github)
                    LastLoginMethod.Google -> painterResource(R.drawable.lody_login_google)
                    LastLoginMethod.Apple -> painterResource(R.drawable.lody_login_apple)
                    else -> painterResource(R.drawable.lody_login_discord)
                }
                LoginButton(
                    LoginVariant.Secondary, if (working && started == kind) loading else stringResource(label), painter,
                    enabled = !working, colors = colors, onClick = action,
                    trailing = if (lastUsed == kind) badge else null,
                )
            }
        }
        LoginButton(
            LoginVariant.Ghost, stringResource(R.string.login_email), rememberVectorPainter(LodyIcons.Mail),
            enabled = !working, colors = colors, onClick = onEmail, trailing = if (lastUsed == LastLoginMethod.Email) badge else null,
        )
        if (working) {
            if (state.browserPending) BasicText(stringResource(R.string.auth_browser_pending), Modifier.fillMaxWidth(),
                style = LodyTheme.typography.footnote.copy(color = colors.secondaryLabel, textAlign = TextAlign.Center))
            LoginButton(LoginVariant.Ghost, stringResource(R.string.sign_in_cancel), null, enabled = true, colors = colors, onClick = onCancel, centered = true)
        }
    }
}

@Composable
private fun LastUsedBadge(colors: LodyLoginColors) {
    BasicText(
        stringResource(R.string.login_last_used),
        Modifier.heightIn(min = M.badgeHeight).clip(RoundedCornerShape(M.badgeRadius)).background(colors.badgeFill)
            .padding(horizontal = M.badgeInset, vertical = LodySpacing.xxs),
        style = LodyTheme.typography.micro.copy(color = colors.label),
    )
}

@Composable
private fun EmailPanel(
    register: Boolean, name: String, email: String, password: String, busy: Boolean, submitting: Boolean, offerResend: Boolean,
    colors: LodyLoginColors, onName: (String) -> Unit, onEmail: (String) -> Unit, onPassword: (String) -> Unit,
    onSubmit: () -> Unit, onForgot: () -> Unit, onResend: () -> Unit, onToggle: () -> Unit,
) {
    val emailFocus = remember { FocusRequester() }
    val passwordFocus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { emailFocus.requestFocus() } }
    var reveal by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth()) {
        AnimatedVisibility(register, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
            LoginField(
                stringResource(R.string.login_name_label), name, onName, stringResource(R.string.login_name_placeholder), !busy, colors,
                KeyboardOptions(keyboardType = KeyboardType.Text, imeAction = ImeAction.Next, capitalization = androidx.compose.ui.text.input.KeyboardCapitalization.Words),
                KeyboardActions(onNext = { emailFocus.requestFocus() }), Modifier.padding(bottom = M.fieldGap),
            )
        }
        LoginField(
            stringResource(R.string.login_email_label), email, onEmail, stringResource(R.string.login_email_placeholder), !busy, colors,
            KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next, autoCorrectEnabled = false),
            KeyboardActions(onNext = { passwordFocus.requestFocus() }), Modifier.padding(bottom = M.fieldGap), focus = emailFocus,
        )
        LoginField(
            stringResource(R.string.login_password_label), password, onPassword,
            stringResource(if (register) R.string.login_password_create_placeholder else R.string.login_password_placeholder), !busy, colors,
            KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Go, autoCorrectEnabled = false),
            KeyboardActions(onGo = { onSubmit() }), focus = passwordFocus,
            transformation = if (reveal) VisualTransformation.None else PasswordVisualTransformation(),
            trailing = {
                val label = stringResource(if (reveal) R.string.login_hide_password else R.string.login_show_password)
                Box(
                    Modifier.size(M.control).clickable(role = Role.Button, onClickLabel = label) { reveal = !reveal }
                        .semantics { contentDescription = label },
                    contentAlignment = Alignment.Center,
                ) { Icon(if (reveal) LodyIcons.EyeOff else LodyIcons.Eye, null, Modifier.size(LodyIconSize.sm), tint = colors.secondaryLabel) }
            },
        )
        AnimatedVisibility(!register, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
                TextAction(stringResource(R.string.login_forgot_password), strong = false, enabled = !busy, colors = colors, onClick = onForgot)
            }
        }
        Spacer(Modifier.height(if (register) M.fieldGap else LodySpacing.xs))
        val submitLabel = when {
            submitting && register -> stringResource(R.string.login_creating_account)
            submitting -> stringResource(R.string.login_loading)
            register -> stringResource(R.string.login_create_account)
            else -> stringResource(R.string.login_sign_in)
        }
        LoginButton(
            LoginVariant.Primary, submitLabel, null, enabled = !busy, colors = colors, onClick = onSubmit, centered = true,
            leading = if (submitting) ({ CircularProgressIndicator(Modifier.size(LodyIconSize.sm), color = colors.page, strokeWidth = LodyStroke.focus) }) else null,
            trailing = if (submitting) null else ({ Icon(LodyIcons.ArrowRight, null, Modifier.size(LodyIconSize.xs), tint = colors.page.copy(alpha = 0.8f)) }),
        )
        if (offerResend) {
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                TextAction(stringResource(R.string.login_resend_verification), strong = false, enabled = !busy, colors = colors, onClick = onResend)
            }
        }
        Spacer(Modifier.height(LodySpacing.sm))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
            BasicText(
                stringResource(if (register) R.string.login_have_account else R.string.login_no_account),
                style = LodyTheme.typography.footnote.copy(color = colors.secondaryLabel),
            )
            TextAction(
                stringResource(if (register) R.string.login_sign_in_link else R.string.login_create_account),
                strong = true, enabled = !busy, colors = colors, onClick = onToggle,
            )
        }
    }
}

@Composable
private fun VerificationPanel(
    address: String, busy: Boolean, colors: LodyLoginColors, onResend: () -> Unit, onReset: () -> Unit, onBack: () -> Unit,
) {
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(M.verificationMark).clip(CircleShape).background(colors.badgeFill), contentAlignment = Alignment.Center) {
            Icon(LodyIcons.Mail, null, Modifier.size(LodyIconSize.lg), tint = colors.label)
        }
        Spacer(Modifier.height(LodySpacing.md))
        val body = stringResource(R.string.login_verification_body, address)
        val start = body.indexOf(address)
        BasicText(
            buildAnnotatedString {
                append(body)
                if (address.isNotEmpty() && start >= 0) addStyle(SpanStyle(color = colors.label, fontWeight = FontWeight.W500), start, start + address.length)
            },
            Modifier.fillMaxWidth(),
            style = LodyTheme.typography.callout.copy(color = colors.secondaryLabel, textAlign = TextAlign.Center),
        )
        Spacer(Modifier.height(LodySpacing.lg))
        Row(verticalAlignment = Alignment.CenterVertically) {
            BasicText(stringResource(R.string.login_new_email_account), style = LodyTheme.typography.footnote.copy(color = colors.secondaryLabel))
            TextAction(stringResource(R.string.login_resend), strong = true, enabled = !busy, colors = colors, onClick = onResend)
        }
        TextAction(stringResource(R.string.login_set_password), strong = true, enabled = !busy, colors = colors, onClick = onReset)
        Box(Modifier.padding(vertical = LodySpacing.xs).width(LodySpacing.xxxl).height(LodyStroke.default).background(colors.separator))
        TextAction(stringResource(R.string.login_back_to_options), strong = false, enabled = !busy, colors = colors, onClick = onBack)
    }
}

@Composable
private fun Legal(colors: LodyLoginColors) {
    val chinese = LocalConfiguration.current.locales[0].language == "zh"
    val terms = stringResource(R.string.login_terms)
    val privacy = stringResource(R.string.login_privacy)
    val text = stringResource(R.string.login_legal, terms, privacy)
    val links = TextLinkStyles(SpanStyle(color = colors.secondaryLabel, textDecoration = TextDecoration.Underline))
    val uri = LocalUriHandler.current
    val annotated = buildAnnotatedString {
        var cursor = 0
        val parts = listOf(terms to if (chinese) "/zh/terms" else "/terms", privacy to if (chinese) "/zh/privacy" else "/privacy")
            .mapNotNull { (word, path) -> text.indexOf(word).takeIf { it >= 0 }?.let { Triple(it, word, path) } }
            .sortedBy { it.first }
        for ((at, word, path) in parts) {
            append(text.substring(cursor, at))
            withLink(LinkAnnotation.Url("https://lody.ai$path", links) { uri.openUri("https://lody.ai$path") }) { append(word) }
            cursor = at + word.length
        }
        append(text.substring(cursor))
    }
    Column(Modifier.fillMaxWidth()) {
        Box(Modifier.fillMaxWidth().height(LodyStroke.default).background(colors.separator))
        Spacer(Modifier.height(LodySpacing.lg))
        BasicText(annotated, style = LodyTheme.typography.caption.copy(color = colors.tertiaryLabel, fontWeight = FontWeight.W400, lineHeight = LodyTheme.typography.caption.lineHeight * 1.2f))
    }
}

private enum class LoginVariant { Primary, Secondary, Ghost }

/**
 * Web `Button` at `size="large"`: `secondary` is a raised surface lit from above, `ghost` has no
 * surface until pressed, `primary` is filled with the page's ink. Method rows lead with an 18 dp
 * mark, then the label, then the badge.
 */
@Composable
private fun LoginButton(
    variant: LoginVariant, label: String, mark: Painter?, enabled: Boolean, colors: LodyLoginColors, onClick: () -> Unit,
    trailing: (@Composable () -> Unit)? = null, leading: (@Composable () -> Unit)? = null,
    centered: Boolean = false, wrap: Boolean = false,
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val shape = RoundedCornerShape(M.controlRadius)
    val ink = when (variant) {
        LoginVariant.Primary -> colors.page
        LoginVariant.Secondary -> colors.label
        LoginVariant.Ghost -> if (pressed) colors.label else colors.secondaryLabel
    }
    val surface = when (variant) {
        LoginVariant.Primary -> Modifier.background(colors.label.copy(alpha = if (pressed) 0.86f else 1f), shape)
        LoginVariant.Secondary -> Modifier
            .background(Brush.verticalGradient(if (pressed) listOf(colors.raisedBottom, colors.raisedBottom) else listOf(colors.raisedTop, colors.raisedBottom)), shape)
            .border(LodyStroke.default, colors.raisedEdge, shape)
            .drawBehind {
                if (!pressed) drawLine(colors.raisedSheen, Offset(M.controlRadius.toPx(), 1f), Offset(size.width - M.controlRadius.toPx(), 1f), LodyStroke.default.toPx())
            }
        LoginVariant.Ghost -> if (pressed) Modifier.background(colors.pressedFill, shape) else Modifier
    }
    val width = if (wrap) Modifier else Modifier.fillMaxWidth()
    Row(
        width.heightIn(min = M.control).clip(shape).then(surface)
            .clickable(interaction, ripple(), enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = M.controlInset),
        horizontalArrangement = if (centered) Arrangement.spacedBy(LodySpacing.sm, Alignment.CenterHorizontally) else Arrangement.spacedBy(M.markGap),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val alpha = if (enabled) 1f else 0.5f
        leading?.invoke()
        if (mark != null) Icon(mark, null, Modifier.size(M.mark), tint = ink.copy(alpha = ink.alpha * alpha))
        BasicText(
            label, if (centered || wrap) Modifier else Modifier.weight(1f),
            style = LodyTheme.typography.callout.copy(color = ink.copy(alpha = ink.alpha * alpha), fontWeight = FontWeight.W500),
            maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
        trailing?.invoke()
    }
}

/** An inline text action, as web's underline-on-hover text buttons, at least 44 dp tall. */
@Composable
private fun TextAction(label: String, strong: Boolean, enabled: Boolean, colors: LodyLoginColors, onClick: () -> Unit) {
    Box(
        Modifier.heightIn(min = M.control).clip(RoundedCornerShape(LodyRadius.sm))
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick).padding(horizontal = LodySpacing.xs),
        contentAlignment = Alignment.Center,
    ) {
        val style = LodyTheme.typography.footnote
        BasicText(
            label,
            style = style.copy(
                color = (if (strong) colors.label else colors.secondaryLabel).copy(alpha = if (enabled) 1f else 0.5f),
                fontWeight = if (strong) FontWeight.W500 else style.fontWeight,
            ),
        )
    }
}

/** Web `Field`: a small label above the one recessed well. */
@Composable
private fun LoginField(
    label: String, value: String, onValue: (String) -> Unit, placeholder: String, enabled: Boolean, colors: LodyLoginColors,
    keyboard: KeyboardOptions, actions: KeyboardActions, modifier: Modifier = Modifier, focus: FocusRequester? = null,
    transformation: VisualTransformation = VisualTransformation.None, trailing: (@Composable () -> Unit)? = null,
) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val shape = RoundedCornerShape(M.controlRadius)
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(M.fieldLabelGap)) {
        BasicText(label, style = LodyTheme.typography.label.copy(color = colors.label))
        BasicTextField(
            value, onValue,
            Modifier.fillMaxWidth().heightIn(min = M.control).then(if (focus != null) Modifier.focusRequester(focus) else Modifier)
                .semantics { contentDescription = label },
            enabled = enabled, singleLine = true, textStyle = LodyTheme.typography.body.copy(color = colors.label),
            keyboardOptions = keyboard, keyboardActions = actions, visualTransformation = transformation,
            interactionSource = interaction, cursorBrush = SolidColor(colors.label),
            decorationBox = { inner ->
                Row(
                    Modifier.fillMaxWidth().heightIn(min = M.control).clip(shape).background(colors.well)
                        .border(LodyStroke.default, if (focused) colors.secondaryLabel else colors.wellEdge, shape)
                        .padding(start = LodySpacing.md, end = if (trailing == null) LodySpacing.md else LodySpacing.none),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.weight(1f)) {
                        if (value.isEmpty()) BasicText(placeholder, style = LodyTheme.typography.body.copy(color = colors.tertiaryLabel), maxLines = 1)
                        inner()
                    }
                    trailing?.invoke()
                }
            },
        )
    }
}
