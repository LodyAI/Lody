/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Disabled during swift-format 6.3 rollout, feel free to remove:
// swift-format-ignore-file: OrderedImports

import UIKit

/**
 Used to initialize an Editor with a Theme and some Plugins.

 Note that you shouldn't use an EditorConfig to initialize multiple Editors, because each instantiated ``Plugin`` maintains state
 about the editor it is attached to. In the future we will hopefully improve this API, possibly replacing the Plugins array
 with a closure to build new Plugin objects, which would let us remove this restriction.
 */
@objc public final class EditorConfig: NSObject {
  let theme: Theme
  let plugins: [Plugin]

  @objc public init(theme: Theme, plugins: [Plugin]) {
    self.theme = theme
    self.plugins = plugins
  }
}

internal enum DecoratorCacheItem {
  case needsCreation
  case cachedView(UIView)
  case unmountedCachedView(UIView)
  case needsDecorating(UIView)

  var view: UIView? {
    switch self {
    case .needsCreation:
      return nil
    case .cachedView(let aView):
      return aView
    case .unmountedCachedView(let aView):
      return aView
    case .needsDecorating(let aView):
      return aView
    }
  }
}

/// Editor instances are the core thing that wires everything together.
///
/// The Editor is your entry point to everything Lexical can do. In order to make any changes to
/// an ``EditorState`` (aka Lexical's data model), you must go through the Editor's ``update(_:)`` method.
public final class Editor: NSObject {
  internal static var maxUpdateCount = 99

  private var editorState: EditorState
  private var pendingEditorState: EditorState?
  private var theme: Theme

  internal var textStorage: TextStorage? {
    frontend?.textStorage
  }

  internal weak var frontend: Frontend? {
    didSet {
      if pendingEditorState != nil {
        if let textStorage {
          textStorage.mode = .controllerMode
          textStorage.replaceCharacters(in: NSRange(location: 0, length: textStorage.string.lengthAsNSString()), with: "")
          textStorage.mode = .none
        }
        try? update {}
      }
    }
  }

  internal var infiniteUpdateLoopCount = 0
  // keyCounter is the next available node key to be used.
  internal var keyCounter: Int = 0

  // Transforms are defined as functions that operate on nodes. In the JS code, functions are
  // equatable but Swift for a variety of reasons does not support this. To keep track of transforms
  // we assign them an ID as they are inserted.
  internal var transformCounter: Int = 0
  internal var isRecoveringFromError: Bool = false

  // See description in RangeCache.swift.
  internal var rangeCache: [NodeKey: RangeCacheItem] = [:]
  internal var dirtyNodes: DirtyNodeMap = [:]
  internal var cloneNotNeeded: Set<NodeKey> = Set()
  internal var normalizedNodes: Set<NodeKey> = Set()

  // Used for deserialization and registration of nodes. Lexical's built-in nodes are registered
  // by default.
  public var registeredNodeTypes: [NodeType: Node.Type] { registeredNodes }

  internal var registeredNodes: [NodeType: Node.Type] = [.root: RootNode.self, .text: TextNode.self, .element: ElementNode.self, .heading: HeadingNode.self, .paragraph: ParagraphNode.self, .quote: QuoteNode.self, .linebreak: LineBreakNode.self, .tab: TabNode.self, .code: CodeNode.self, .codeHighlight: CodeHighlightNode.self]

  internal var nodeTransforms: [NodeType: [(Int, NodeTransform)]] = [:]

  // Used to help co-ordinate selection and events
  internal var compositionKey: NodeKey?
  public var dirtyType: DirtyType = .noDirtyNodes // TODO: I made this public to work around an issue in playground. @amyworrall
  internal var featureFlags: FeatureFlags = FeatureFlags()

  // Used for storing editor listener events
  internal var listeners = Listeners()

  // Used for storing and dispatching command listeners
  internal var commands: Commands = [:]

  internal var plugins: [Plugin]

  // Used to cache decorators
  internal var decoratorCache: [NodeKey: DecoratorCacheItem] = [:]

  // Headless mode runs without the reconciler
  private var headless: Bool = false

  // Parent editors are used for nested editors inside decorator nodes
  public weak var parentEditor: Editor?

  // MARK: - Initialisation

  /// Initialises a new Editor.
  /// - Parameter editorConfig: Settable options for the editor, including a Theme and Plugins.
  ///
  /// You will usually not need to directly init an Editor; instead you will create a TextView
  /// which will initialise the Editor for you.
  public init(editorConfig: EditorConfig) {
    editorState = EditorState()
    guard let rootNodeKey = editorState.getRootNode()?.key else {
      fatalError("Expected root node key when creating new editor state")
    }
    rangeCache[rootNodeKey] = RangeCacheItem()
    theme = editorConfig.theme
    plugins = editorConfig.plugins
    super.init()
    initializePlugins(plugins)

    // registering custom drawing for built in nodes
    try? registerCustomDrawing(customAttribute: .inlineCodeBackgroundColor, layer: .background, granularity: .characterRuns, handler: TextNode.inlineCodeBackgroundDrawing)
    try? registerCustomDrawing(customAttribute: .codeBlockCustomDrawing, layer: .background, granularity: .contiguousParagraphs, handler: CodeNode.codeBlockBackgroundDrawing)
    try? registerCustomDrawing(customAttribute: .quoteCustomDrawing, layer: .background, granularity: .contiguousParagraphs, handler: QuoteNode.quoteBackgroundDrawing)

    resetEditor()
  }

  convenience init(featureFlags: FeatureFlags, editorConfig: EditorConfig) {
    self.init(editorConfig: editorConfig)
    self.featureFlags = featureFlags
  }

  /// This method is only used for testing purposes
  override convenience init() {
    self.init(editorConfig: EditorConfig(theme: Theme(), plugins: []))
  }

  /**
   Create a new editor in Headless mode.

   Headless mode is a version of Lexical that does not reconcile or produce output. It is
   useful for quickly manipulating a Lexical data model.
   */
  public static func createHeadless(editorConfig: EditorConfig) -> Editor {
    let editor = Editor(editorConfig: editorConfig)
    editor.headless = true
    return editor
  }

  private func initializePlugins(_ plugins: [Plugin]) {
    plugins.forEach { plugin in
      plugin.setUp(editor: self)
    }
  }

  deinit {
    plugins.forEach { plugin in
      plugin.tearDown()
    }
  }

  // MARK: - Accessing editor state

  /// Allows you to make changes to the EditorState.
  /// - Parameter closure: Code to run in order to modify the editor state.
  /// Functions that work with nodes or selections can only be used inside a read or update closure.
  ///
  /// The `update()` function is the primary way you make proactive changes to a Lexical ``EditorState``.
  ///
  /// Once your update closure has run, the Reconciler will be run. This will apply mutations to the
  /// text view to make it track the changes you have just made. (Note that if update calls are nested,
  /// the reconciler will run once the outer-most update closure returns.)
  ///
  /// > Important: Your code within the `update()` closure must run synchronously on the thread that
  /// Lexical calls it on. Do not dispatch to another thread!
  public func update(_ closure: () throws -> Void) throws {
    try beginUpdate(closure, mode: UpdateBehaviourModificationMode())
  }

  /// Convenience function to read the Editor's current EditorState.
  /// - Parameter closure: Inside this closure you can call functions that read (but not mutate) nodes.
  ///
  /// This function is syntactic sugar over calling ``getEditorState()`` then ``EditorState/read(closure:)``.
  /// Note if you want to return a value, using the function directly on the ``EditorState`` is better.
  public func read(_ closure: () throws -> Void) throws {
    try beginRead(closure)
  }

  /// Returns the current editor state.
  /// - Returns: The editor state.
  ///
  /// > Note: If there is a pending ``EditorState`` (i.e. you're in the middle of an update block and
  /// have mutated the EditorState), this function ignores the pending EditorState and returns the
  /// active (old) EditorState.
  @objc public func getEditorState() -> EditorState {
    editorState
  }

  //  /// Returns the TextView attached to this Editor.
  //  /// - Returns: the TextView
  //  func getTextView() -> TextView? {
  //    textView
  //  }

  // MARK: - Registration

  public typealias RemovalHandler = () -> Void

  public func registerErrorListener(listener: @escaping ErrorListener) -> RemovalHandler {
    let uuid = UUID()

    listeners.errors[uuid] = listener

    return { [weak self] in
      guard let self else { return }
      self.listeners.update.removeValue(forKey: uuid)
    }
  }

  /// Registers a closure to be run whenever the ``EditorState`` changes.
  /// - Parameter listener: The code to run when the ``EditorState`` changes.
  /// - Returns: A closure to remove the update listener
  public func registerUpdateListener(listener: @escaping UpdateListener) -> RemovalHandler {
    let uuid = UUID()
    listeners.update[uuid] = listener
    return { [weak self] in
      guard let self else { return }
      self.listeners.update.removeValue(forKey: uuid)
    }
  }

  /// Registers a closure to be run whenever the reconciled text content changes.
  /// - Parameter listener: The code to run when the text content changes
  /// - Returns: A closure to remove the text content listener
  public func registerTextContentListener(listener: @escaping TextContentListener) -> RemovalHandler {
    let uuid = UUID()

    listeners.textContent[uuid] = listener

    return { [weak self] in
      guard let self else { return }
      self.listeners.textContent.removeValue(forKey: uuid)
    }
  }

  /// Registers a handler to be called whenever a certain command is dispatched.
  /// - Parameters:
  ///   - type: The command you want to listen for. (This can be a built in command or a custom one added by your plugin.)
  ///   - listener: The code to run when the command is dispatched.
  ///   - priority: The priority for your handler. Higher priority handlers run before lower priority handlers.
  /// - Returns: A closure to remove the command handler.
  public func registerCommand(type: CommandType, listener: @escaping CommandListener, priority: CommandPriority = CommandPriority.Editor, shouldWrapInUpdateBlock: Bool = true) -> RemovalHandler {
    let uuid = UUID()

    if commands[type] == nil {
      commands.updateValue(
        [
          CommandPriority.Editor: [:],
          CommandPriority.Low: [:],
          CommandPriority.Normal: [:],
          CommandPriority.High: [:],
          CommandPriority.Critical: [:],
        ],
        forKey: type
      )
    }

    let wrapper = CommandListenerWithMetadata(listener: listener, shouldWrapInUpdateBlock: shouldWrapInUpdateBlock)

    commands[type]?[priority]?[uuid] = wrapper

    return { [weak self] in
      guard let self else { return }

      self.commands[type]?[priority]?.removeValue(forKey: uuid)
    }
  }

  /// Registers a new Node subclass
  /// - Parameters:
  ///   - nodeType: The type (name) of your node
  ///   - constructor: A constructor to deserialise your node from JSON.
  ///
  ///   Node subclasses must be registered before use, in order that Lexical knows how to serialise them etc.
  public func registerNode(nodeType: NodeType, class klass: Node.Type) throws {
    if self.registeredNodes[nodeType] != nil {
      throw LexicalError.invariantViolation("Node type \(nodeType) already registered")
    }

    registeredNodes[nodeType] = klass
  }

  public func getRegisteredNodes() -> [NodeType: Node.Type] {
    return registeredNodes
  }

  internal struct CustomDrawingHandlerInfo {
    let customDrawingHandler: CustomDrawingHandler
    let granularity: CustomDrawingGranularity
  }

  internal var customDrawingBackground: [NSAttributedString.Key: CustomDrawingHandlerInfo] = [:]
  internal var customDrawingText: [NSAttributedString.Key: CustomDrawingHandlerInfo] = [:]

  public func registerCustomDrawing(customAttribute: NSAttributedString.Key, layer: CustomDrawingLayer, granularity: CustomDrawingGranularity, handler: @escaping CustomDrawingHandler) throws {
    switch layer {
    case .text:
      customDrawingText[customAttribute] = CustomDrawingHandlerInfo(customDrawingHandler: handler, granularity: granularity)
    case .background:
      customDrawingBackground[customAttribute] = CustomDrawingHandlerInfo(customDrawingHandler: handler, granularity: granularity)
    }
  }

  // MARK: - Other public API

  /// Dispatches a command, running its handlers.
  /// - Parameters:
  ///   - type: The command type (name).
  ///   - payload: The payload required by this command. Some commands may not require a payload.
  /// - Returns: true if the handler should intercept the command (i.e. stop running other handlers); false if other handlers should run.
  @discardableResult
  public func dispatchCommand(type: CommandType, payload: Any? = nil) -> Bool {
    return triggerCommandListeners(activeEditor: self, type: type, payload: payload)
  }

  /// Clears the editor and replaces the current EditorState with a new EditorState
  /// - Parameters:
  ///   - editor: The editor to clear
  ///   - pendingEditorState: A new pending EditorState to replace whatever is already there.
  @objc public func resetEditor(pendingEditorState newEditorState: EditorState? = nil) {

    cloneNotNeeded.removeAll()
    dirtyType = (pendingEditorState != nil) ? .fullReconcile : .noDirtyNodes
    dirtyNodes = [:]
    if let newEditorState, let pendingEditorState {
      pendingEditorState.nodeMap = newEditorState.nodeMap
      pendingEditorState.selection = newEditorState.selection
    } else if let newEditorState {
      pendingEditorState = newEditorState
    } else {
      pendingEditorState = nil
    }
    compositionKey = nil
    editorState = EditorState()

    rangeCache = [:]
    rangeCache[kRootNodeKey] = RangeCacheItem()

    if let textStorage = frontend?.textStorage {
      let oldMode = textStorage.mode
      textStorage.mode = .controllerMode
      textStorage.setAttributedString(NSAttributedString(string: ""))
      textStorage.mode = oldMode
    }

    for (key, value) in decoratorCache {
      switch value {
      case .cachedView(let view):
        view.removeFromSuperview()
      case .unmountedCachedView(let view):
        view.removeFromSuperview()
      case .needsDecorating(let view):
        view.removeFromSuperview()
      case .needsCreation:
        break
      }
      decoratorCache.removeValue(forKey: key)
    }

    if let pendingEditorState {
      for (_, node) in pendingEditorState.nodeMap {
        node.didMoveTo(newEditor: self)
      }
      try? updateWithCustomBehaviour(mode: UpdateBehaviourModificationMode(suppressReconcilingSelection: false, suppressSanityCheck: true, markedTextOperation: nil, skipTransforms: true, allowUpdateWithoutTextStorage: false)) {}
    } else {
      // create a default paragraph node here
      try? updateWithCustomBehaviour(mode: UpdateBehaviourModificationMode(suppressReconcilingSelection: true, suppressSanityCheck: true, markedTextOperation: nil, skipTransforms: true, allowUpdateWithoutTextStorage: true)) {
        guard let root = getRoot() else { return }
        if root.getFirstChild() == nil {
          let paragraph = createParagraphNode()
          try root.append([paragraph])
          let selection = try getSelection()
          if selection != nil {
            try paragraph.select(anchorOffset: nil, focusOffset: nil)
            if let selection = selection as? RangeSelection {
              selection.clearFormat()
            }
          }
        }
      }
    }
    frontend?.showPlaceholderText()
  }

  internal func resetReconciler(pendingEditorState: EditorState) {
    resetEditor(pendingEditorState: pendingEditorState)
  }

  /// Returns the current theme
  /// - Returns: The theme that was passed in when this Editor was created.
  public func getTheme() -> Theme {
    theme
  }

  /// Returns if the user is currently entering multi-stage character input
  /// - Returns: true if the user is currently entering multi-stage character input (aka Marked Text, aka Composition)
  public func isComposing() -> Bool {
    return compositionKey != nil
  }

  public func isTextViewEmpty() -> Bool {
    return frontend?.isEmpty ?? true
  }

  public func clearEditor() throws {
    resetEditor(pendingEditorState: nil)
    dispatchCommand(type: .clearEditor)
  }

  // MARK: - Selection

  internal func getNativeSelection() -> NativeSelection {
    return frontend?.nativeSelection ?? NativeSelection()
  }

  internal func moveNativeSelection(type: NativeSelectionModificationType, direction: UITextStorageDirection, granularity: UITextGranularity) {
    frontend?.moveNativeSelection(type: type, direction: direction, granularity: granularity)
  }

  // MARK: - Internal

  public func setEditorState(_ newEditorState: EditorState) throws {
    // If we already have a pending editor state, modify that one. Otherwise, if we're inside an update block, the previous pending editor state
    // will remain attached to the thread as activeEditorState, and things like getLatest won't work right.
    if let pendingEditorState {
      pendingEditorState.nodeMap = newEditorState.nodeMap
      pendingEditorState.selection = newEditorState.selection
    } else {
      pendingEditorState = newEditorState
    }

    dirtyType = .fullReconcile
    cloneNotNeeded = Set()
    if compositionKey != nil {
      if let frontend, frontend.isFirstResponder {
        frontend.unmarkTextWithoutUpdate()
      }
      compositionKey = nil
    }

    try beginUpdate({}, mode: UpdateBehaviourModificationMode())
  }

  internal func testing_getPendingEditorState() -> EditorState? {
    pendingEditorState
  }

  internal func focus(callbackFn: (() -> Void)?) throws {
    try update {
      let selection = try getSelection()
      guard let rootNode = getRoot() else { return }

      if let selection {
        // Marking the selection dirty will force the selection back to it
        selection.dirty = true
      } else if !rootNode.children.isEmpty {
        try rootNode.selectEnd()
      }
    }
  }

  // MARK: - Decorators

  internal func frontendDidUnattachView() {
    self.log(.editor, .verbose)
    unmountDecoratorSubviewsIfNecessary()
  }

  internal func frontendDidAttachView() {
    self.log(.editor, .verbose)
    mountDecoratorSubviewsIfNecessary()
  }

  var isMounting = false
  internal func mountDecoratorSubviewsIfNecessary() {
    if isMounting {
      return
    }
    isMounting = true
    defer {
      isMounting = false
    }

    guard let superview = frontend?.viewForDecoratorSubviews else {
      self.log(.editor, .verbose, "No view for mounting decorator subviews.")
      return
    }
    try? self.read {
      for (nodeKey, decoratorCacheItem) in decoratorCache {
        switch decoratorCacheItem {
        case .needsCreation:
          guard let view = decoratorView(forKey: nodeKey, createIfNecessary: true), let node = getNodeByKey(key: nodeKey) as? DecoratorNode else {
            break
          }
          view.isHidden = true // decorators will be hidden until they are layed out by TextKit
          superview.addSubview(view)
          node.decoratorWillAppear(view: view)
          decoratorCache[nodeKey] = .cachedView(view)
          self.log(.editor, .verbose, "needsCreation -> cached. Key \(nodeKey). Frame \(view.frame). Superview \(String(describing: view.superview))")
        case .cachedView(let view):
          // This shouldn't be needed if our appear/disappear logic is perfect, but it turns out we do currently need this.
          superview.addSubview(view)
          self.log(.editor, .verbose, "no-op, already cached. Key \(nodeKey). Frame \(view.frame). Superview \(String(describing: view.superview))")
        case .unmountedCachedView(let view):
          view.isHidden = true // decorators will be hidden until they are layed out by TextKit
          superview.addSubview(view)
          if let node = getNodeByKey(key: nodeKey) as? DecoratorNode {
            node.decoratorWillAppear(view: view)
          }
          decoratorCache[nodeKey] = .cachedView(view)
          self.log(.editor, .verbose, "unmounted -> cached. Key \(nodeKey). Frame \(view.frame). Superview \(String(describing: view.superview))")
        case .needsDecorating(let view):
          superview.addSubview(view)
          decoratorCache[nodeKey] = .cachedView(view)
          if let node = getNodeByKey(key: nodeKey) as? DecoratorNode {
            node.decorate(view: view)
          }
          if let rangeCacheItem = rangeCache[nodeKey] {
            // required so that TextKit does the new size calculation, and correctly hides or unhides the view
            frontend?.invalidateLayout(forCharacterRange: rangeCacheItem.range)
          }
        }
      }
    }
  }

  internal func unmountDecoratorSubviewsIfNecessary() {
    try? self.read {
      for (nodeKey, decoratorCacheItem) in decoratorCache {
        switch decoratorCacheItem {
        case .needsCreation:
          break
        case .cachedView(let view):
          view.removeFromSuperview()
          if let node = getNodeByKey(key: nodeKey) as? DecoratorNode {
            node.decoratorDidDisappear(view: view)
            decoratorCache[nodeKey] = .unmountedCachedView(view)
          } else {
            decoratorCache[nodeKey] = nil
          }
        case .unmountedCachedView:
          break
        case .needsDecorating(let view):
          view.removeFromSuperview()
          if let node = getNodeByKey(key: nodeKey) as? DecoratorNode {
            node.decoratorDidDisappear(view: view)
            decoratorCache[nodeKey] = .unmountedCachedView(view)
          } else {
            decoratorCache[nodeKey] = nil
          }
        }
      }
    }
  }

  // MARK: - Manipulating the editor state

  var isUpdating = false
  private func beginUpdate(_ closure: () throws -> Void, mode: UpdateBehaviourModificationMode) throws {
    var editorStateWasCloned = false

    if pendingEditorState == nil {
      pendingEditorState = EditorState(editorState)
      editorStateWasCloned = true
    }

    if infiniteUpdateLoopCount > Editor.maxUpdateCount {
      throw LexicalError.invariantViolation("Maximum update loop met")
    }

    defer {
      infiniteUpdateLoopCount = 0
      isRecoveringFromError = false
    }

    guard let pendingEditorState else {
      return
    }

    let isInsideNestedEditorBlock = (isEditorPresentInUpdateStack(self))
    let previousEditorStateForListeners = editorState
    var dirtyNodesForListeners = dirtyNodes

    try runWithStateLexicalScopeProperties(activeEditor: self, activeEditorState: pendingEditorState, readOnlyMode: false) {
      let previouslyUpdating = self.isUpdating
      self.isUpdating = true

      if editorStateWasCloned {
        pendingEditorState.selection = try createSelection(editor: self)
      }

      do {
        try closure()

        // Need to do this here, in case pendingEditorState was replaced or manipulated inside the closure.
        guard let pendingEditorState = self.pendingEditorState else {
          self.isUpdating = previouslyUpdating
          return
        }

        if isInsideNestedEditorBlock {
          self.isUpdating = previouslyUpdating
          return
        }

        if dirtyType != .noDirtyNodes {
          try normalizeAllDirtyTextNodes(editorState: pendingEditorState)

          if !mode.skipTransforms {
            try applyAllTransforms()
          }
        }

        if mode.allowUpdateWithoutTextStorage && textStorage == nil {
          // we want to leave the pending editor state as pending here; it will be reconciled when a text storage is attached
          self.isUpdating = previouslyUpdating
          return
        }

        if !headless {
          try Reconciler.updateEditorState(currentEditorState: editorState, pendingEditorState: pendingEditorState, editor: self, shouldReconcileSelection: !mode.suppressReconcilingSelection, markedTextOperation: mode.markedTextOperation)
        }
        self.isUpdating = previouslyUpdating
        garbageCollectDetachedNodes(prevEditorState: editorState, editorState: pendingEditorState, dirtyLeaves: dirtyNodes)
      } catch {
        triggerErrorListeners(
          activeEditor: self,
          activeEditorState: pendingEditorState,
          previousEditorState: editorState,
          error: error)
        isRecoveringFromError = true
        resetEditor(pendingEditorState: editorState)
        try beginUpdate({}, mode: UpdateBehaviourModificationMode())
        self.isUpdating = previouslyUpdating
        return
      }

      if let pendingSelection = pendingEditorState.selection as? RangeSelection {
        let anchor = pendingEditorState.nodeMap[pendingSelection.anchor.key]
        let focus = pendingEditorState.nodeMap[pendingSelection.focus.key]
        if anchor == nil || focus == nil {
          let errorString =
            """
            updateEditor: selection has been lost because the previously selected nodes have been removed and
            selection wasn't moved to another node. Ensure selection changes after removing/replacing a selected node.
            """
          throw LexicalError.invariantViolation(errorString)
        }
      } else if let pendingSelection = pendingEditorState.selection as? NodeSelection {
        if pendingSelection.nodes.isEmpty {
          pendingEditorState.selection = nil
        }
      }

      editorState = pendingEditorState
      self.pendingEditorState = nil
      dirtyNodesForListeners = dirtyNodes
      dirtyNodes.removeAll()
      dirtyType = .noDirtyNodes
      cloneNotNeeded.removeAll()

      mountDecoratorSubviewsIfNecessary()
    }

    if isInsideNestedEditorBlock {
      return
    }

    // These have to be outside of the above runWithStateLexicalScopeProperties{} closure, because: if any update block is triggered from inside that
    // closure, it counts as a nested update. But listeners, which happen after we've run the reconciler, should not count as nested for this purpose;
    // if an update is triggered from within an update listener, it needs to run the reconciler a second time.
    try runWithStateLexicalScopeProperties(activeEditor: self, activeEditorState: pendingEditorState, readOnlyMode: true) {
      triggerUpdateListeners(activeEditor: self, activeEditorState: pendingEditorState, previousEditorState: previousEditorStateForListeners, dirtyNodes: dirtyNodesForListeners)
      try triggerTextContentListeners(activeEditor: self, activeEditorState: pendingEditorState, previousEditorState: previousEditorStateForListeners)
    }

    frontend?.isUpdatingNativeSelection = false

    if featureFlags.reconcilerSanityCheck && !mode.suppressSanityCheck && compositionKey == nil, let frontend {
      do {
        try performReconcilerSanityCheck(editor: self, expectedOutput: frontend.textStorage)
      } catch LexicalError.sanityCheck(errorMessage: let errorMessage, textViewText: let textViewText, fullReconcileText: let fullReconcileText) {
        frontend.presentDeveloperFacingError(message: "\(errorMessage)\n\nIn text view:\n```\n\(textViewText)\n```\n\nFull reconcile:\n```\n\(fullReconcileText)\n```")
        if !isRecoveringFromError {
          isRecoveringFromError = true
          resetReconciler(pendingEditorState: pendingEditorState)
          try beginUpdate({}, mode: UpdateBehaviourModificationMode())
        } else {
          fatalError("Unreconcileable text entered into editor")
        }
      }
    }
  }

  private func beginRead(_ closure: () throws -> Void) throws {
    try runWithStateLexicalScopeProperties(activeEditor: self, activeEditorState: getActiveEditorState() ?? editorState, readOnlyMode: true, closure: closure)
  }

  // There are some cases (mainly related to non-controlled mode and/or UIKit's selection handling) where we
  // want to run an update but not to do everything that is done within an update block. This is definitely for
  // internal Lexical use only, and should only be done if safety can be guaranteed, i.e. the caller of
  // such an update must guarantee that the EditorState will not be left in an inconsistent state when they are finished.
  internal func updateWithCustomBehaviour(mode: UpdateBehaviourModificationMode, _ closure: () throws -> Void) throws {
    try beginUpdate(closure, mode: mode)
  }

  internal func normalizeAllDirtyTextNodes(editorState: EditorState) throws {
    guard let activeEditorState = getActiveEditorState() else {
      throw LexicalError.invariantViolation("Cannot normalize nodes without an active editor state")
    }

    for (nodeKey, _) in dirtyNodes {
      guard let node = editorState.nodeMap[nodeKey], isTextNode(node) else {
        continue
      }

      guard activeEditorState.nodeMap[nodeKey] != nil else {
        throw LexicalError.invariantViolation("TextNode \(nodeKey) was not in active editor state during text normalization")
      }

      if let textNode = node as? TextNode, textNode.isSimpleText() && !textNode.isUnmergeable() {
        try TextNode.normalizeTextNode(textNode: textNode)
      }
    }
  }

  internal func applyAllTransforms() throws {
    guard let editorState = getActiveEditorState(), let rootNode = editorState.getRootNode() else {
      throw LexicalError.invariantViolation(
        "Attempted to apply transforms on unmounted tree or outside an active editor")
    }

    // This code needs to be a little different from the web version. We do not explicitly
    // track the difference between leaf and element nodes by key, so our code is different.
    //
    // The two main differences are:
    //   1. While we prioritize doing child transforms first, child nodes that generate element nodes
    //      are not processed until the the next round of transforms are performed.
    //   2. As a result, the two loops in the web reference are collapsed and so the need for
    //      many of the utility methods are as well. Some temporaries that were necessary
    //      no longer are. Structurally, the code is different but the effect should be the same,
    //      though we are less tolerant of deeply nested transform loops as a result.

    // Due to our sorting scheme, this sentinel value is needed to ensure that leaf nodes always
    // take priority over element nodes (even if that element node has no children.)
    let isLeafNodeSigil = -1
    var nodeChildrenCounts = [NodeKey: Int]()

    let originalDirtyNodes = dirtyNodes

    while !dirtyNodes.isEmpty {
      if infiniteUpdateLoopCount >= Editor.maxUpdateCount {
        throw LexicalError.invariantViolation("Update loop exceeded maximum of \(Editor.maxUpdateCount)")
      }

      let nodesToProcess = dirtyNodes.keys
        .filter { dirtyNodes[$0] == .userInitiated }
        .sorted { leftNodeKey, rightNodeKey in
          let leftNodeChildCount: Int
          let rightNodeChildCount: Int

          // To try to avoid many failed casts we try to keep a hash lookup of the child count
          if let count = nodeChildrenCounts[leftNodeKey] {
            leftNodeChildCount = count
          } else if let leftNode = getNodeByKey(key: leftNodeKey) as? ElementNode {
            leftNodeChildCount = leftNode.getChildrenSize()
          } else {
            leftNodeChildCount = isLeafNodeSigil
          }

          if let count = nodeChildrenCounts[rightNodeKey] {
            rightNodeChildCount = count
          } else if let leftNode = getNodeByKey(key: rightNodeKey) as? ElementNode {
            rightNodeChildCount = leftNode.getChildrenSize()
          } else {
            rightNodeChildCount = isLeafNodeSigil
          }

          nodeChildrenCounts[leftNodeKey] = leftNodeChildCount
          nodeChildrenCounts[rightNodeKey] = rightNodeChildCount

          return leftNodeChildCount < rightNodeChildCount
        }

      dirtyNodes.removeAll(keepingCapacity: true)

      for nodeKey in nodesToProcess where nodeKey != compositionKey && nodeKey != rootNode.key {
        guard
          let node = getNodeByKey(key: nodeKey),
          let transforms = nodeTransforms[node.type],
          node.isAttached()
        else {
          continue
        }

        if isTextNode(node) {
          if let textNode = node as? TextNode, textNode.isSimpleText() && !textNode.isUnmergeable() {
            try TextNode.normalizeTextNode(textNode: textNode)
          }
        }

        for (_, transform) in transforms where node.isAttached() {
          try transform(node)
        }
      }

      // As any number of changes may have been made as a result of the transforms, we need to
      // update our lookup as a result.
      nodeChildrenCounts.removeAll()

      infiniteUpdateLoopCount += 1
    }

    dirtyNodes = originalDirtyNodes
  }

  // MARK: Node Transforms

  /// Adds a Transform, allowing you to make changes in response to an EditorState update.
  /// - Parameters:
  ///   - nodeType: The node type you want to listen for changes to
  ///   - transform: Code to run allowing you to further modify the node
  /// - Returns: A closure allowing you to remove the transform.
  ///
  /// Transforms are executed before reconciliation.
  ///
  /// > Important: In most cases, it is possible to achieve the same or very similar result through an update listener
  /// followed by an update. This is highly discouraged as it triggers an additional reconciliation pass. Additionally, each
  /// cycle creates a brand new EditorState object which can interfere with plugins like HistoryPlugin (undo-redo)
  /// if not handled correctly.
  public func addNodeTransform(nodeType: NodeType, transform: @escaping NodeTransform) -> () -> Void {
    // NB: In the web code, closures can be compared for identity but in Swift, closures are
    //     by design not Equatable. Therefore, we generate a tag for each closure passed in
    //     and use that for our removal/cleanup logic.

    transformCounter += 1

    var transforms: [(Int, NodeTransform)]
    let id = transformCounter

    if let existingTransforms = nodeTransforms[nodeType] {
      transforms = existingTransforms
    } else {
      transforms = [(Int, NodeTransform)]()
    }

    transforms.append((id, transform))
    nodeTransforms[nodeType] = transforms

    return { [weak self] in
      guard let self, var transforms = self.nodeTransforms[nodeType] else { return }
      transforms.removeAll(where: { $0.0 == id })
      self.nodeTransforms[nodeType] = transforms
    }
  }

  internal func parseEditorState(json: Data) throws -> EditorState {
    let previousActiveEditorState = self.editorState
    let previousPendingEditorState = self.pendingEditorState
    let previousDirtyNodes = self.dirtyNodes
    let previousDirtyType = self.dirtyType
    let previousRangeCache = self.rangeCache
    let previousCloneNotNeeded = self.cloneNotNeeded
    let previousNormalizedNodes = self.normalizedNodes
    let previousHeadless = self.headless

    let editorState = EditorState()

    self.dirtyNodes = [:]
    self.dirtyType = .noDirtyNodes
    self.cloneNotNeeded = Set()
    self.rangeCache = [kRootNodeKey: RangeCacheItem()]
    self.normalizedNodes = Set()
    self.editorState = editorState
    self.pendingEditorState = nil
    self.headless = true

    defer {
      self.dirtyNodes = previousDirtyNodes
      self.dirtyType = previousDirtyType
      self.cloneNotNeeded = previousCloneNotNeeded
      self.rangeCache = previousRangeCache
      self.normalizedNodes = previousNormalizedNodes
      self.editorState = previousActiveEditorState
      self.pendingEditorState = previousPendingEditorState
      self.headless = previousHeadless
    }

    try self.beginUpdate(
      {
        let serializedEditorState = try JSONDecoder().decode(SerializedEditorState.self, from: json)

        guard let serializedRootNode = serializedEditorState.rootNode, let rootNode = getRoot() else {
          throw LexicalError.internal("Failed to decode RootNode")
        }

        try rootNode.append(serializedRootNode.getChildren())
        try rootNode.setDirection(direction: serializedRootNode.direction)
      }, mode: UpdateBehaviourModificationMode(suppressReconcilingSelection: true, suppressSanityCheck: true, markedTextOperation: nil, skipTransforms: true, allowUpdateWithoutTextStorage: false))

    return self.editorState
  }
}

internal enum NativeSelectionModificationType {
  case move
  case extend
}

internal struct UpdateBehaviourModificationMode {
  let markedTextOperation: MarkedTextOperation?
  let skipTransforms: Bool
  let suppressReconcilingSelection: Bool
  let suppressSanityCheck: Bool
  let allowUpdateWithoutTextStorage: Bool

  internal init(
    suppressReconcilingSelection: Bool = false,
    suppressSanityCheck: Bool = false,
    markedTextOperation: MarkedTextOperation? = nil,
    skipTransforms: Bool = false,
    allowUpdateWithoutTextStorage: Bool = false
  ) {
    self.suppressReconcilingSelection = suppressReconcilingSelection
    self.suppressSanityCheck = suppressSanityCheck
    self.markedTextOperation = markedTextOperation
    self.skipTransforms = skipTransforms
    self.allowUpdateWithoutTextStorage = allowUpdateWithoutTextStorage
  }
}
