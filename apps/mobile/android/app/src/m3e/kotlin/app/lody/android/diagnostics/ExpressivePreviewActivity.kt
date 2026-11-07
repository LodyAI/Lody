@file:OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class)

package app.lody.android.diagnostics

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.core.view.WindowCompat
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.lody.android.designsystem.*
import app.lody.android.create.PickerOption
import app.lody.android.create.RunConfigRow
import androidx.compose.ui.text.input.TextFieldValue

/** Offline design spike. No runtime, network writes, launcher entry or production route. */
class ExpressivePreviewActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val initial = intent.getStringExtra("screen") ?: "home"
        val night = intent.getBooleanExtra("dark", false)
        setContent { ExpressivePreview(initial, night) }
    }
}

@Composable
private fun ExpressivePreview(initial: String, night: Boolean) {
    var dark by remember { mutableStateOf(night) }
    var screen by remember { mutableStateOf(if (initial == "home") "home" else "chat") }
    var settings by remember { mutableStateOf(initial == "config") }
    var method by remember { mutableStateOf(false) }
    var merged by remember { mutableStateOf(false) }
    var running by remember { mutableStateOf(false) }
    var prompt by remember { mutableStateOf(TextFieldValue()) }
    val view = LocalView.current
    SideEffect {
        val window = (view.context as android.app.Activity).window
        WindowCompat.getInsetsController(window, view).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
    }
    LodyTheme(darkTheme = dark) {
        val base = MaterialTheme.colorScheme
        // Use the production palette and typography; only Material component behavior changes.
        val colors = base
        MaterialExpressiveTheme(colorScheme = colors, typography = MaterialTheme.typography, motionScheme = MotionScheme.expressive()) {
            Scaffold(
                topBar = {
                    Column(Modifier.statusBarsPadding()) {
                        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text("M3 Expressive · 试样", style = MaterialTheme.typography.labelMedium,
                                color = colors.onSurfaceVariant, modifier = Modifier.weight(1f))
                            TextButton(onClick = { screen = if (screen == "home") "chat" else "home" }) {
                                Text(if (screen == "home") "查看对话" else "查看首页")
                            }
                            IconButton(onClick = { dark = !dark }) { Glyph(if (dark) LodyIcons.Sun else LodyIcons.Moon, "切换明暗") }
                        }
                        if (screen == "home") {
                            TopAppBar(title = { Text("Lody", fontWeight = FontWeight.SemiBold) }, actions = {
                                IconButton(onClick = { settings = true }) { Glyph(LodyIcons.Search, "搜索试样") }
                                IconButton(onClick = { settings = true }) { Glyph(LodyIcons.Filter, "筛选试样") }
                            })
                        } else {
                            TopAppBar(title = { Column {
                                Text("优化移动端对话体验", maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium)
                                Text("lody-mobile-dev · 2 个仓库", style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant)
                            } }, navigationIcon = { IconButton(onClick = { screen = "home" }) { Glyph(LodyIcons.Back, "返回") } },
                                actions = { IconButton(onClick = { settings = true }) { Glyph(LodyIcons.More, "更多试样") } })
                        }
                    }
                },
                bottomBar = {
                    if (screen == "home") PreviewNavigation { screen = "chat" }
                    else Column(Modifier.navigationBarsPadding().imePadding().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            FilledTonalIconButton(onClick = { settings = true }) { Glyph(LodyIcons.Machine, "机器") }
                            AssistChip(onClick = { method = true }, label = { Text("#128  +56 −2") }, leadingIcon = { Glyph(LodyIcons.Branch) })
                            Spacer(Modifier.weight(1f))
                            SplitButtonLayout(leadingButton = {
                                SplitButtonDefaults.LeadingButton(onClick = { merged = !merged }, colors = ButtonDefaults.filledTonalButtonColors()) { Text(if (merged) "已合并" else "合并") }
                            }, trailingButton = {
                                SplitButtonDefaults.TrailingButton(onClick = { method = true }, colors = ButtonDefaults.filledTonalButtonColors()) { Glyph(LodyIcons.Expand, "合并选项") }
                            })
                        }
                        app.lody.android.chat.ChatComposer(
                            prompt = prompt, onPromptChange = { prompt = it }, onFocusChange = {}, enabled = true,
                            agentCliType = "builtin", agentType = "codex", roleEmoji = null, roleName = null,
                            agentName = "Codex", face = listOf("6 Astra", "Medium"), mode = "default", modeLabel = "Default",
                            plan = false, fast = true, onRunConfig = { settings = true }, stoppable = running,
                            stopping = false, attachments = emptyList(), onPickPhotos = {}, onPickFiles = {},
                            onRemoveAttachment = {}, onSend = { running = true; prompt = TextFieldValue() }, onStop = { running = false },
                        )
                    }
                },
            ) { padding ->
                if (screen == "home") PreviewHome(Modifier.padding(padding)) { screen = "chat" }
                else PreviewConversation(Modifier.padding(padding), running) { settings = true }
            }
            if (settings) RunConfigSheet { settings = false }
            if (method) ModalBottomSheet(onDismissRequest = { method = false }) {
                Column(Modifier.padding(horizontal = 24.dp).padding(bottom = 24.dp)) {
                    Text("合并 Pull Request", style = MaterialTheme.typography.headlineSmall)
                    Text("#128 · 改进移动端对话体验", color = colors.onSurfaceVariant, modifier = Modifier.padding(vertical = 12.dp))
                    listOf("Squash and merge", "Merge commit", "Rebase and merge").forEach { name ->
                        TextButton(onClick = { merged = true; method = false }, modifier = Modifier.fillMaxWidth()) { Text(name) }
                    }
                    Text("本地试样，不会操作真实 PR", style = MaterialTheme.typography.labelSmall, color = colors.onSurfaceVariant)
                }
            }
        }
    }
}

@Composable private fun Glyph(icon: ImageVector, description: String? = null) {
    Icon(icon, description, Modifier.size(20.dp))
}

@Composable private fun PreviewNavigation(open: () -> Unit) {
    var selected by remember { mutableStateOf(app.lody.android.home.HomeTab.Chats) }
    app.lody.android.home.HomeBottomBar(selected, collapsed = false, onSelect = { selected = it }, onCreate = open)
}

@Composable private fun PreviewHome(modifier: Modifier, open: () -> Unit) {
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = true, onClick = {}, label = { Text("我的任务") }, leadingIcon = { Glyph(LodyIcons.Check) })
            FilterChip(selected = false, onClick = open, label = { Text("按时间") }, trailingIcon = { Glyph(LodyIcons.Expand) })
        }
        Text("今天", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 20.dp, bottom = 8.dp))
        listOf(
            Triple("优化移动端对话体验", "lody-mobile-dev · feature/mobile", "进行中"),
            Triple("支持多成员项目", "lody-mobile-dev · #128", "待审核"),
            Triple("新建对话支持图片附件", "lody-mobile · main", "12 分钟"),
        ).forEachIndexed { index, (title, detail, time) ->
            Surface(onClick = open, color = MaterialTheme.colorScheme.surface, shape = RoundedCornerShape(16.dp)) {
                ListItem(headlineContent = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    supportingContent = { Text(detail, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    leadingContent = { Glyph(if (index == 0) LodyIcons.StateRunning else if (index == 1) LodyIcons.Branch else LodyIcons.Check) },
                    trailingContent = { Text(time, style = MaterialTheme.typography.labelSmall) },
                    colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface))
            }
        }
        Text("昨天", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 24.dp, bottom = 8.dp))
        listOf("完善项目选择与机器切换", "对齐 Agent 配置", "优化消息滚动体验").forEach {
            ListItem(headlineContent = { Text(it) }, supportingContent = { Text("lody-mobile-dev") },
                leadingContent = { Glyph(LodyIcons.Session) }, modifier = Modifier.fillMaxWidth(),
                colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface))
        }
        Spacer(Modifier.height(100.dp))
    }
}

@Composable private fun PreviewConversation(modifier: Modifier, running: Boolean, info: () -> Unit) {
    val c = MaterialTheme.colorScheme
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Surface(Modifier.align(Alignment.End).widthIn(max = 300.dp), shape = RoundedCornerShape(24.dp), color = c.surfaceContainerHigh) {
            Text("保留现在的基础布局，让 Android 的按钮和交互更贴近 Material。", Modifier.padding(16.dp), style = MaterialTheme.typography.bodyLarge)
        }
        Text("工作了 1分20秒  ›", color = c.onSurfaceVariant, style = MaterialTheme.typography.labelLarge)
        Text("让操作更清楚，让阅读更安静。", style = MaterialTheme.typography.titleLarge)
        Text("对话内容仍然占据主要空间。把更鲜明的形状、颜色和动效留给发送、选择和合并这些关键操作。", style = MaterialTheme.typography.bodyLarge)
        Surface(onClick = info, shape = RoundedCornerShape(20.dp), color = c.surfaceContainerLow) {
            Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                Glyph(LodyIcons.File); Text("  6 个文件", modifier = Modifier.weight(1f)); Text("+56", color = LodyTheme.colors.diffAddedText); Text("  −2", color = LodyTheme.colors.diffRemovedText); Glyph(LodyIcons.Forward)
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            var copied by remember { mutableStateOf(false) }
            IconButton(onClick = { copied = !copied }) { Glyph(if (copied) LodyIcons.Check else LodyIcons.Copy, "复制试样") }
            IconButton(onClick = info) { Glyph(LodyIcons.Info, "信息试样") }
            IconButton(onClick = info) { Glyph(LodyIcons.Branch, "分叉试样") }
            Text("13:24", style = MaterialTheme.typography.labelMedium, color = c.onSurfaceVariant)
        }
        if (running) Row(verticalAlignment = Alignment.CenterVertically) {
            CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            Text("  正在试运行…", color = c.onSurfaceVariant)
        }
    }
}

@Composable private fun RunConfigSheet(close: () -> Unit) {
    var effort by remember { mutableStateOf("Medium") }
    var model by remember { mutableStateOf("6 Astra") }
    var mode by remember { mutableStateOf("Default") }
    var role by remember { mutableStateOf("无") }
    var plan by remember { mutableStateOf(false) }
    var fast by remember { mutableStateOf(true) }
    fun options(values: List<String>, current: String) = values.map { PickerOption(it, it, it == current) }
    ModalBottomSheet(
        onDismissRequest = close,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = LodyTheme.colors.bgBase,
    ) {
        app.lody.android.create.RunConfigSheet(
            rows = listOf(
                RunConfigRow("role", "角色", options(listOf("无", "代码审阅"), role)),
                RunConfigRow("agent", "Agent", listOf(PickerOption("codex", "Codex", true, agent = "builtin" to "codex")), locked = true),
                RunConfigRow("model", "模型", options(listOf("6 Astra", "6.1 Sol"), model)),
                RunConfigRow("effort", "思考强度", options(listOf("Low", "Medium", "High"), effort)),
                RunConfigRow("mode", "模式", options(listOf("Default", "Auto", "Read only"), mode)),
                RunConfigRow("plan", "计划模式", emptyList(), toggle = plan),
                RunConfigRow("fast", "快速模式", emptyList(), toggle = fast),
            ),
            defaultLabel = "默认",
            onPick = { field, value -> when (field) {
                "role" -> role = value
                "model" -> model = value
                "effort" -> effort = value
                "mode" -> mode = value
                "plan" -> plan = value == "on"
                "fast" -> fast = value == "on"
            } },
        )
    }
}
