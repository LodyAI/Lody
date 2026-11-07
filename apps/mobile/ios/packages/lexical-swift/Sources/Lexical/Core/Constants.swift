/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Foundation
import UIKit

public struct NodeType: Hashable, RawRepresentable, Sendable {
  public init(rawValue: String) {
    self.rawValue = rawValue
  }
  public var rawValue: String

  public static let unknown = NodeType(rawValue: "unknown")
  public static let root = NodeType(rawValue: "root")
  public static let text = NodeType(rawValue: "text")
  public static let paragraph = NodeType(rawValue: "paragraph")
  public static let element = NodeType(rawValue: "element")
  public static let heading = NodeType(rawValue: "heading")
  public static let quote = NodeType(rawValue: "quote")
  public static let linebreak = NodeType(rawValue: "linebreak")
  public static let tab = NodeType(rawValue: "tab")
  public static let code = NodeType(rawValue: "code")
  public static let codeHighlight = NodeType(rawValue: "code-highlight")
}

public enum Mode: String, Codable {
  case normal
  case token
  case segmented
  case inert
}

public enum LexicalConstants {
  // If we provide a systemFont as our default, it causes trouble for modifying font family.
  // Apple sets a private key NSCTFontUIUsageAttribute on the font descriptor, and that
  // key overrides any face or family key that we set. Hence we provide a default font of
  // Helvetica instead. Note that we need a fallback to something non-optional, hence
  // we do use system font if Helvetica cannot be found. This should never happen.
  static let defaultFont = UIFont(name: "Helvetica", size: 15.0) ?? UIFont.systemFont(ofSize: 15.0)

  static let defaultColor: UIColor = UIColor.label

  // Sigil value used during node initialization
  static let uninitializedNodeKey = "uninitializedNodeKey"

  public static let pasteboardIdentifier = "x-lexical-nodes"
}

public typealias DirtyNodeMap = [NodeKey: DirtyStatusCause]

public typealias NodeTransform = (_ node: Node) throws -> Void

public enum DirtyStatusCause {
  case userInitiated
  case editorInitiated
}

public enum DirtyType {
  case noDirtyNodes
  case hasDirtyNodes
  case fullReconcile
}

@objc public enum TextFormatType: Int, Sendable {
  case bold
  case italic
  case underline
  case strikethrough
  case code
  case subScript
  case superScript
  case highlight
}

enum Direction: String, Codable {
  case ltr
  case rtl
}

public enum Destination: Codable {
  case clone
  case html
}

enum TextStorageEditingMode {
  case none
  case controllerMode
}

public struct CommandType: RawRepresentable, Hashable {
  public var rawValue: String
  public init(rawValue: String) {
    self.rawValue = rawValue
  }

  public static let selectionChange = CommandType(rawValue: "selectionChange")
  public static let click = CommandType(rawValue: "click")
  public static let deleteCharacter = CommandType(rawValue: "deleteCharacter")
  public static let insertLineBreak = CommandType(rawValue: "insertLineBreak")
  public static let insertParagraph = CommandType(rawValue: "insertParagraph")
  public static let insertText = CommandType(rawValue: "insertText")
  public static let paste = CommandType(rawValue: "paste")
  public static let cut = CommandType(rawValue: "cut")
  public static let copy = CommandType(rawValue: "copy")
  public static let removeText = CommandType(rawValue: "removeText")
  public static let deleteWord = CommandType(rawValue: "deleteWord")
  public static let deleteLine = CommandType(rawValue: "deleteLine")
  public static let formatText = CommandType(rawValue: "formatText")
  public static let keyArrowRight = CommandType(rawValue: "keyArrowRight")
  public static let keyArrowLeft = CommandType(rawValue: "keyArrowLeft")
  public static let keyArrowUp = CommandType(rawValue: "keyArrowUp")
  public static let keyArrowDown = CommandType(rawValue: "keyArrowDown")
  public static let keyEnter = CommandType(rawValue: "keyEnter")
  public static let keyBackspace = CommandType(rawValue: "keyBackspace")
  public static let keyEscape = CommandType(rawValue: "keyEscape")
  public static let keyDelete = CommandType(rawValue: "keyDelete")
  public static let keyTab = CommandType(rawValue: "keyTab")
  public static let clearEditor = CommandType(rawValue: "clearEditor")
  public static let linkTapped = CommandType(rawValue: "linkTapped")
  public static let truncationIndicatorTapped = CommandType(rawValue: "truncationIndicatorTapped")
  public static let readOnlyViewTapped = CommandType(rawValue: "readOnlyViewTapped")
  public static let indentContent = CommandType(rawValue: "indentContent")
  public static let outdentContent = CommandType(rawValue: "outdentContent")
  public static let updatePlaceholderVisibility = CommandType(rawValue: "updatePlaceholderVisibility")
}

@objc public enum CommandPriority: Int {
  case Editor
  case Low
  case Normal
  case High
  case Critical
}

public typealias UpdateListener = (_ activeEditorState: EditorState, _ previousEditorState: EditorState, _ dirtyNodes: DirtyNodeMap) -> Void
public typealias TextContentListener = (_ text: String) -> Void
public typealias CommandListener = (_ payload: Any?) -> Bool
public typealias ErrorListener = (_ activeEditorState: EditorState, _ previousEditorState: EditorState, _ error: Error) -> Void

struct Listeners {
  var update: [UUID: UpdateListener] = [:]
  var textContent: [UUID: TextContentListener] = [:]
  var errors: [UUID: ErrorListener] = [:]
}

public struct CommandListenerWithMetadata {
  let listener: CommandListener
  let shouldWrapInUpdateBlock: Bool
}
public typealias Commands = [CommandType: [CommandPriority: [UUID: CommandListenerWithMetadata]]]

// enum is used in setting theme
public enum TextTransform: String {
  case lowercase = "lowercase"
  case uppercase = "uppercase"
  case none = "none"
}

public enum CustomDrawingLayer {
  case background
  case text
}

public enum CustomDrawingGranularity {
  case characterRuns
  case singleParagraph
  case contiguousParagraphs
}

/// See <doc:CustomDrawing> for description of the parameters
public typealias CustomDrawingHandler = (
  _ attributeKey: NSAttributedString.Key,
  _ attributeValue: Any,
  _ textStorage: NSTextStorage,
  _ attributeRunCharacterRange: NSRange,
  _ granularityExpandedCharacterRange: NSRange,
  _ glyphRange: NSRange,
  _ rect: CGRect,
  _ firstLineFragment: CGRect
) -> Void

@objc public final class BlockLevelAttributes: NSObject {
  public init(marginTop: CGFloat, marginBottom: CGFloat, paddingTop: CGFloat, paddingBottom: CGFloat) {
    self.marginTop = marginTop
    self.marginBottom = marginBottom
    self.paddingTop = paddingTop
    self.paddingBottom = paddingBottom
  }

  let marginTop: CGFloat
  let marginBottom: CGFloat
  let paddingTop: CGFloat
  let paddingBottom: CGFloat

  override public func isEqual(_ object: Any?) -> Bool {
    if let object = object as? BlockLevelAttributes {
      return self.marginTop == object.marginTop && self.marginBottom == object.marginBottom && self.paddingTop == object.paddingTop && self.paddingBottom == object.paddingBottom
    }
    return false
  }

  override public var hash: Int {
    var hasher = Hasher()
    hasher.combine(marginTop)
    hasher.combine(marginBottom)
    hasher.combine(paddingTop)
    hasher.combine(paddingBottom)
    return hasher.finalize()
  }
}
