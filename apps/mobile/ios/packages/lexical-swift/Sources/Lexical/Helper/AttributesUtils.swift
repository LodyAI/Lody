/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Foundation
import UIKit

enum AttributeUtils {
  static func attributedStringByAddingStyles(
    _ attributedString: NSAttributedString,
    from node: Node,
    state: EditorState,
    theme: Theme
  ) -> NSAttributedString {

    let combinedAttributes = attributedStringStyles(from: node, state: state, theme: theme)
    let length = attributedString.length

    guard let mutableCopy = attributedString.mutableCopy() as? NSMutableAttributedString else {
      // should never happen
      return NSAttributedString()
    }

    let copiedAttributes: NSDictionary = NSDictionary(dictionary: combinedAttributes)
    guard let copiedAttributesSwiftDict: [NSAttributedString.Key: Any] = copiedAttributes as? [NSAttributedString.Key: Any] else {
      return NSAttributedString()
    }

    // update font and rest of the attributes
    mutableCopy.addAttributes(copiedAttributesSwiftDict, range: NSRange(location: 0, length: length))

    guard let copiedString: NSAttributedString = mutableCopy.copy() as? NSAttributedString else {
      return NSAttributedString()
    }
    return copiedString
  }

  internal static func attributedStringStyles(
    from node: Node,
    state: EditorState,
    theme: Theme
  ) -> [NSAttributedString.Key: Any] {
    let lexicalAttributes = getLexicalAttributes(from: node, state: state, theme: theme).reversed()

    // combine all dictionaries and update the font style
    // leaf node's attributes have a priority over element node's attributes
    // hence, they are applied last
    var combinedAttributes = lexicalAttributes.reduce([:]) { $0.merging($1) { $1 } }

    var font = combinedAttributes[.font] as? UIFont ?? LexicalConstants.defaultFont
    var fontDescriptor = font.fontDescriptor
    var symbolicTraits = fontDescriptor.symbolicTraits

    // update symbolicTraits
    if let bold = combinedAttributes[.bold] as? Bool {
      if bold {
        symbolicTraits = symbolicTraits.union([.traitBold])
      } else {
        symbolicTraits = symbolicTraits.remove(.traitBold) ?? symbolicTraits
      }
    }

    if let italic = combinedAttributes[.italic] as? Bool {
      if italic {
        symbolicTraits = symbolicTraits.union([.traitItalic])
      } else {
        symbolicTraits = symbolicTraits.remove(.traitItalic) ?? symbolicTraits
      }
    }

    // update font face, family and size
    if let family = combinedAttributes[.fontFamily] as? String {
      fontDescriptor = fontDescriptor.withFamily(family)
    }

    if let size = coerceCGFloat(combinedAttributes[.fontSize]) {
      fontDescriptor = fontDescriptor.addingAttributes([.size: size])
    }

    fontDescriptor = fontDescriptor.withSymbolicTraits(symbolicTraits) ?? fontDescriptor
    font = UIFont(descriptor: fontDescriptor, size: 0)

    combinedAttributes[.font] = font

    if let paragraphStyle = getParagraphStyle(attributes: combinedAttributes, indentSize: CGFloat(theme.indentSize)) {
      combinedAttributes[.paragraphStyle] = paragraphStyle
      combinedAttributes[.paragraphSpacingBefore_internal] = paragraphStyle.paragraphSpacingBefore
      combinedAttributes[.paragraphSpacing_internal] = paragraphStyle.paragraphSpacing
    }

    if combinedAttributes[.foregroundColor] == nil {
      combinedAttributes[.foregroundColor] = LexicalConstants.defaultColor
    }

    return combinedAttributes
  }

  static func getLexicalAttributes(
    from node: Node,
    state: EditorState,
    theme: Theme
  ) -> [[NSAttributedString.Key: Any]] {
    var node = node
    var attributes = [[NSAttributedString.Key: Any]]()
    attributes.append(node.getAttributedStringAttributes(theme: theme))
    if let elementNode = node as? ElementNode, elementNode.isInline() == false {
      attributes.append([.indent_internal: elementNode.getIndent()])
    }

    while let parent = node.parent, let parentNode = state.nodeMap[parent] {
      attributes.append(parentNode.getAttributedStringAttributes(theme: theme))
      if let elementNode = parentNode as? ElementNode, elementNode.isInline() == false {
        attributes.append([.indent_internal: elementNode.getIndent()])
      }
      node = parentNode
    }

    return attributes
  }

  private static func getParagraphStyle(attributes: [NSAttributedString.Key: Any], indentSize: CGFloat) -> NSParagraphStyle? {
    let paragraphStyle = NSMutableParagraphStyle()
    var styleFound = false

    var leftPadding: CGFloat = 0
    if let newPaddingHead = coerceCGFloat(attributes[.paddingHead]) {
      leftPadding += newPaddingHead
    }
    if let indent = attributes[.indent_internal] as? Int {
      leftPadding += CGFloat(indent) * indentSize
    }

    if leftPadding > 0 {
      paragraphStyle.firstLineHeadIndent = leftPadding
      paragraphStyle.headIndent = leftPadding
      styleFound = true
    }

    if let newPaddingTail = coerceCGFloat(attributes[.paddingTail]) {
      paragraphStyle.tailIndent = newPaddingTail
      styleFound = true
    }

    if let newLineHeight = coerceCGFloat(attributes[.lineHeight]) {
      paragraphStyle.minimumLineHeight = newLineHeight
      styleFound = true
    }

    if let newLineSpacing = coerceCGFloat(attributes[.lineSpacing]) {
      paragraphStyle.lineSpacing = newLineSpacing
      styleFound = true
    }

    if let paragraphSpacingBefore = coerceCGFloat(attributes[.paragraphSpacingBefore]) {
      paragraphStyle.paragraphSpacingBefore = paragraphSpacingBefore
      styleFound = true
    }

    return styleFound ? paragraphStyle : nil
  }

  private static func coerceCGFloat(_ object: Any?) -> CGFloat? {
    if let object = object as? Int {
      return CGFloat(object)
    }
    if let object = object as? Float {
      return CGFloat(object)
    }
    if let object = object as? CGFloat {
      return object
    }
    if let object = object as? Double {
      return CGFloat(object)
    }
    return nil
  }

  private static func extraLineFragmentIsPresent(_ textStorage: TextStorage) -> Bool {
    let textAsNSString: NSString = textStorage.string as NSString
    guard textAsNSString.length > 0 else { return true }

    guard let scalar = Unicode.Scalar(textAsNSString.character(at: textAsNSString.length - 1)) else { return false }
    if NSCharacterSet.newlines.contains(scalar) { return true }
    return false
  }

  private enum BlockParagraphLocation {
    case range(NSRange, NSRange) // non-enclosing range, enclosing range
    case extraLineFragment
  }

  internal static func applyBlockLevelAttributes(_ attributes: BlockLevelAttributes, cacheItem: RangeCacheItem, textStorage: TextStorage, nodeKey: NodeKey, lastDescendentAttributes: [NSAttributedString.Key: Any]) {

    // for more information about the extraLineFragment, see NSLayoutManager docs
    let extraLineFragmentIsPresent = extraLineFragmentIsPresent(textStorage)
    let startTouchesExtraLineFragment = (extraLineFragmentIsPresent && cacheItem.range.length == 0 && cacheItem.range.location == textStorage.length)
    let endTouchesExtraLineFragment = (extraLineFragmentIsPresent && (NSMaxRange(cacheItem.range) - cacheItem.postambleLength) == textStorage.length) // ignore postamble, since postamble terminates the block

    var extraLineFragmentAttributes = (extraLineFragmentIsPresent) ? lastDescendentAttributes : [:]

    var paragraphs: [BlockParagraphLocation] = []

    if startTouchesExtraLineFragment {
      paragraphs.append(.extraLineFragment)
    } else {
      // this time we _don't_ ignore postamble, since we want the applied styles to touch the newlines, and enumerateSubstrings handles trimming newlines anyway
      textStorage.mutableString.enumerateSubstrings(in: cacheItem.range, options: .byParagraphs) { _, substringRange, enclosingRange, _ in
        paragraphs.append(.range(substringRange, enclosingRange))
      }
      if endTouchesExtraLineFragment {
        paragraphs.append(.extraLineFragment)
      }
    }

    // first may be the same as last. That's OK!
    guard let first = paragraphs.first, let last = paragraphs.last else {
      return
    }

    var firstParaStyle: NSParagraphStyle
    let spacingBeforeInternal: CGFloat?
    switch first {
    case .extraLineFragment:
      firstParaStyle = extraLineFragmentAttributes[.paragraphStyle] as? NSParagraphStyle ?? NSParagraphStyle()
      spacingBeforeInternal = extraLineFragmentAttributes[.paragraphSpacingBefore_internal] as? CGFloat
    case .range(let nonEnclosing, _):
      firstParaStyle = textStorage.attribute(.paragraphStyle, at: nonEnclosing.location, effectiveRange: nil) as? NSParagraphStyle ?? NSParagraphStyle()
      spacingBeforeInternal = textStorage.attribute(.paragraphSpacingBefore_internal, at: nonEnclosing.location, effectiveRange: nil) as? CGFloat
    }

    guard let firstMutableParaStyle = firstParaStyle.mutableCopy() as? NSMutableParagraphStyle else {
      return
    }
    var spacingBefore = spacingBeforeInternal ?? firstMutableParaStyle.paragraphSpacingBefore
    spacingBefore += attributes.marginTop
    spacingBefore += attributes.paddingTop
    firstMutableParaStyle.paragraphSpacingBefore = spacingBefore

    switch first {
    case .extraLineFragment:
      extraLineFragmentAttributes[.paragraphStyle] = firstMutableParaStyle
    case .range(_, let enclosing):
      textStorage.addAttribute(.paragraphStyle, value: firstMutableParaStyle, range: enclosing)
    }

    // Now do the same for 'last'. This may involve reading back out the para style we just set for first, and modifying it further.

    var lastParaStyle: NSParagraphStyle
    let spacingInternal: CGFloat?

    switch last {
    case .extraLineFragment:
      lastParaStyle = extraLineFragmentAttributes[.paragraphStyle] as? NSParagraphStyle ?? NSParagraphStyle()
      spacingInternal = extraLineFragmentAttributes[.paragraphSpacing_internal] as? CGFloat
    case .range(let nonEnclosing, _):
      lastParaStyle = textStorage.attribute(.paragraphStyle, at: nonEnclosing.location, effectiveRange: nil) as? NSParagraphStyle ?? NSParagraphStyle()
      spacingInternal = textStorage.attribute(.paragraphSpacingBefore_internal, at: nonEnclosing.location, effectiveRange: nil) as? CGFloat
    }

    guard let lastMutableParaStyle = lastParaStyle.mutableCopy() as? NSMutableParagraphStyle else {
      return
    }
    var spacingAfter = spacingInternal ?? lastMutableParaStyle.paragraphSpacing
    spacingAfter += attributes.marginBottom
    spacingAfter += attributes.paddingBottom
    lastMutableParaStyle.paragraphSpacing = spacingAfter

    switch last {
    case .extraLineFragment:
      extraLineFragmentAttributes[.paragraphStyle] = lastMutableParaStyle
    case .range(_, let enclosing):
      textStorage.addAttribute(.paragraphStyle, value: lastMutableParaStyle, range: enclosing)
    }

    if extraLineFragmentIsPresent {
      textStorage.extraLineFragmentAttributes = extraLineFragmentAttributes
    } else {
      textStorage.extraLineFragmentAttributes = nil
    }

    // see comment on `appliedBlockLevelStyles_internal`. We're only doing this to provide data to our custom drawing routines.
    if !startTouchesExtraLineFragment, case .range(_, let enclosing) = first {
      textStorage.addAttribute(.appliedBlockLevelStyles_internal, value: attributes, range: enclosing)
    }
  }
}

extension NSAttributedString.Key {
  internal static let indent_internal: NSAttributedString.Key = .init(rawValue: "indent_internal")

  // These two properties are for Lexical to store the derived paragraph spacing. The reason for this is, when we calculate block
  // level styles, we need to read it back and adjust.
  internal static let paragraphSpacingBefore_internal: NSAttributedString.Key = .init(rawValue: "paragraphSpacingBefore_internal")
  internal static let paragraphSpacing_internal: NSAttributedString.Key = .init(rawValue: "paragraphSpacing_internal")

  // This attribute exists purely for storing the block level styles that have already been applied, so that the drawing code
  // within LayoutManager can read them back and pass them to any custom drawing functions. This attribute is not used to actually get
  // the spacing for margin/padding to be reserved, as they're already applied to the paragraph style!
  internal static let appliedBlockLevelStyles_internal: NSAttributedString.Key = .init(rawValue: "appliedBlockLevelStyles_internal")
}
