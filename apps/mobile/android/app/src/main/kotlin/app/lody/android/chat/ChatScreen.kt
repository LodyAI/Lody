// A conversation, after web's mobile session page as it runs in the app: a floating header (round
// back button, title, repo) over the transcript; user turns as large right-aligned bubbles with
// the delivery mark, time and sender above and the avatar beside; agent turns open with the
// process line and run full width; a round scroll-to-latest button; a bordered composer card
// (+, the run-config chip, send) under the action bar (web `SessionInfoBar`: computer, repository
// context, repository actions). iOS counterpart: SessionController.

package app.lody.android.chat

import app.lody.android.designsystem.LodyIconButton as IconButton
import app.lody.android.designsystem.LodyTextButton as TextButton
import app.lody.android.designsystem.LodyButton as Button

import androidx.activity.compose.BackHandler
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.Brush
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.dropShadow
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.layout.SubcomposeLayout
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.style.TextOverflow
import app.lody.android.R
import app.lody.android.auth.Account
import app.lody.android.designsystem.*
import app.lody.android.runtime.*
import app.lody.android.home.AgentMark
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.UUID

/** What the page knows about the conversation from the catalog, for its header and sending. */
data class ChatContext(
    val title: String,
    val subtitle: String = "",
    val session: CatalogSession? = null,
    val me: Account? = null,
    /** The GitHub repository (`owner/name`) the session works in; empty without one. */
    val tabs: List<CatalogSession> = emptyList(),
    val closedTabs: List<CatalogSession> = emptyList(),
    val repository: String = "",
    val machineName: String = "",
    val machineKind: app.lody.android.create.CreateSessionModel.MachineKind = app.lody.android.create.CreateSessionModel.MachineKind.Laptop,
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(repository: ChatRepository, scope: RuntimeScope, id: String, context: ChatContext, onBack: () -> Unit, onSelectTab: (String) -> Unit = {}, creation: app.lody.android.create.CreationSubmissions.Submission? = null) {
    BackHandler(onBack = onBack)
    var retry by remember(id, scope) { mutableIntStateOf(0) }
    var status by remember(id, scope) { mutableStateOf("syncing") }
    var messages by remember(id, scope) { mutableStateOf(emptyList<SessionMessage>()) }
    // The latest user turn's run config, from the session snapshot (iOS `composerJSON`).
    var usage by remember(id, scope) { mutableStateOf<app.lody.android.runtime.SessionUsage?>(null) }
    var snapshotChoice by remember(id, scope) { mutableStateOf<RunChoice?>(null) }
    var entries by remember(id, scope) { mutableStateOf(emptyList<ChatEntry>()) }
    // Turns this page sent that the transcript has not shown yet (optimistic, never resent).
    var outgoing by remember(id, scope) { mutableStateOf(emptyList<Outgoing>()) }
    var prompt by rememberSaveable(id) { mutableStateOf("") }
    // The field with its caret and IME composition; the @ panel reads the trigger at the caret.
    var field by remember(id) { mutableStateOf(androidx.compose.ui.text.input.TextFieldValue(prompt, androidx.compose.ui.text.TextRange(prompt.length))) }
    LaunchedEffect(prompt) {
        if (field.text != prompt) field = androidx.compose.ui.text.input.TextFieldValue(prompt, androidx.compose.ui.text.TextRange(prompt.length))
    }
    var composerFocused by remember(id) { mutableStateOf(false) }
    // @ references: the catalogs, the panel's levels, and Role labels to resolve at send.
    val mentions = rememberMentionState(id, scope)
    val appContext = LocalContext.current.applicationContext
    val coroutines = rememberCoroutineScope()
    val agentName = agentLabel(context.session)
    val meName = context.me?.name.orEmpty()
    // Resolved in composition: the transcript is built off the main thread.
    val application = appContext.applicationContext as app.lody.android.LodyApplication
    val accountState by application.account.state.collectAsState()
    var members by remember(scope) { mutableStateOf(emptyMap<String, app.lody.android.auth.WorkspaceMember>()) }
    LaunchedEffect(scope, accountState.verified) {
        application.members.observe(scope).collect { members = it }
    }
    val memberLabel = stringResource(R.string.chat_member)
    val workedFormat = stringResource(R.string.chat_worked_for)
    val durationSeconds = stringResource(R.string.message_seconds)
    val durationMinutes = stringResource(R.string.message_minutes_seconds)
    LaunchedEffect(scope, id, retry, creation?.state) {
        if (creation?.state in setOf("sending", "rejected")) return@LaunchedEffect
        val repair = QuickJsMarkdownRepair.fromAssets(appContext)
        val rendered = mutableMapOf<String, Pair<SessionMessage, ChatEntry>>()
        // Prose items keep their Markdown while their text is unchanged, so a streaming turn
        // re-renders only the item that grows.
        val proseCache = mutableMapOf<String, Pair<String, MarkdownBlocks>>()
        // Web shows thoughts only for builtin DSH.
        val showThoughts = context.session?.cliType == "builtin" && context.session.agentType == "deepseek"
        try {
            repository.observe(scope, id).conflate().collect { snapshot ->
                entries = withContext(Dispatchers.Default) {
                    val next = snapshot.messages.map { message ->
                        rendered[message.id]?.takeIf { it.first == message }?.second ?: when (message.role) {
                            "user" -> ChatEntry.User(
                                message.id, message.text,
                                TurnIdentity("", time = turnTime(message.timestamp)),
                                delivery(message.status),
                                message.attachments,
                                message.references,
                            )
                            else -> {
                                val items = message.items.ifEmpty { listOf(TurnItem.Text(message.id, message.text)) }
                                val growing = items.lastOrNull { it is TurnItem.Text || it is TurnItem.Thought || it is TurnItem.ProposedPlan }?.id
                                val prose = items.mapNotNull { item ->
                                    val text = when (item) {
                                        is TurnItem.Text -> item.text
                                        is TurnItem.Thought -> item.text
                                        is TurnItem.ProposedPlan -> item.markdown
                                        else -> return@mapNotNull null
                                    }
                                    val streaming = message.streaming && item.id == growing
                                    val cacheKey = "${message.id}:${item.id}"
                                    val cached = proseCache[cacheKey]?.takeIf { it.first == text && !streaming }?.second
                                    item.id to (cached ?: flowOf(MessageText(text, streaming)).renderMarkdown(repair).first()
                                        .also { proseCache[cacheKey] = text to it })
                                }.toMap()
                                ChatEntry.Assistant(
                                    message.id,
                                    TurnLayout.build(message.id, items, finished = !message.streaming, showThoughts),
                                    prose,
                                    TurnIdentity(message.model?.let { "$agentName · $it" } ?: agentName, time = turnTime(message.timestamp)),
                                    worked(message, workedFormat, durationSeconds, durationMinutes),
                                    working = message.streaming,
                                    files = message.files,
                                    agentCliType = context.session?.cliType,
                                    agentType = context.session?.agentType,
                                )
                            }
                        }.also { rendered[message.id] = message to it }
                    }
                    rendered.keys.retainAll(snapshot.messages.map { it.id }.toSet())
                    proseCache.keys.retainAll { key -> snapshot.messages.any { key.startsWith(it.id + ":") } }
                    next
                }
                messages = snapshot.messages
                snapshotChoice = snapshot.composer
                usage = snapshot.usage
                status = snapshot.status
                if (snapshot.messages.any { it.streaming }) delay(33)
            }
        } finally { repair.close() }
    }
    // A sent turn leaves the optimistic list once the transcript carries its id.
    val authorsByMessage = remember(messages) { messages.associate { it.id to it.userId } }
    val firstTurn = creation?.let {
        Outgoing(it.request.turnId, it.request.text, it.at, when (it.state) {
            "sending" -> Delivery.Sending
            "accepted" -> Delivery.Sent
            "queued" -> Delivery.Queued
            else -> Delivery.Failed
        }, it.request.attachments.map { block -> MessageAttachment(block.optString("fileName", block.optString("name", "attachment")), block.optString("type") == "image") })
    }
    val pending = remember(firstTurn, outgoing, authorsByMessage) {
        (listOfNotNull(firstTurn) + outgoing).filter { it.turnId !in authorsByMessage }
    }
    // Composer focus / IME animation must not rebuild every sender row in a long chat.
    val all = remember(entries, authorsByMessage, members, context.me, memberLabel, pending, mentions.catalogs) {
        entries.map { entry ->
            if (entry is ChatEntry.User) {
                val userId = authorsByMessage[entry.id]
                entry.copy(who = senderIdentity(userId, context.me, members[userId ?: context.me?.id], memberLabel, entry.who.time))
            } else entry
        } + pending.map {
            ChatEntry.User(it.turnId, mentions.presentation(androidx.compose.ui.graphics.Color.Unspecified).filter(androidx.compose.ui.text.AnnotatedString(it.text)).text.text, senderIdentity(null, context.me, members[context.me?.id], memberLabel, turnTime(it.at)), it.delivery, it.attachments)
        }
    }
    val creationUnconfirmed = creation != null && creation.state !in setOf("accepted", "queued") && creation.request.turnId !in authorsByMessage
    val creationNotice = if (creationUnconfirmed && creation?.state != "sending") {
        stringResource(if (creation?.state == "rejected") R.string.create_result_rejected else R.string.create_result_unknown)
    } else null
    val session = context.session
    val canSend = context.session?.isTabClosed != true && !creationUnconfirmed && status == "live" && session?.cliType != null && session.agentType != null
    // The composer's run config (web's mobile run-config chip): the session's provider choices,
    // read once the conversation is live. Until the reader changes it the chip shows the latest
    // turn's config from the snapshot and sends nothing (upstream keeps it); the first change
    // copies that config and from then on the whole choice rides on each turn (iOS `hydrated`).
    var options by remember(id, scope) { mutableStateOf<CreationOptions?>(null) }
    LaunchedEffect(scope, id, session?.projectId, status == "live") {
        if (session == null || status != "live") return@LaunchedEffect
        // A plain chat's `<machine>:unassigned` project is not a real project (the runtime
        // rejects it): read the workspace-wide options, as the new-chat page does for chats.
        // A multi-repository project's session reads them workspace-wide, as a plain chat.
        val project = session.projectId.takeUnless { app.lody.android.create.CreateSessionModel.isChat(it) || app.lody.android.create.CreateSessionModel.isGroup(it) }
        try { options = repository.options(scope, project) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { /* The chip still shows the session's model; choices wait for the next load. */ }
    }
    var machineOnline by remember(scope, session?.machineId) { mutableStateOf<Boolean?>(null) }
    LaunchedEffect(scope, session?.machineId) {
        application.creation.observeOptions(scope).collect { available ->
            machineOnline = available?.onlineMachineIds?.let { session?.machineId in it }
        }
    }
    val machineReader = remember(application) { MachineDetailsReader(application.account) }
    val loadMachine: suspend () -> MachinePanelData = {
        val details = try { session?.let { machineReader.read(scope, it.machineId) } }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { null }
        val online = try { application.creation.options(scope, null).onlineMachineIds?.let { session?.machineId in it } }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { null }
        MachinePanelData(details?.ownerUserId?.let { members[it] }, details?.shared, online)
    }
    val capability = session?.let { options?.capability(it.machineId, it.cliType, it.agentType, it.agentConfigId) }
    var chosen by rememberSaveable(id) { mutableStateOf(false) }
    var chosenModel by rememberSaveable(id) { mutableStateOf<String?>(null) }
    var chosenEffort by rememberSaveable(id) { mutableStateOf<String?>(null) }
    var chosenMode by rememberSaveable(id) { mutableStateOf<String?>(null) }
    // Agent switches (Plan, Fast, pinned Role options) the reader changed.
    var chosenOptions by remember(id) { mutableStateOf<Map<String, Any>>(emptyMap()) }
    val modelId = if (chosen) chosenModel else snapshotChoice?.modelId
    val effort = if (chosen) chosenEffort else snapshotChoice?.effort
    val modeId = if (chosen) chosenMode else snapshotChoice?.modeId
    val optionValues = if (chosen) chosenOptions else snapshotChoice?.configOptionValues.orEmpty()
    val choose: (model: String?, effort: String?, mode: String?) -> Unit = { m, e, o ->
        if (!chosen) chosenOptions = snapshotChoice?.configOptionValues.orEmpty()
        chosenModel = m; chosenEffort = e; chosenMode = o; chosen = true
    }
    val chooseOption: (String, Any) -> Unit = { key, value ->
        if (!chosen) { chosenModel = modelId; chosenEffort = effort; chosenMode = modeId; chosenOptions = optionValues; chosen = true }
        chosenOptions = chosenOptions + (key to value)
    }
    // Agent Roles (web session composer): only those bound to this conversation's computer and
    // agent config; the agent itself never changes here. The picked Role (or explicit None)
    // holds until a newer turn lands with its own Role.
    var roles by remember(scope) { mutableStateOf<List<AgentRole>?>(null) }
    LaunchedEffect(scope, status == "live") {
        if (status != "live" || roles != null) return@LaunchedEffect
        try { roles = repository.roles(scope) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { /* No Role row until the list loads; turns inherit meanwhile. */ }
    }
    val durableRole = SessionRoles.durable(snapshotChoice)
    var pickedRole by remember(id) { mutableStateOf<SessionRoles.Pick?>(null) }
    LaunchedEffect(durableRole) { pickedRole = null }
    val roleItems = session?.let { SessionRoles.items(roles.orEmpty(), it.machineId, it.agentConfigId, options?.agents.orEmpty()) }.orEmpty()
    val runChoice = SessionRoles.Choice(modelId, effort, modeId, optionValues)
    val activeRole = SessionRoles.active(roleItems, pickedRole, durableRole, session?.agentConfigId, runChoice)
    val pickRole: (String?) -> Unit = pick@{ roleId ->
        if (roleId == null) { pickedRole = SessionRoles.Pick.None; return@pick }
        val item = roleItems.firstOrNull { it.role.id == roleId && it.unavailable == null } ?: return@pick
        val next = SessionRoles.apply(item, runChoice, capability)
        chosenModel = next.modelId; chosenEffort = next.effort; chosenMode = next.modeId; chosenOptions = next.options; chosen = true
        pickedRole = SessionRoles.Pick.Role(roleId)
    }
    var runConfig by remember(id) { mutableStateOf(false) }
    val failedText = stringResource(R.string.chat_send_failed)
    // Picked attachments wait in the composer and upload when the turn is sent.
    var attachments by remember(id) { mutableStateOf(emptyList<PendingAttachment>()) }
    val attachLimit = stringResource(R.string.chat_attach_limit)
    val uploadFailed = stringResource(R.string.chat_attach_failed)
    val snackbar = remember { SnackbarHostState() }
    var creatingTab by remember(id, scope) { mutableStateOf(false) }
    var attemptedTab by rememberSaveable(id, scope.workspaceId) { mutableStateOf<String?>(null) }
    // A new Tab starts as "New chat"; "New Tab conversation" is only the action's label.
    val newTabTitle = stringResource(R.string.chat_new_tab_title)
    val tabFailure = stringResource(R.string.chat_tab_creation_failed)
    val tabUnknown = stringResource(R.string.chat_tab_creation_unknown)
    var changingTab by remember(id, scope) { mutableStateOf<String?>(null) }
    val tabChangeFailure = stringResource(R.string.chat_tab_change_failed)
    val changeTab: (String, Boolean) -> Unit = { target, closed ->
        if (changingTab == null) {
            changingTab = target
            val index = context.tabs.indexOfFirst { it.id == target }
            val next = context.tabs.getOrNull(index + 1) ?: context.tabs.getOrNull(index - 1)
            coroutines.launch {
                try {
                    repository.setTabClosed(scope, target, closed)
                    if (!closed && target != id) onSelectTab(target)
                    else if (closed && target == id && next != null) onSelectTab(next.id)
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { snackbar.showSnackbar(tabChangeFailure) }
                finally { changingTab = null }
            }
        }
    }

    val createTab = {
        if (!creatingTab) {
            creatingTab = true
            coroutines.launch {
                if (attemptedTab != null) {
                    onSelectTab(attemptedTab!!)
                } else {
                    val target = UUID.randomUUID().toString()
                    attemptedTab = target
                    try {
                        val result = repository.createTab(scope, id, target, newTabTitle)
                        when (result.state) {
                            "created" -> { attemptedTab = null; onSelectTab(target) }
                            "rejected" -> { attemptedTab = null; snackbar.showSnackbar(tabFailure) }
                            else -> snackbar.showSnackbar(tabUnknown)
                        }
                    } catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Exception) { snackbar.showSnackbar(tabUnknown) }
                }
                creatingTab = false
            }
        }
    }
    val messageActions = rememberMessageActions(repository, scope, id, messages, canSend && session?.status !in RunningStatuses, onSelectTab)
    val running = session?.status in RunningStatuses || pending.any { it.delivery == Delivery.Sending }
    // One send path for typed turns and the action bar's prompts: optimistic bubble, never resent.
    // Attachments upload first; a failed upload fails the turn before anything is written and
    // hands the text and attachments back to an empty composer.
    val sendText: (String, List<PendingAttachment>) -> Unit = sendText@{ text, files ->
        if (!canSend || (text.isEmpty() && files.isEmpty()) || session == null) return@sendText
        val turnId = UUID.randomUUID().toString()
        val shown = files.map { MessageAttachment(it.name, it.image) }
        outgoing = outgoing + Outgoing(turnId, text, Instant.now().toString(), Delivery.Sending, shown)
        val explicit = chosen
        val choice = Triple(modelId, modeId, effort)
        val role = SessionRoles.send(roles != null, activeRole, pickedRole, durableRole)
        val switches = if (chosen) chosenOptions else emptyMap()
        coroutines.launch {
            val queue = session.status in RunningStatuses
            val blocks = try { repository.upload(scope, id, files) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { null }
            if (blocks == null) {
                outgoing = outgoing.map { if (it.turnId == turnId) it.copy(delivery = Delivery.Failed) else it }
                if (prompt.isEmpty() && attachments.isEmpty()) { prompt = text; attachments = files }
                snackbar.showSnackbar(uploadFailed)
                return@launch
            }
            val result = try {
                repository.send(scope, SendTextRequest(
                    id, turnId, text, session.machineId, session.cliType!!, session.agentType!!, session.resume, queue = queue,
                    modelId = choice.first, modeId = choice.second, effort = choice.third, explicitChoice = explicit, attachments = blocks,
                    role = role, agentConfigId = session.agentConfigId, configOptionValues = switches,
                )).state
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { "unknown" }
            val delivery = when (result) {
                "queued" -> Delivery.Queued
                "not_sent" -> Delivery.Failed
                else -> Delivery.Sent
            }
            outgoing = outgoing.map { if (it.turnId == turnId) it.copy(delivery = delivery) else it }
            if (result == "not_sent") snackbar.showSnackbar(failedText)
        }
        Unit
    }
    val send = {
        // Role labels ("🧪 Reviewer") go out as their tokens (`@role:<id>`), which expand at send.
        val text = mentions.resolve(prompt.trim())
        if (canSend && (text.isNotEmpty() || attachments.isNotEmpty())) {
            sendText(text, attachments)
            prompt = ""
            attachments = emptyList()
        }
    }
    // Web's limits: at most 8 images and 8 files per turn; extra picks are dropped with a notice.
    val addAttachments: (List<PendingAttachment>) -> Unit = { picked ->
        val merged = attachments + picked
        val kept = merged.filter { it.image }.take(8) + merged.filter { !it.image }.take(8)
        attachments = merged.filter { it in kept }
        if (kept.size < merged.size) coroutines.launch { snackbar.showSnackbar(attachLimit) }
    }
    // @ references (iOS `ChatMentionPanel`, Notion-style): every category is read once the
    // conversation is live; a trigger at the caret opens the panel docked on the keyboard.
    LaunchedEffect(scope, id, status == "live", session?.cliType, session?.agentType) {
        if (session == null || status != "live") return@LaunchedEffect
        mentions.load { category -> repository.mentions(scope, category, session) }
    }
    val resolver = appContext.contentResolver
    val photoPicker = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.PickMultipleVisualMedia(8),
    ) { uris -> addAttachments(uris.mapNotNull { SessionAttachmentUploads.describe(resolver, it, image = true) }) }
    val filePicker = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.OpenMultipleDocuments(),
    ) { uris -> addAttachments(uris.mapNotNull { SessionAttachmentUploads.describe(resolver, it, image = false) }) }
    // Stop the running turn (web's composer stop button); one request at a time, never retried.
    val runningTurn = messages.lastOrNull { it.role != "user" && it.streaming }?.id
    var stopping by remember(id) { mutableStateOf(false) }
    val stopFailed = stringResource(R.string.chat_stop_failed)
    val stopHaptics = androidx.compose.ui.platform.LocalHapticFeedback.current
    val stop = {
        if (runningTurn != null && session != null && status == "live" && !stopping) {
            stopping = true
            stopHaptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.ContextClick)
            coroutines.launch {
                try { repository.stop(scope, id, session.machineId, runningTurn) }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { snackbar.showSnackbar(stopFailed) }
                finally { stopping = false }
            }
        }
        Unit
    }
    val prUpdates = remember(scope, id) { SessionPullRequestUpdates() }
    val bar = session?.let { SessionInfoBar.of(prUpdates.apply(it), context.repository, busy = running || !canSend) }
    // Merge / Ready for review go straight to GitHub, one at a time, never retried.
    var merging by remember(id) { mutableStateOf(false) }
    var writing by remember(scope, id) { mutableStateOf<SessionInfoBar.Action?>(null) }
    val prefs = remember { appContext.getSharedPreferences("lody.chat", android.content.Context.MODE_PRIVATE) }
    val writeTexts = WriteTexts(
        stringResource(R.string.bar_merge_pending), stringResource(R.string.bar_merge_done), stringResource(R.string.bar_merge_error),
        stringResource(R.string.bar_ready_pending), stringResource(R.string.bar_ready_done), stringResource(R.string.bar_ready_error),
        WriteErrors.associateWith { code -> stringResource(writeErrorText(code)) },
    )
    val haptics = androidx.compose.ui.platform.LocalHapticFeedback.current
    val writePullRequest: (String?) -> Unit = write@{ method ->
        val pr = bar?.pullRequest ?: return@write
        if (writing != null) return@write
        prUpdates.begin(pr, merged = method != null)
        writing = if (method != null) SessionInfoBar.Action.Merge else SessionInfoBar.Action.ReadyForReview
        coroutines.launch {
            snackbar.showSnackbar(if (method != null) writeTexts.mergePending else writeTexts.readyPending)
        }
        coroutines.launch {
            val message = try {
                if (method != null) repository.mergePullRequest(scope, pr.repository, pr.number, method)
                else repository.markReady(scope, pr.repository, pr.number)
                prUpdates.finish(success = true)
                haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.Confirm)
                if (method != null) writeTexts.mergeDone else writeTexts.readyDone
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) {
                haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.Reject)
                (error as? GitHubWriteFailure)?.code?.let { writeTexts.errors[it] }
                    ?: if (method != null) writeTexts.mergeError else writeTexts.readyError
            } finally {
                prUpdates.finish(success = false)
                writing = null
            }
            snackbar.currentSnackbarData?.dismiss()
            snackbar.showSnackbar(message)
        }
    }
    if (merging && bar?.pullRequest != null) {
        MergeSheet(
            "${bar.pullRequest.repository} #${bar.pullRequest.number}",
            preferred = prefs.getString("prMergeMethod", "merge") ?: "merge",
            onDismiss = { merging = false },
            onMerge = { method ->
                merging = false
                prefs.edit().putString("prMergeMethod", method).apply()
                writePullRequest(method)
            },
        )
    }
    val prompts = SessionInfoBar.Prompts(
        stringResource(R.string.bar_prompt_createPrOrigin), stringResource(R.string.bar_prompt_createDraftPrOrigin),
        stringResource(R.string.bar_prompt_createPr), stringResource(R.string.bar_prompt_createDraftPr),
        stringResource(R.string.bar_prompt_prBranchUpkeep), stringResource(R.string.bar_prompt_commitAndPush),
        stringResource(R.string.bar_prompt_resolveConflicts), stringResource(R.string.bar_prompt_fixCi),
    )

    val colors = LodyTheme.colors
    val listState = rememberLazyListState(initialFirstVisibleItemIndex = Int.MAX_VALUE)
    var scrollToLatest by remember { mutableIntStateOf(0) }
    val atLatest by remember { derivedStateOf { !listState.canScrollForward } }
    val headerHeight = LodySize.controlLg + LodySpacing.md
    Scaffold(
        containerColor = colors.bgBase,
        snackbarHost = { SnackbarHost(snackbar) },
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).imePadding().navigationBarsPadding()) {
            Box(Modifier.weight(1f).fillMaxWidth()) {
                val top = WindowInsets.statusBars.asPaddingValues().calculateTopPadding() + headerHeight
                if (context.session?.isTabClosed == true || all.isEmpty()) {
                    Box(Modifier.fillMaxSize().padding(top = top), contentAlignment = Alignment.Center) {
                        Text(stringResource(if (context.session?.isTabClosed == true) R.string.chat_tabs_all_closed else if (status == "live") R.string.chat_empty else if (status == "offline") R.string.chat_offline else R.string.chat_loading), style = LodyTheme.typography.body, color = colors.textSecondary)
                    }
                } else {
                    // The transcript scrolls under the floating header.
                    ChatTranscript(
                        all, Modifier.fillMaxSize(), contentPadding = PaddingValues(top = top + if (creationNotice != null) LodySize.controlLg else LodySpacing.none, bottom = LodySpacing.md), state = listState, scrollToLatest = scrollToLatest,
                        actions = messageActions,
                        loadDetail = { entryId, itemId -> repository.detail(scope, id, entryId, itemId) },
                        loadDiff = { entryId, path -> repository.turnDiff(scope, id, entryId, path) },
                    )
                }
                ChatHeader(context.title, context.tabs, context.closedTabs, id, creatingTab, changingTab, onBack, onSelectTab, createTab, changeTab, context.machineName, machineOnline, loadMachine)
                if (creationNotice != null) {
                    Text(creationNotice,
                        modifier = Modifier.align(Alignment.TopCenter).padding(top = top).padding(horizontal = TranscriptMargin),
                        style = LodyTheme.typography.footnote, color = colors.textSecondary)
                }
                if (status == "offline" && !creationUnconfirmed) {
                    Row(
                        Modifier.align(Alignment.TopCenter).padding(top = top).padding(horizontal = TranscriptMargin).fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(stringResource(R.string.chat_offline), style = LodyTheme.typography.footnote, color = colors.textSecondary, modifier = Modifier.weight(1f))
                        TextButton(onClick = { retry++ }) { Text(stringResource(R.string.chat_retry), color = colors.accentFg) }
                    }
                }
                // Web's round "scroll to latest" button, shown once the reader has scrolled up.
                if (context.session?.isTabClosed != true && !atLatest && all.isNotEmpty()) {
                    val label = stringResource(R.string.chat_scroll_latest)
                    RoundButton(
                        LodyIcons.Expand, label,
                        Modifier.align(Alignment.BottomEnd).padding(end = TranscriptMargin, bottom = LodySpacing.md),
                    ) { scrollToLatest++ }
                }
            }
            if (bar != null && context.session?.isTabClosed != true) {
                ChatActionBar(
                    bar,
                    writing = writing,
                    onAction = { action ->
                        // Only while still offered, so a menu left open cannot act for a state that moved on.
                        when {
                            writing != null || action !in bar.actions -> Unit
                            action == SessionInfoBar.Action.Merge -> merging = true
                            action == SessionInfoBar.Action.ReadyForReview -> writePullRequest(null)
                            else -> sendText(bar.prompt(action, prompts), emptyList())
                        }
                    },
                    onCopied = { coroutines.launch { snackbar.showSnackbar(it) } },
                )
            }
            val modelName = capability?.models?.firstOrNull { it.id == modelId }?.name ?: session?.modelName ?: agentName
            if (context.session?.isTabClosed != true) ChatComposer(
                field,
                usage = if (chosen && modelId != usage?.modelId) usage?.copy(quota = null) else usage,
                onPromptChange = { if (it.text.length <= 32000) { field = app.lody.android.chat.MentionPresentation.edit(field, it); prompt = field.text } },
                onFocusChange = { composerFocused = it },
                referencePresentation = mentions.presentation(LodyTheme.colors.accentDefault),
                enabled = canSend,
                agentCliType = session?.cliType,
                agentType = session?.agentType,
                roleEmoji = activeRole?.role?.emoji,
                roleName = activeRole?.role?.name,
                agentName = options?.agents?.firstOrNull { it.id == session?.agentConfigId }?.name ?: agentName.takeIf { it.isNotBlank() },
                face = listOfNotNull(modelName, effort),
                mode = modeId,
                modeLabel = capability?.modes?.firstOrNull { it.id == modeId }?.name,
                plan = capability?.planOn(optionValues) == true,
                fast = capability?.fastOn(optionValues, modelId) == true,
                onRunConfig = if (session != null) ({ runConfig = true }) else null,
                stoppable = runningTurn != null && status == "live",
                stopping = stopping,
                attachments = attachments,
                onPickPhotos = {
                    photoPicker.launch(androidx.activity.result.PickVisualMediaRequest(androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia.ImageAndVideo))
                },
                onPickFiles = { filePicker.launch(arrayOf("*/*")) },
                onRemoveAttachment = { removed -> attachments = attachments.filterNot { it.id == removed } },
                onSend = send,
                onStop = stop,
            )
            // Docked between the prompt and the keyboard; rows never take focus, so the keyboard stays.
            MentionDock(mentions, field, active = composerFocused && canSend, loadShortcut = { shortcutId -> repository.shortcut(scope, shortcutId) }) { next -> field = next; prompt = next.text }
        }
    }
    if (runConfig && session != null) {
        ModalBottomSheet(
            onDismissRequest = { runConfig = false },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            containerColor = colors.bgBase,
        ) {
            // Web's mobile run-config sheet in a conversation: Role, the conversation's Agent
            // (locked), Model, Reasoning, Mode, then the Plan and Fast switches when offered.
            val reasons = mapOf(
                app.lody.android.create.CreateSessionModel.RoleUnavailable.Machine to stringResource(R.string.create_role_unavailable_machine),
                app.lody.android.create.CreateSessionModel.RoleUnavailable.Agent to stringResource(R.string.create_role_unavailable_agent),
                app.lody.android.create.CreateSessionModel.RoleUnavailable.Offline to stringResource(R.string.create_role_unavailable_offline),
            )
            val agent = options?.agents?.firstOrNull { it.id == session.agentConfigId }
            app.lody.android.create.RunConfigSheet(
                rows = buildList {
                    if (roles != null) {
                        add(app.lody.android.create.RunConfigRow(RUN_ROLE, stringResource(R.string.create_role),
                            // An empty glyph keeps None's title in line with the Roles' emoji.
                            listOf(app.lody.android.create.PickerOption(RUN_ROLE_NONE, stringResource(R.string.create_role_none), activeRole == null, emoji = "")) +
                                roleItems.map { item ->
                                    app.lody.android.create.PickerOption(item.role.id, item.role.name, item.role.id == activeRole?.role?.id,
                                        subtitle = item.unavailable?.let { reasons.getValue(it) }.orEmpty(),
                                        disabled = item.unavailable != null, emoji = item.role.emoji)
                                }))
                    }
                    add(app.lody.android.create.RunConfigRow(RUN_AGENT, stringResource(R.string.create_agent), listOf(
                        app.lody.android.create.PickerOption(session.agentConfigId ?: "", agent?.name ?: agentName, true,
                            agent = (session.cliType ?: "") to (session.agentType ?: "")),
                    ), locked = true))
                    capability?.models?.takeIf { it.isNotEmpty() }?.let { models ->
                        add(app.lody.android.create.RunConfigRow(RUN_MODEL, stringResource(R.string.create_model), models.map { app.lody.android.create.PickerOption(it.id, it.name, it.id == modelId) }))
                    }
                    capability?.effortsFor(modelId)?.takeIf { it.isNotEmpty() }?.let { efforts ->
                        add(app.lody.android.create.RunConfigRow(RUN_EFFORT, stringResource(R.string.create_effort), efforts.map { app.lody.android.create.PickerOption(it, it, it == effort) }))
                    }
                    capability?.modes?.takeIf { it.isNotEmpty() }?.let { modes ->
                        add(app.lody.android.create.RunConfigRow(RUN_MODE, stringResource(R.string.create_mode), modes.map { app.lody.android.create.PickerOption(it.id, it.name, it.id == modeId) }))
                    }
                    capability?.planOn(optionValues)?.let { on ->
                        add(app.lody.android.create.RunConfigRow(RUN_PLAN, stringResource(R.string.run_config_plan), emptyList(), toggle = on))
                    }
                    capability?.fastOn(optionValues, modelId)?.let { on ->
                        add(app.lody.android.create.RunConfigRow(RUN_FAST, stringResource(R.string.run_config_fast), emptyList(), toggle = on))
                    }
                },
                defaultLabel = stringResource(R.string.create_default),
            ) { row, value ->
                val on = value == app.lody.android.create.RUN_CONFIG_ON
                when (row) {
                    RUN_ROLE -> pickRole(value.takeIf { it != RUN_ROLE_NONE })
                    RUN_MODEL -> choose(value, null, modeId)
                    RUN_EFFORT -> choose(modelId, value, modeId)
                    RUN_MODE -> choose(modelId, effort, value)
                    RUN_PLAN -> capability?.planValue(on)?.let { (key, setting) -> chooseOption(key, setting) }
                    RUN_FAST -> capability?.fastValue(on, modelId)?.let { (key, setting) -> chooseOption(key, setting) }
                }
            }
        }
    }
}

private const val RUN_ROLE = "role"
private const val RUN_ROLE_NONE = "__none__"
private const val RUN_AGENT = "agent"
private const val RUN_PLAN = "plan"
private const val RUN_FAST = "fast"
private const val RUN_MODEL = "model"
private const val RUN_EFFORT = "effort"
private const val RUN_MODE = "mode"

private val RunningStatuses = setOf("running", "initializing", "processing", "in_progress", "queued")

/** Floating header: title over the tappable machine subtitle, with conditional Tabs and More. */
@Composable
internal fun BoxScope.ChatHeader(title: String, tabs: List<CatalogSession>, closedTabs: List<CatalogSession>, currentId: String, creating: Boolean, busy: String?, onBack: () -> Unit, onSelectTab: (String) -> Unit, onNewTab: () -> Unit, onChangeTab: (String, Boolean) -> Unit, machine: String = "", machineOnline: Boolean? = null, loadMachine: suspend () -> MachinePanelData = { MachinePanelData() }) {
    var expanded by remember(currentId) { mutableStateOf(false) }
    var history by remember(currentId) { mutableStateOf(false) }
    var restoringId by remember(currentId) { mutableStateOf<String?>(null) }
    LaunchedEffect(closedTabs, busy) {
        val target = restoringId
        if (target != null && busy == null && closedTabs.none { it.id == target }) {
            expanded = false
            restoringId = null
        }
    }
    val colors = LodyTheme.colors
    Row(
        Modifier
            .align(Alignment.TopStart)
            .fillMaxWidth()
            // The page colour fades out under the header so the transcript reads beneath it.
            .background(Brush.verticalGradient(0f to colors.bgBase, 0.7f to colors.bgBase.copy(alpha = 0.85f), 1f to colors.bgBase.copy(alpha = 0f)))
            .statusBarsPadding()
            .padding(horizontal = LodySpacing.sm, vertical = LodySpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(LodySpacing.xs),
    ) {
        RoundButton(LodyIcons.Back, stringResource(R.string.chat_back), visualSize = LodySize.controlMd, onClick = onBack)
        Column(Modifier.weight(1f)) {
            ConversationTitle(title)
            if (machine.isNotBlank()) MachineItem(machine, machineOnline, loadMachine)
        }
        Row(Modifier.clip(CircleShape).background(colors.bgOverlay).border(0.5.dp, colors.borderSubtle, CircleShape), verticalAlignment = Alignment.CenterVertically) {
            Box {
                if (tabs.any { !it.parentSessionId.isNullOrBlank() }) IconButton(onClick = { history = false; expanded = !expanded }, modifier = Modifier.size(LodySize.controlLg)
                    .semantics { contentDescription = title }) {
                    Icon(LodyIcons.Sessions, contentDescription = androidx.compose.ui.res.pluralStringResource(R.plurals.chat_directory_tabs, tabs.size, tabs.size), tint = colors.iconPrimary, modifier = Modifier.size(LodyIconSize.md))
                }
                if (tabs.any { !it.parentSessionId.isNullOrBlank() }) DirectoryTabs.attention(tabs.filter { it.id != currentId })?.let { attention ->
                    Box(Modifier.align(Alignment.BottomEnd).padding(end = LodySpacing.xs, bottom = LodySpacing.xs).size(LodyIconSize.xs + LodySpacing.xxs)
                        .background(colors.bgOverlay, CircleShape), contentAlignment = Alignment.Center) { app.lody.android.home.AttentionGlyph(attention) }
                }
                DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }, modifier = Modifier.heightIn(max = 420.dp)) {
                    ChatTabsMenu(tabs, closedTabs, currentId, creating, busy,
                        onSelect = { expanded = false; if (it != currentId) onSelectTab(it) },
                        onNew = { expanded = false; onNewTab() },
                        onClose = { onChangeTab(it, true) },
                        onRestore = { restoringId = it; onChangeTab(it, false) }, initialHistory = history, showNew = false)
                }
            }
            var more by remember { mutableStateOf(false) }
            Box {
                IconButton(onClick = { more = !more }, modifier = Modifier.size(LodySize.controlLg)) {
                    Icon(LodyIcons.More, stringResource(R.string.bar_more), tint = colors.iconPrimary, modifier = Modifier.size(LodyIconSize.md))
                }
                DropdownMenu(expanded = more, onDismissRequest = { more = false }) {
                    DropdownMenuItem(text = { Text(stringResource(R.string.chat_new_tab)) }, enabled = !creating && busy == null,
                        leadingIcon = { Icon(LodyIcons.Plus, null) }, onClick = { more = false; onNewTab() })
                    if (closedTabs.isNotEmpty()) DropdownMenuItem(text = { Text(stringResource(R.string.chat_closed_tabs)) },
                        onClick = { more = false; history = true; expanded = true })
                    DropdownMenuItem(text = { Text(stringResource(R.string.chat_close_current)) }, enabled = busy == null && tabs.any { it.id == currentId },
                        onClick = { more = false; onChangeTab(currentId, true) })
                }
            }
        }
    }
}

/** Mask only overflowing glyphs; Text retains the complete title in accessibility semantics. */
@Composable
internal fun ConversationTitle(title: String, modifier: Modifier = Modifier) {
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
    var overflowing by remember(title, rtl) { mutableStateOf(false) }
    Text(
        title,
        style = LodyTheme.typography.bodyEmphasis,
        color = LodyTheme.colors.textPrimary,
        maxLines = 1,
        softWrap = false,
        overflow = TextOverflow.Clip,
        onTextLayout = { overflowing = it.didOverflowWidth },
        modifier = modifier.fillMaxWidth()
            .graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
            .drawWithContent {
                drawContent()
                if (overflowing && size.width > 0f) {
                    val fade = LodySpacing.xl.toPx().coerceAtMost(size.width)
                    drawRect(
                        brush = Brush.horizontalGradient(
                            colors = if (rtl) listOf(Color.Transparent, Color.Black) else listOf(Color.Black, Color.Transparent),
                            startX = if (rtl) 0f else size.width - fade,
                            endX = if (rtl) fade else size.width,
                        ),
                        blendMode = BlendMode.DstIn,
                    )
                }
            },
    )
}

/** Web's round glass-like control (header back, scroll to latest). */
@Composable
private fun RoundButton(icon: ImageVector, label: String, modifier: Modifier = Modifier, visualSize: Dp = LodySize.controlLg, onClick: () -> Unit) {
    val colors = LodyTheme.colors
    IconButton(
        onClick = onClick,
        modifier = modifier.size(LodySize.controlLg).semantics { contentDescription = label },
    ) {
        Box(
            Modifier.size(visualSize)
                .dropShadow(CircleShape, LodyElevations.sm.shadow())
                .clip(CircleShape)
                .background(colors.bgOverlay)
                .border(0.5.dp, colors.borderSubtle, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = colors.iconPrimary, modifier = Modifier.size(LodyIconSize.md))
        }
    }
}

private data class Outgoing(val turnId: String, val text: String, val at: String, val delivery: Delivery, val attachments: List<MessageAttachment> = emptyList())

internal fun delivery(status: String) = when (status) {
    // Execution failure/cancellation still acknowledges receipt, as on desktop.
    // Only a send failure means the turn was not delivered.
    "seen", "processing", "handled", "failed", "canceled", "completed", "done" -> Delivery.Seen
    "queued" -> Delivery.Queued
    "not_sent" -> Delivery.Failed
    else -> Delivery.Sent
}

/** Resolve once at display time so member refreshes do not rebuild Markdown. */
internal fun senderIdentity(userId: String?, me: Account?, member: app.lody.android.auth.WorkspaceMember?, fallback: String, time: String): TurnIdentity {
    if (member != null && member.id == (userId ?: me?.id)) return TurnIdentity(member.name.ifBlank { fallback }, member.image, time)
    if (me != null && (userId == null || userId == me.id)) return TurnIdentity(me.name, me.image, time)
    return TurnIdentity(fallback, time = time)
}

/** The session's assistant, by its last model or its agent type ("claude-code" → "Claude Code"). */
private fun agentLabel(session: CatalogSession?): String =
    session?.agentType?.split('-', '_')?.joinToString(" ") { part -> part.replaceFirstChar { it.uppercase() } }
        ?: session?.modelName ?: "Agent"

/** "Worked for 8s" / "1m 5s" once the turn finished; [format] holds one `%1$s`. */
private fun worked(message: SessionMessage, format: String, secondsFormat: String, minutesFormat: String): String {
    val seconds = messageWorkSeconds(message) ?: return ""
    val span = if (seconds < 60) String.format(secondsFormat, seconds) else String.format(minutesFormat, seconds / 60, seconds % 60)
    return String.format(format, span)
}

/** Today: "09:31"; otherwise "7/9 09:31", in the device's zone. */
private fun turnTime(timestamp: String?): String {
    val instant = timestamp?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: return ""
    val zoned = instant.atZone(ZoneId.systemDefault())
    val pattern = if (zoned.toLocalDate() == LocalDate.now()) "HH:mm" else "M/d HH:mm"
    return zoned.format(DateTimeFormatter.ofPattern(pattern))
}

/**
 * Web's mobile session composer. At rest one capsule line — +, the prompt, the agent's mark ⌄
 * (it opens the run-config sheet) and Send. Editing (or attachments waiting to go) opens it into
 * the new-chat card (`create/CreateSessionScreen` `Composer`): the prompt, then +, the run-config
 * chip (the Role's emoji or the provider's mark, model · effort, the mode's glyph, Plan and Fast
 * when on) and Send. Send becomes Stop while a turn runs and nothing is typed. The one text field
 * stays put across both, so focus and the keyboard survive. No @ button, as web and iOS.
 */
@OptIn(androidx.compose.animation.ExperimentalSharedTransitionApi::class)
@Composable
internal fun ChatComposer(
    prompt: androidx.compose.ui.text.input.TextFieldValue,
    onPromptChange: (androidx.compose.ui.text.input.TextFieldValue) -> Unit,
    onFocusChange: (Boolean) -> Unit,
    referencePresentation: androidx.compose.ui.text.input.VisualTransformation = androidx.compose.ui.text.input.VisualTransformation.None,
    enabled: Boolean,
    agentCliType: String?,
    agentType: String?,
    roleEmoji: String?,
    roleName: String?,
    agentName: String?,
    face: List<String>,
    mode: String?,
    modeLabel: String?,
    plan: Boolean,
    fast: Boolean,
    onRunConfig: (() -> Unit)?,
    stoppable: Boolean,
    stopping: Boolean,
    attachments: List<PendingAttachment>,
    onPickPhotos: () -> Unit,
    onPickFiles: () -> Unit,
    onRemoveAttachment: (String) -> Unit,
    onSend: () -> Unit,
    onStop: () -> Unit,
    usage: app.lody.android.runtime.SessionUsage? = null,
) {
    val colors = LodyTheme.colors
    val type = LodyTheme.typography
    // Web: "Work with <assistant>" — the Agent Role when one is, else the conversation's agent.
    val workWith = roleName ?: agentName
    val placeholder = when {
        !enabled -> stringResource(R.string.chat_composer_unavailable)
        workWith.isNullOrEmpty() -> stringResource(R.string.chat_composer_placeholder)
        else -> stringResource(R.string.create_composer_placeholder_agent, workWith)
    }
    var focused by remember { mutableStateOf(false) }
    val expanded = focused || attachments.isNotEmpty()
    // Dismissing the keyboard (Back, swipe) also ends editing.
    val focusManager = androidx.compose.ui.platform.LocalFocusManager.current
    @OptIn(ExperimentalLayoutApi::class)
    val imeVisible = WindowInsets.isImeVisible
    LaunchedEffect(imeVisible) { if (!imeVisible && focused) focusManager.clearFocus() }
    // A capsule at rest, the card while open.
    val radius by androidx.compose.animation.core.animateDpAsState(
        if (expanded) LodyRadius.xl else LodySize.controlLg / 2 + LodySpacing.xs, label = "composer-radius",
    )
    val shape = RoundedCornerShape(radius)
    val runConfigLabel = stringResource(R.string.chat_run_config)
    val showStop = stoppable && prompt.text.isBlank() && attachments.isEmpty()
    val ready = if (showStop) !stopping else enabled && (prompt.text.isNotBlank() || attachments.isNotEmpty())

    @Composable
    fun Plus() {
        Box {
            val attach = stringResource(R.string.create_attach)
            var attachMenu by remember { mutableStateOf(false) }
            IconButton(onClick = { attachMenu = true }, enabled = enabled, modifier = Modifier.semantics { contentDescription = attach }.widthIn(min = LodySize.controlMd)) {
                Icon(LodyIcons.Plus, contentDescription = null, tint = colors.iconPrimary, modifier = Modifier.size(LodyIconSize.md))
            }
            DropdownMenu(expanded = attachMenu, onDismissRequest = { attachMenu = false }) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.chat_attach_photos)) },
                    leadingIcon = { Icon(LodyIcons.Image, contentDescription = null) },
                    onClick = { attachMenu = false; onPickPhotos() },
                )
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.chat_attach_files)) },
                    leadingIcon = { Icon(LodyIcons.File, contentDescription = null) },
                    onClick = { attachMenu = false; onPickFiles() },
                )
            }
        }
    }

    // Stop takes Send's place while a turn runs and nothing is typed (web); the glyphs cross-fade
    // and the fill follows, so the button never jumps.
    @Composable
    fun Send() {
        val label = stringResource(if (showStop) R.string.chat_stop else R.string.create_send)
        val fill by androidx.compose.animation.animateColorAsState(
            when { showStop -> colors.textPrimary; ready -> colors.accentSolid; else -> colors.fillSecondary }, label = "send-fill",
        )
        LodyFilledIconButton(
            onClick = if (showStop) onStop else onSend, enabled = ready,
            modifier = Modifier.padding(LodySpacing.xxs).size(LodySize.controlSm)
                .semantics { contentDescription = label },
            colors = IconButtonDefaults.filledIconButtonColors(
                containerColor = fill, disabledContainerColor = fill,
                contentColor = if (showStop) colors.bgBase else colors.textOnAccent,
                disabledContentColor = colors.iconTertiary,
            ),
        ) {
            androidx.compose.animation.Crossfade(showStop, label = "send-stop") { stop ->
                if (stop) Icon(LodyIcons.Stop, contentDescription = null, tint = colors.bgBase, modifier = Modifier.size(LodyIconSize.sm))
                else Icon(LodyIcons.Send, contentDescription = null, tint = if (ready) colors.textOnAccent else colors.iconTertiary, modifier = Modifier.size(LodyIconSize.sm))
            }
        }
    }

    androidx.compose.animation.SharedTransitionLayout {
        Column(
            Modifier
                .padding(horizontal = LodyLayout.screenPaddingX, vertical = LodySpacing.sm)
                .fillMaxWidth()
                .dropShadow(shape, LodyElevations.md.shadow())
                .clip(shape)
                .background(colors.bgOverlay, shape)
                .animateContentSize(androidx.compose.animation.core.spring(dampingRatio = 1f, stiffness = androidx.compose.animation.core.Spring.StiffnessMediumLow))
                .padding(LodySpacing.xs),
        ) {
            // Picked attachments, one removable chip each, above the prompt (web / iOS attachment stack).
            androidx.compose.animation.AnimatedVisibility(
                attachments.isNotEmpty(),
                enter = androidx.compose.animation.expandVertically() + androidx.compose.animation.fadeIn(),
                exit = androidx.compose.animation.shrinkVertically() + androidx.compose.animation.fadeOut(),
            ) {
                val remove = stringResource(R.string.chat_attach_remove)
                androidx.compose.foundation.lazy.LazyRow(
                    Modifier.fillMaxWidth().padding(horizontal = LodySpacing.xs, vertical = LodySpacing.xs),
                    horizontalArrangement = Arrangement.spacedBy(LodySpacing.xs),
                ) {
                    items(attachments, key = { it.id }) { item ->
                        AttachmentChip(item.name, item.image, Modifier.animateItem()) {
                            Box(
                                Modifier
                                    .size(LodySize.controlSm)
                                    .clip(CircleShape)
                                    .clickable(role = Role.Button) { onRemoveAttachment(item.id) }
                                    .semantics { contentDescription = "$remove ${item.name}" },
                                contentAlignment = Alignment.Center,
                            ) {
                                Icon(LodyIcons.Close, contentDescription = null, tint = colors.iconTertiary, modifier = Modifier.size(LodyIconSize.xs))
                            }
                        }
                    }
                }
            }
            // At rest the line holds +, the prompt, the agent's mark ⌄ and Send; open, only the prompt.
            Row(Modifier.fillMaxWidth().heightIn(min = LodySize.controlLg - LodySpacing.xs * 2), verticalAlignment = Alignment.CenterVertically) {
                if (!expanded) Plus()
                BasicTextField(
                    value = prompt,
                    visualTransformation = referencePresentation,
                    onValueChange = onPromptChange,
                    enabled = enabled,
                    textStyle = type.body.copy(color = colors.textPrimary),
                    cursorBrush = SolidColor(colors.accentDefault),
                    minLines = if (focused) 3 else 1,
                    maxLines = if (expanded) 10 else 1,
                    modifier = Modifier
                        .weight(1f)
                        .onFocusChanged { focused = it.isFocused; onFocusChange(it.isFocused) }
                        .padding(horizontal = LodySpacing.sm, vertical = LodySpacing.sm)
                        .semantics { contentDescription = placeholder },
                    decorationBox = { inner ->
                        Box {
                            if (prompt.text.isEmpty()) Text(placeholder, style = type.body, color = colors.textPlaceholder, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            inner()
                        }
                    },
                )
                androidx.compose.animation.AnimatedVisibility(
                    !expanded,
                    enter = androidx.compose.animation.fadeIn(),
                    exit = androidx.compose.animation.fadeOut(),
                ) {
                    val markVisibility = this
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        // The running agent's mark (the Role's emoji when one is).
                        Row(
                            Modifier
                                .heightIn(min = LodySize.controlMd)
                                .clip(RoundedCornerShape(LodyRadius.md))
                                .clickable(enabled = onRunConfig != null, role = Role.Button) { onRunConfig?.invoke() }
                                .semantics { contentDescription = "$runConfigLabel: ${listOfNotNull(roleName).plus(face).joinToString(", ")}" }
                                .padding(horizontal = LodySpacing.sm),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(LodySpacing.xs),
                        ) {
                            Box(Modifier.sharedElement(
                                rememberSharedContentState("composer-agent"), markVisibility,
                                boundsTransform = { _, _ -> androidx.compose.animation.core.spring(dampingRatio = 1f, stiffness = androidx.compose.animation.core.Spring.StiffnessMediumLow) },
                            )) {
                                if (roleEmoji != null) Text(roleEmoji, style = type.body)
                                else AgentMark(agentCliType, agentType, colors.iconPrimary, Modifier.size(LodyIconSize.md))
                            }
                        }
                        SessionUsageButton(usage)
                        Send()
                    }
                }
            }
            androidx.compose.animation.AnimatedVisibility(
                expanded,
                enter = androidx.compose.animation.expandVertically() + androidx.compose.animation.fadeIn(),
                exit = androidx.compose.animation.shrinkVertically() + androidx.compose.animation.fadeOut(),
            ) {
                val markVisibility = this
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Plus()
                    // The run-config chip, as the new-chat page draws it.
                    val fastLabel = stringResource(R.string.run_config_fast)
                    Row(
                        Modifier
                            .weight(1f)
                            .heightIn(min = LodySize.controlMd)
                            .clip(RoundedCornerShape(LodyRadius.md))
                            .clickable(enabled = onRunConfig != null, role = Role.Button) { onRunConfig?.invoke() }
                            .semantics { contentDescription = "$runConfigLabel: ${listOfNotNull(roleName).plus(face).joinToString(", ")}" }
                            .padding(horizontal = LodySpacing.sm),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(LodySpacing.sm),
                    ) {
                        // An Agent Role leads with its emoji instead of the assistant's mark (web's Role face).
                        Box(Modifier.sharedElement(
                            rememberSharedContentState("composer-agent"), markVisibility,
                            boundsTransform = { _, _ -> androidx.compose.animation.core.spring(dampingRatio = 1f, stiffness = androidx.compose.animation.core.Spring.StiffnessMediumLow) },
                        )) {
                            if (roleEmoji != null) Text(roleEmoji, style = type.subhead)
                            else AgentMark(agentCliType, agentType, colors.iconSecondary, Modifier.size(LodyIconSize.sm))
                        }
                        fun label(named: Boolean) = buildAnnotatedString {
                            // With the Role's name, model · effort recede to secondary ink.
                            if (named) withStyle(SpanStyle(color = colors.textPrimary)) { append(roleName.orEmpty()); append("   ") }
                            face.forEachIndexed { index, part ->
                                if (index > 0) withStyle(SpanStyle(color = colors.textTertiary)) { append("  ·  ") }
                                withStyle(SpanStyle(color = if (named) colors.textSecondary else colors.textPrimary)) { append(part) }
                            }
                        }
                        // The Role's name only when the whole face fits; otherwise the emoji alone marks it.
                        androidx.compose.foundation.layout.BoxWithConstraints(Modifier.weight(1f, fill = false)) {
                            val measurer = androidx.compose.ui.text.rememberTextMeasurer()
                            val named = label(named = true)
                            val fits = !roleName.isNullOrEmpty() &&
                                measurer.measure(named, type.subhead, maxLines = 1).size.width <= constraints.maxWidth
                            Text(if (fits) named else label(named = false), style = type.subhead, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        app.lody.android.create.ModeMark(mode, modeLabel)
                        if (plan) Icon(LodyIcons.PermissionPlan, contentDescription = stringResource(R.string.run_config_plan), tint = colors.iconSecondary, modifier = Modifier.size(LodyIconSize.sm))
                        if (fast) Text(fastLabel, style = type.caption, color = colors.accentFg)
                    }
                    SessionUsageButton(usage)
                    Send()
                }
            }
        }
    }
}

/**
 * Web `SessionInfoBar` above the composer as grouped capsules, so the composer stays the only
 * full-width shape: the computer (menu names it), the context (PR or branch with ±diff; menu
 * opens the PR or copies the branch) and, pinned trailing, the repository action as a neutral
 * split capsule. Colour is for status only, so Send stays the one accent. It never scrolls: the
 * first stage that fits on one line wins — labels capped, then the diff hidden — and only at
 * very large text does the action move to its own row. iOS: `ChatActionBarView`.
 */
@Composable
internal fun ChatActionBar(
    bar: SessionInfoBar,
    onAction: (SessionInfoBar.Action) -> Unit,
    onCopied: (String) -> Unit,
    writing: SessionInfoBar.Action? = null,
) {
    val context = bar.pullRequest != null || bar.branch.isNotEmpty() || bar.repository.isNotEmpty()
    val diff = bar.added + bar.removed > 0
    if (!context && !diff && bar.actions.isEmpty()) return
    @Composable fun Leading(diffDot: Boolean, modifier: Modifier = Modifier) {
        if (context || diff) ContextItem(bar, diffDot, onCopied, modifier)
    }
    @Composable fun Action() {
        if (writing != null) ActionSplit(listOf(writing), onAction, pending = true)
        else if (bar.actions.isNotEmpty()) ActionSplit(bar.actions, onAction)
    }
    @Composable fun Line(fill: Boolean, diffDot: Boolean) {
        Row(
            if (fill) Modifier.fillMaxWidth() else Modifier,
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(LodySpacing.sm),
        ) {
            Leading(diffDot)
            if (fill) Spacer(Modifier.weight(1f))
            Action()
        }
    }
    FirstThatFits(
        Modifier.padding(horizontal = LodySpacing.md).padding(top = LodySpacing.xs).fillMaxWidth(),
        stages = listOf({ fill -> Line(fill, diffDot = false) }, { fill -> Line(fill, diffDot = true) }),
    ) {
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(LodySpacing.sm)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LodySpacing.sm)) {
                Leading(diffDot = true, Modifier.weight(1f, fill = false))
            }
            Action()
        }
    }
}

/**
 * Shows the first stage whose natural one-line width fits (each is probed unfilled, then shown
 * filled to the available width), else [fallback].
 */
@Composable
private fun FirstThatFits(modifier: Modifier, stages: List<@Composable (fill: Boolean) -> Unit>, fallback: @Composable () -> Unit) {
    SubcomposeLayout(modifier) { constraints ->
        val loose = Constraints(maxHeight = constraints.maxHeight)
        val index = stages.indices.firstOrNull { i ->
            val width = subcompose("probe$i") { stages[i](false) }.maxOfOrNull { it.measure(loose).width } ?: 0
            width <= constraints.maxWidth
        }
        val placeables = subcompose("show${index ?: "fallback"}") {
            if (index != null) stages[index](true) else fallback()
        }.map { it.measure(constraints.copy(minWidth = 0)) }
        layout(constraints.maxWidth, placeables.maxOfOrNull { it.height } ?: 0) { placeables.forEach { it.place(0, 0) } }
    }
}

private val CapsuleHeight = 36.dp

/** One raised capsule of the bar. */
private fun Modifier.barCapsule(colors: LodyColors): Modifier = this
    .height(CapsuleHeight)
    .clip(CircleShape)
    .background(colors.bgRaised)
    .border(0.5.dp, colors.borderSubtle, CircleShape)

/** A tappable cell inside a capsule; the capsule draws the surface. */
@Composable
private fun BarCell(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, onLongClick: (() -> Unit)? = null, content: @Composable RowScope.() -> Unit) {
    Row(
        modifier
            .height(CapsuleHeight)
            .widthIn(min = CapsuleHeight)
            .clip(RoundedCornerShape(percent = 50))
            .combinedClickable(role = Role.Button, onClickLabel = label, onClick = onClick, onLongClick = onLongClick)
            .semantics { contentDescription = label }
            .padding(horizontal = LodySpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(LodySpacing.xs, Alignment.CenterHorizontally),
        content = content,
    )
}

internal data class MachinePanelData(
    val owner: app.lody.android.auth.WorkspaceMember? = null,
    val shared: Boolean? = null,
    val online: Boolean? = null,
)

@Composable
private fun MachineItem(name: String, online: Boolean?, load: suspend () -> MachinePanelData) {
    val colors = LodyTheme.colors
    var open by remember { mutableStateOf(false) }
    var data by remember(name) { mutableStateOf(MachinePanelData()) }
    LaunchedEffect(open, name) {
        if (open) { data = MachinePanelData(); data = load() }
    }
    Box {
        Row(Modifier.clickable { open = true }.padding(vertical = LodySpacing.xxs), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LodySpacing.xs)) {
            Icon(when (online) { true -> LodyIcons.Check; false -> LodyIcons.Close; null -> LodyIcons.Cloud },
                contentDescription = stringResource(when (online) { true -> R.string.machine_online; false -> R.string.home_offline; null -> R.string.machine_status_unknown }),
                tint = colors.iconSecondary, modifier = Modifier.size(LodyIconSize.sm))
            Text(name, style = LodyTheme.typography.footnote, color = colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        DropdownMenu(open, onDismissRequest = { open = false }) {
            Column(Modifier.widthIn(max = LodyLayout.readableMaxWidth).padding(LodySpacing.lg), verticalArrangement = Arrangement.spacedBy(LodySpacing.md)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LodySpacing.sm)) {
                    Icon(LodyIcons.Desktop, contentDescription = null, modifier = Modifier.size(LodyIconSize.md))
                    Text(name, style = LodyTheme.typography.bodyEmphasis, modifier = Modifier.weight(1f, fill = false), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(stringResource(when (data.online) { true -> R.string.machine_online; false -> R.string.home_offline; null -> R.string.machine_status_unknown }), style = LodyTheme.typography.footnote, color = colors.textSecondary)
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LodySpacing.sm)) {
                    val ownerName = data.owner?.name?.takeIf { it.isNotBlank() } ?: stringResource(R.string.machine_owner_unknown)
                    app.lody.android.home.Avatar(data.owner?.image, ownerName, LodySize.controlSm)
                    Text(ownerName, style = LodyTheme.typography.body, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Text(stringResource(when (data.shared) { true -> R.string.machine_shared; false -> R.string.projects_github_private; null -> R.string.machine_visibility_unknown }), style = LodyTheme.typography.subhead, color = colors.textSecondary)
            }
        }
    }
}

/**
 * PR number, else branch, else the repository name without its owner, with the ±diff in the same
 * capsule (a dot when space is short; the counts then lead the menu). CI trouble tints the glyph.
 */
@Composable
private fun ContextItem(bar: SessionInfoBar, diffDot: Boolean, onCopied: (String) -> Unit, modifier: Modifier = Modifier) {
    val colors = LodyTheme.colors
    val type = LodyTheme.typography
    val clipboard = androidx.compose.ui.platform.LocalClipboardManager.current
    var open by remember { mutableStateOf(false) }
    val pr = bar.pullRequest
    val ci = pr?.ci
    val verdict = when (ci) {
        "s" -> stringResource(R.string.bar_ci_s)
        "f" -> stringResource(R.string.bar_ci_f)
        "e" -> stringResource(R.string.bar_ci_e)
        "p" -> stringResource(R.string.bar_ci_p)
        "x" -> stringResource(R.string.home_ci_expected)
        else -> null
    }
    val label = pr?.let { "#${it.number}" } ?: bar.branch.ifEmpty { bar.repository.substringAfterLast('/') }
    val copied = stringResource(R.string.bar_branch_copied)
    val diff = bar.added + bar.removed > 0
    val counts = "+${bar.added} −${bar.removed}"
    val showsContext = pr != null || bar.branch.isNotEmpty() || bar.repository.isNotEmpty()
    val description = listOfNotNull(bar.repository, bar.branch, label, verdict, counts.takeIf { diff })
        .filter { it.isNotEmpty() }.distinct().joinToString(", ")
    var panel by remember { mutableStateOf(false) }
    if (panel && pr != null) PullRequestSheet(bar, pr, verdict, onCopied) { panel = false }
    Box(modifier.barCapsule(colors)) {
        // Always choose a destination before opening the PR or inspecting changes.
        BarCell(
            description,
            onClick = { open = true },
            Modifier.padding(horizontal = LodySpacing.xs),
            onLongClick = if (pr != null) ({ open = true }) else null,
        ) {
            if (showsContext) {
                if (pr != null) app.lody.android.designsystem.LodyPullRequestIcon(pr.status, pr.ci)
                else Icon(LodyIcons.Branch, contentDescription = null, tint = colors.iconSecondary, modifier = Modifier.size(LodyIconSize.sm))
                Text(label, style = type.subhead, color = colors.textPrimary, maxLines = 1, overflow = TextOverflow.MiddleEllipsis,
                    // Not weighted: the fitting probe measures unbounded, where a weight would read as zero.
                    modifier = Modifier.widthIn(max = 160.dp))
            }
            if (diff && (!diffDot || !showsContext)) {
                val style = type.subhead.copy(fontFeatureSettings = "tnum")
                Text("+${bar.added}", style = style, color = colors.diffAddedText, maxLines = 1)
                Text("−${bar.removed}", style = style, color = colors.diffRemovedText, maxLines = 1)
            }
            val optionCount = (if (pr != null) 1 else 0) + (if (diff) 1 else 0) + (if (bar.branch.isNotEmpty()) 1 else 0)
            if (optionCount > 1) {
                Icon(LodyIcons.Expand, contentDescription = null, tint = colors.iconSecondary, modifier = Modifier.size(LodyIconSize.sm))
            }
        }
        DropdownMenu(open, onDismissRequest = { open = false }, modifier = Modifier.width(320.dp)) {
            if (bar.repository.isNotEmpty()) {
                Text(bar.repository, style = type.subhead, color = colors.textSecondary,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(horizontal = LodySpacing.md, vertical = LodySpacing.xs))
            }
            if (bar.branch.isNotEmpty()) {
                Row(Modifier.fillMaxWidth().padding(start = LodySpacing.md), verticalAlignment = Alignment.CenterVertically) {
                    Text(bar.branch, style = type.footnote, color = colors.textSecondary, maxLines = 1,
                        overflow = TextOverflow.MiddleEllipsis, modifier = Modifier.weight(1f))
                    IconButton(onClick = {
                        open = false
                        clipboard.setText(androidx.compose.ui.text.AnnotatedString(bar.branch))
                        onCopied(copied)
                    }) {
                        Icon(LodyIcons.Copy, contentDescription = stringResource(R.string.bar_copy_branch),
                            tint = colors.iconSecondary, modifier = Modifier.size(LodyIconSize.sm))
                    }
                }
            }
            if (pr != null) {
                DropdownMenuItem(
                    text = {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(stringResource(R.string.bar_view_pr), style = type.body, modifier = Modifier.width(100.dp))
                            Text("#${pr.number}", style = type.body.copy(fontFeatureSettings = "tnum"))
                        }
                    },
                    leadingIcon = { app.lody.android.designsystem.LodyPullRequestIcon(pr.status, pr.ci, size = LodyIconSize.md) },
                    onClick = { open = false; panel = true },
                )
            }
            if (diff) {
                // Display only until Android has a workspace changes page.
                DropdownMenuItem(
                    text = {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(stringResource(R.string.bar_workspace_changes), style = type.body, modifier = Modifier.width(100.dp))
                            Text(buildAnnotatedString {
                                withStyle(SpanStyle(color = colors.diffAddedText)) { append("+${bar.added}") }
                                append(" ")
                                withStyle(SpanStyle(color = colors.diffRemovedText)) { append("−${bar.removed}") }
                            }, style = type.body.copy(fontFeatureSettings = "tnum"), maxLines = 1)
                        }
                    },
                    leadingIcon = { Icon(LodyIcons.Diff, contentDescription = null, tint = colors.iconSecondary, modifier = Modifier.size(LodyIconSize.md)) },
                    onClick = { open = false },
                    enabled = false,
                )
            }
        }
    }
}

/**
 * Web's primary action + chevron as one neutral capsule with a soft internal divider: the top
 * action runs on tap (with a confirm haptic); the chevron's menu holds the rest in priority order.
 * Its label never truncates.
 */
@Composable
private fun ActionSplit(actions: List<SessionInfoBar.Action>, onAction: (SessionInfoBar.Action) -> Unit, pending: Boolean = false) {
    val colors = LodyTheme.colors
    val type = LodyTheme.typography
    val haptics = androidx.compose.ui.platform.LocalHapticFeedback.current
    var open by remember { mutableStateOf(false) }
    val first = actions.first()
    val more = stringResource(R.string.bar_more)
    Box {
        Row(
            Modifier.barCapsule(colors),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Button(
                onClick = {
                    haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.Confirm)
                    onAction(first)
                },
                enabled = !pending,
                modifier = Modifier.fillMaxHeight().defaultMinSize(minWidth = 1.dp, minHeight = 1.dp),
                colors = ButtonDefaults.textButtonColors(contentColor = colors.textPrimary),
                contentPadding = PaddingValues(start = LodySpacing.md, end = if (actions.size > 1) LodySpacing.sm else LodySpacing.md),
                elevation = null,
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LodySpacing.sm)) {
                    if (pending) app.lody.android.designsystem.LodyLoadingIndicator(modifier = Modifier.size(LodyIconSize.sm), color = colors.textSecondary)
                    val label = if (pending) stringResource(if (first == SessionInfoBar.Action.Merge) R.string.bar_merge_pending else R.string.bar_ready_pending) else actionTitle(first)
                    Text(label, style = type.subhead, color = colors.textPrimary, maxLines = 1)
                    if (!pending && first == SessionInfoBar.Action.Merge && actions.size == 1) {
                        Icon(LodyIcons.Expand, contentDescription = null, tint = colors.iconSecondary, modifier = Modifier.size(LodyIconSize.sm))
                    }
                }
            }
            if (actions.size > 1) {
                Box(Modifier.width(0.5.dp).height(LodyIconSize.sm).background(colors.borderStrong))
                LodyFilledIconButton(
                    onClick = { open = true },
                    modifier = Modifier.fillMaxHeight().width(LodyIconSize.sm + LodySpacing.sm * 2)
                        .semantics { contentDescription = more },
                    colors = IconButtonDefaults.filledIconButtonColors(
                        containerColor = androidx.compose.ui.graphics.Color.Transparent, contentColor = colors.iconSecondary,
                    ),
                ) {
                    Icon(LodyIcons.Expand, contentDescription = null, tint = colors.iconSecondary, modifier = Modifier.size(LodyIconSize.sm))
                }
            }
        }
        DropdownMenu(open, onDismissRequest = { open = false }) {
            for (action in actions.drop(1)) {
                DropdownMenuItem(
                    text = { Text(actionTitle(action), style = type.body, color = colors.textPrimary) },
                    leadingIcon = { Icon(actionIcon(action), contentDescription = null, tint = colors.iconSecondary, modifier = Modifier.size(LodyIconSize.md)) },
                    onClick = {
                        open = false
                        haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.Confirm)
                        onAction(action)
                    },
                )
            }
        }
    }
}

@Composable
private fun actionTitle(action: SessionInfoBar.Action): String = stringResource(
    when (action) {
        SessionInfoBar.Action.CreatePr -> R.string.bar_action_create_pr
        SessionInfoBar.Action.CreateDraftPr -> R.string.bar_action_create_draft_pr
        SessionInfoBar.Action.CommitAndPush -> R.string.bar_action_commit_and_push
        SessionInfoBar.Action.ResolveConflicts -> R.string.bar_action_resolve_conflicts
        SessionInfoBar.Action.FixCi -> R.string.bar_action_fix_ci_errors
    SessionInfoBar.Action.ReadyForReview -> R.string.bar_action_ready_for_review
    SessionInfoBar.Action.Merge -> R.string.bar_action_merge
    },
)

private fun actionIcon(action: SessionInfoBar.Action): ImageVector = when (action) {
    SessionInfoBar.Action.CreatePr -> LodyIcons.PullRequest
    SessionInfoBar.Action.CreateDraftPr -> LodyIcons.PullRequestDraft
    SessionInfoBar.Action.CommitAndPush -> LodyIcons.Send
    SessionInfoBar.Action.ResolveConflicts -> LodyIcons.Merge
    SessionInfoBar.Action.FixCi -> LodyIcons.Check
    SessionInfoBar.Action.ReadyForReview -> LodyIcons.Eye
    SessionInfoBar.Action.Merge -> LodyIcons.Merge
}

private class WriteTexts(
    val mergePending: String, val mergeDone: String, val mergeError: String,
    val readyPending: String, val readyDone: String, val readyError: String,
    val errors: Map<String, String>,
)

private val WriteErrors = listOf("not_mergeable", "head_changed", "authorization_required", "merge_unknown", "ready_unknown", "not_open", "forbidden")

private fun writeErrorText(code: String): Int = when (code) {
    "not_mergeable" -> R.string.bar_error_not_mergeable
    "head_changed" -> R.string.bar_error_head_changed
    "authorization_required" -> R.string.bar_error_authorization_required
    "merge_unknown" -> R.string.bar_error_merge_unknown
    "ready_unknown" -> R.string.bar_error_ready_unknown
    "not_open" -> R.string.bar_error_not_open
    else -> R.string.bar_error_forbidden
}

/**
 * Merging cannot be undone, so choosing the method is also the confirmation: a native sheet
 * with web's three methods and their descriptions, the last one used first.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MergeSheet(title: String, preferred: String, onDismiss: () -> Unit, onMerge: (String) -> Unit) {
    val colors = LodyTheme.colors
    val type = LodyTheme.typography
    val methods = listOf(
        Triple("merge", R.string.bar_merge_merge, R.string.bar_merge_merge_desc),
        Triple("squash", R.string.bar_merge_squash, R.string.bar_merge_squash_desc),
        Triple("rebase", R.string.bar_merge_rebase, R.string.bar_merge_rebase_desc),
    ).sortedByDescending { it.first == preferred }
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = colors.bgBase) {
        Column(Modifier.padding(bottom = LodySpacing.lg)) {
            Text(title, style = type.headline, color = colors.textPrimary, modifier = Modifier.padding(horizontal = LodySpacing.lg))
            Text(stringResource(R.string.bar_merge_message), style = type.footnote, color = colors.textSecondary,
                modifier = Modifier.padding(horizontal = LodySpacing.lg, vertical = LodySpacing.xs))
            for ((method, label, description) in methods) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = LodySize.listRow)
                        .clickable(role = Role.Button) { onMerge(method) }
                        .padding(horizontal = LodySpacing.lg, vertical = LodySpacing.md),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(LodySpacing.md),
                ) {
                    Icon(LodyIcons.Merge, contentDescription = null, tint = colors.iconSecondary, modifier = Modifier.size(LodyIconSize.md))
                    Column(Modifier.weight(1f)) {
                        Text(stringResource(label), style = type.body, color = colors.textPrimary)
                        Text(stringResource(description), style = type.footnote, color = colors.textSecondary)
                    }
                    if (method == preferred) Icon(LodyIcons.Check, contentDescription = null, tint = colors.iconSecondary, modifier = Modifier.size(LodyIconSize.sm))
                }
            }
        }
    }
}

/**
 * The PR panel the context capsule opens: a native bottom sheet with what the catalog knows (state,
 * CI, conflicts, branch, ±diff), opening the PR on GitHub and copying the branch. iOS opens its
 * native PR page as a sheet.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PullRequestSheet(
    bar: SessionInfoBar,
    pr: CatalogPullRequest,
    verdict: String?,
    onCopied: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = LodyTheme.colors
    val type = LodyTheme.typography
    val uri = androidx.compose.ui.platform.LocalUriHandler.current
    val clipboard = androidx.compose.ui.platform.LocalClipboardManager.current
    val copied = stringResource(R.string.bar_branch_copied)
    val state = stringResource(
        when (pr.status) {
            "merged" -> R.string.home_pr_merged
            "closed" -> R.string.home_pr_closed
            "draft" -> R.string.home_pr_draft
            else -> R.string.home_pr_open
        },
    )
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = colors.bgBase) {
        Column(Modifier.padding(horizontal = LodySpacing.lg).padding(bottom = LodySpacing.xl), verticalArrangement = Arrangement.spacedBy(LodySpacing.md)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LodySpacing.sm)) {
                app.lody.android.designsystem.LodyPullRequestIcon(pr.status, pr.ci, size = LodyIconSize.lg)
                Column(Modifier.weight(1f)) {
                    Text("${pr.repository} #${pr.number}", style = type.headline, color = colors.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(listOfNotNull(state, verdict, if (pr.merge == "d") stringResource(R.string.bar_conflicts) else null).joinToString(" · "),
                        style = type.footnote, color = colors.textSecondary)
                }
            }
            if (bar.branch.isNotEmpty() || bar.added + bar.removed > 0) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LodySpacing.sm)) {
                    Icon(LodyIcons.Branch, contentDescription = null, tint = colors.iconSecondary, modifier = Modifier.size(LodyIconSize.sm))
                    Text(bar.branch, style = type.subhead, color = colors.textSecondary, maxLines = 1, overflow = TextOverflow.MiddleEllipsis, modifier = Modifier.weight(1f))
                    if (bar.added + bar.removed > 0) {
                        val style = type.subhead.copy(fontFeatureSettings = "tnum")
                        Text("+${bar.added}", style = style, color = colors.diffAddedText)
                        Text("−${bar.removed}", style = style, color = colors.diffRemovedText)
                    }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(LodySpacing.sm)) {
                Button(
                    onClick = { onDismiss(); uri.openUri(bar.pullRequestUrl) },
                    colors = ButtonDefaults.buttonColors(containerColor = colors.fillSecondary, contentColor = colors.textPrimary),
                    modifier = Modifier.weight(1f),
                ) {
                    Icon(LodyIcons.ExternalLink, contentDescription = null, modifier = Modifier.size(LodyIconSize.sm))
                    Spacer(Modifier.width(LodySpacing.xs))
                    Text(stringResource(R.string.bar_open_github), style = type.subhead)
                }
                if (bar.branch.isNotEmpty()) {
                    Button(
                        onClick = {
                            clipboard.setText(androidx.compose.ui.text.AnnotatedString(bar.branch))
                            onCopied(copied)
                            onDismiss()
                        },
                        colors = ButtonDefaults.buttonColors(containerColor = colors.fillSecondary, contentColor = colors.textPrimary),
                        modifier = Modifier.weight(1f),
                    ) {
                        Icon(LodyIcons.Copy, contentDescription = null, modifier = Modifier.size(LodyIconSize.sm))
                        Spacer(Modifier.width(LodySpacing.xs))
                        Text(stringResource(R.string.bar_copy_branch), style = type.subhead)
                    }
                }
            }
        }
    }
}
