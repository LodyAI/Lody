# Generative UI

Status: draft
Translation: current

[English](generative-ui.md)

Agent 用声明式的、有状态的 UI 嵌入 Markdown 来回答，超越了 `html render` 能提供的：
组件是 Lody 自己的，状态属于宿主，模型从不投递可执行的 web 代码。

## 场景

一个 assistant turn 想展示一个过滤列表的滑杆、一个改变推荐的开关，或一个复制结果的
按钮。把原始 HTML 写进回答是兜底手段：它什么都做得了——包括宿主从未同意的事——而且
它把 web chrome 渲染进了一个原生对话里。生成式路径则让模型发射一棵受限的组件树，
交互状态由宿主持有，用 `@lody/ui` 基元在当前主题下渲染。

## 职责

- **Surface 来源**：assistant Markdown 里的一个 ```` ```genui ```` 围栏块。块内是
  JSX 子集标记加上 `{@state}` 指令。一个已写完的围栏会挂载为活的 surface；仍在流式
  输出中的围栏走容错的部分编译挂载：元素在其开标签闭合时出现，子节点流入开元素中，
  被截断的尾部在屏外等待——只有闭合的构造才会落地。
- **内联标签**：叶子目录标签（`GENUI_INLINE_TAGS`，目前是 `Icon` 和 `Badge`）也可以
  直接出现在普通 Markdown 里——句子中或表格单元格里——形如 `<Icon ... />` 或
  `<Badge ...>text</Badge>`。只允许字面量 prop 和纯文本子节点；表达式、事件、嵌套
  标记或不在允许名单里的标签会让这段标记保持为纯文本。一个 remark pass
  （`remarkGenuiInline`）把符合条件的节点改写进同一套 `GENUI_CATALOG` 渲染器，标签
  只在闭合时提交，所以流式写了一半的标签永远不会挂载。
- **`@lody/genui`（packages/genui）**：与框架无关的运行时——指令切分、用
  acorn/acorn-jsx 解析成 `UiNode` 树、一个受限的解释器处理 `{expr}` 插值和回调，
  以及 `SurfaceState`，一个版本化的宿主持有的状态存储。没有 React，没有 DOM。
  `compileSurfacePartial` 是流式对应的入口：已提交的指令和节点照常编译，被截断的
  尾部作为 `pending` 返回，不产生诊断。
- **React 适配器**（`components/ai-gui/genui/`）：`GenuiSurface` 编译源码、跨重挂载
  持有每个 surface 的状态、在每次提交的状态写入后重新求值表达式，并通过
  `GENUI_CATALOG` 把标签映射到 @lody/ui 组件。只有已提交的节点到达 DOM：未提交的
  流式尾部被扣住，不会以原始标记的形式展示。
- **目录（catalog）**：模型可用的完整标签清单。未知标签渲染为诊断，不进 DOM。
  其中 SVG 族（`svg`、基础图形、`svg:text`）只放行一份固定的属性白名单——仅几何
  与绘制属性；资源引用、脚本、内嵌 HTML 与事件都没有到达 DOM 的路径。
- **目录下发**：模型通过渐进披露学习这套 DSL——一个紧凑索引（每个标签一行：用途
  和关键 prop）始终在上下文里，完整的 prop 表和示例放在按组件族分开的参考文档里，
  模型只为它实际使用的组件族去读这些文档。skill 和参考文件位于
  `apps/cli/src/mcp/skills/genui/`，通过 Lody MCP server 的 skills 扩展
  （`skill://genui/SKILL.md`）送达 agent。下发是静态的、不做运行时协商：目录随
  Lody 自己的 prompt/skill 文档一起发布，所以模型看到的 DSL 与渲染它的发布版本
  绑定——没有按请求的注入、不破坏 prompt 缓存、也不会在"模型可以发射什么"和"宿主
  接受什么"之间产生版本漂移。

## 线路格式

```genui
{@state const [value, setValue] = useState(65)}
{@state const [enabled, setEnabled] = useState(true)}
<Card>
  <Heading level={4}>Progress</Heading>
  <Slider value={value} min={0} max={100} disabled={!enabled} onChange={(n) => setValue(n)} />
  <Checkbox checked={enabled} onCheckedChange={setEnabled} />
  <Button onClick={() => setValue(65)}>Reset</Button>
</Card>
```

- `{@state}` 体只接受 `const [name, setName] = useState(init)` 声明；状态在顶层
  声明，绝不出现在标记或回调里。
- 表达式是被限制的 JavaScript：字面量、算术、三元、模板字符串、箭头函数、对可达值
  的成员访问/调用，以及常见的数组回调方法。没有环境全局变量、没有 `import`、没有
  async、没有 `eval`，`__proto__`/`prototype`/`constructor` 访问被拒绝。求值在步数
  和调用深度预算内运行。
- 事件 prop 是求值结果为函数的普通表达式；宿主能力在 `lody` 命名空间下到达
  （例如 `lody.copy(...)`），这是 surface 唯一的对外桥梁。能力集合是静态的：一份
  固定在 skill 里文档化、由同一 Lody 发布版本绑定的清单，绝不按 surface 或按请求
  协商——调用一个不在清单里的成员会像其他目录违规一样产生诊断。

## 保证

- 状态槽位按 `surfaceId` 寻址——流式期间是围栏在文档中的偏移——所以重渲染或被修订
  的 surface 保留已提交的用户输入；重新声明的槽位保留它的值——初始化只跑一次。
- 任何失败——解析不了的标记、坏指令、求值错误、未知标签——都会降级，绝不出抛异常
  的渲染或半个 DOM。完全无法挂载的 surface 回退成它自己的围栏代码块：解析诊断
  面向模型（下面的错误反馈回路），绝不面向读者。
- 目录就是契约：目录之外的东西到不了 DOM、网络或宿主 API。

## 未决问题

- 是否把 surface 状态持久化进 session 文档（Loro），让状态在重启后存活，还是只保留
  session 级的内存。
- 是否需要修订补丁（agent 更新一个已挂载的 surface 而不是追加）——前缀流式可以挂载
  新节点，但没有协议去编辑一棵已提交的树。
- `Slider` 基元应属于 `@lody/ui`；目录目前用一个加了样式的原生 range input。
- `lody.*` 能力：第一份清单发布 `sendPrompt(text)`，它在会话的普通发送路径上提交
  一条用户消息（queue/guide/dispatch 路由，与输入框一致）。后续成员（打开文件、
  复制）会扩展同一份静态清单。
- 错误反馈回路：surface 诊断面向模型，但还没有回报给 agent，所以被拒绝的 surface
  目前无法触发"描述并重试"的修复。

## 证据

- 运行时：`packages/genui/src/`（`directives.ts`、`jsx.ts`、`jsx-partial.ts`、
  `evaluate.ts`、`state.ts`、`surface.ts`）；测试在
  `packages/genui/test/genui.test.ts`。
- React 适配器：`packages/components/src/components/ai-gui/genui/`。
- 内联分发：`remark-genui-inline.ts` 加 `markdown-renderer.tsx`
  `createMarkdownComponents` 里的 `genui-inline` 入口；测试在
  `remark-genui-inline.test.ts`。
- 围栏分发：`markdown-renderer.tsx` `MarkdownPre`（`genui` 语言）。
- 创作契约：`apps/cli/src/mcp/skills/genui/`（索引加按族参考文档，作为 `genui`
  skill 经 Lody MCP 提供）。
