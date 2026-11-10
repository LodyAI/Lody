@testable import Lexical
import UIKit
import XCTest

private final class SpyDelegate: NSObject, UITextViewDelegate {
  var changes = 0
  var selectionChanges = 0
  var allowChange = true
  var scrolls = 0

  func textViewDidChange(_ textView: UITextView) { changes += 1 }
  func textViewDidChangeSelection(_ textView: UITextView) { selectionChanges += 1 }
  func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool { allowChange }
  func scrollViewDidScroll(_ scrollView: UIScrollView) { scrolls += 1 }
}

private final class CustomTextView: TextView {}

final class TextKit2Tests: XCTestCase {
  private func makeView(nodes: [NodeType: Node.Type] = [:]) throws -> (LexicalView, UIWindow) {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags())
    for (type, cls) in nodes { try view.editor.registerNode(nodeType: type, class: cls) }
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 800))
    view.frame = window.bounds
    window.addSubview(view)
    window.isHidden = false
    view.layoutIfNeeded()
    return (view, window)
  }

  func testEditableTextViewIsNotAnnouncedAsStaticText() throws {
    let (view, _) = try makeView()
    XCTAssertFalse(view.textView.accessibilityTraits.contains(.staticText))
  }

  func testSettingTextReplacesTheDocumentThroughTheEditor() throws {
    let (view, _) = try makeView()
    let textView = view.textView
    textView.insertText("old")
    textView.text = "first\nsecond\n\nfourth"
    XCTAssertEqual(textView.text, "first\nsecond\n\nfourth")
    try view.editor.read {
      let blocks = getRoot()?.getChildren() ?? []
      XCTAssertEqual(blocks.count, 4)
      XCTAssertTrue(blocks.allSatisfy { $0 is ParagraphNode })
      XCTAssertEqual(blocks.first?.getTextContent().trimmingCharacters(in: .newlines), "first")
    }
    XCTAssertEqual(textView.selectedRange, NSRange(location: (textView.text as NSString).length, length: 0))
    textView.insertText("!")
    XCTAssertEqual(textView.text, "first\nsecond\n\nfourth!")

    textView.text = ""
    XCTAssertEqual(textView.text, "")
    textView.insertText("again")
    XCTAssertEqual(textView.text, "again")
  }

  func testRenderingCodeDoesNotRewriteTextFormats() throws {
    let (view, _) = try makeView()
    try view.editor.update {
      guard let root = getRoot() else { return }
      let code = createCodeNode()
      var bold = TextFormat()
      bold.bold = true
      try code.append([try createTextNode(text: "x").setFormat(format: bold)])
      try root.getChildren().forEach { try $0.remove() }
      try root.append([code])
    }
    view.layoutIfNeeded()
    let json = try view.editor.getEditorState().toJSON()
    XCTAssertTrue(json.contains(#""format":1"#), json)
  }

  func testInsertingMultilineTextKeepsEveryLine() throws {
    let (view, _) = try makeView()
    view.textView.insertText("start ")
    view.textView.insertText("a\nb\n\nc")
    XCTAssertEqual(view.textView.text, "start a\nb\n\nc")
    view.textView.insertText("!")
    XCTAssertEqual(view.textView.text, "start a\nb\n\nc!")
  }

  func testTextViewUsesTextKit2() throws {
    let (view, _) = try makeView()
    XCTAssertNotNil(view.textView.textLayoutManager)
    XCTAssertTrue(view.textView.textStorage is TextStorage)
  }

  func testStaysOnTextKit2AfterMarkedTextDecoratorAndPaste() throws {
    let (view, _) = try makeView(nodes: [.testNode: TestDecoratorNode.self])
    let textView = view.textView
    textView.becomeFirstResponder()
    textView.insertText("IME:")
    for step in ["n", "ni", "nih", "niha", "nihao"] {
      textView.setMarkedText(step, selectedRange: NSRange(location: step.utf16.count, length: 0))
    }
    textView.insertText("你好")
    try view.editor.update {
      _ = try getSelection()?.insertNodes(nodes: [TestDecoratorNode()], selectStart: false)
    }
    let pasteboard = UIPasteboard.withUniqueName()
    pasteboard.string = "pasted"
    view.editor.dispatchCommand(type: .paste, payload: pasteboard)
    view.layoutIfNeeded()

    XCTAssertNotNil(textView.textLayoutManager)
    XCTAssertTrue(textView.text.hasPrefix("IME:你好"))
    XCTAssertTrue(textView.text.hasSuffix("pasted"))
  }

  func testDecoratorFollowsTextInsertedBeforeIt() throws {
    let (view, _) = try makeView(nodes: [.testNode: TestDecoratorNode.self])
    var decoratorKey: NodeKey?
    var first: ParagraphNode?
    try view.editor.update {
      guard let root = getRoot() else { return }
      let paragraph = createParagraphNode()
      try paragraph.append([createTextNode(text: "first")])
      let decoratorParagraph = createParagraphNode()
      let decorator = TestDecoratorNode()
      try decoratorParagraph.append([decorator])
      try root.getChildren().forEach { try $0.remove() }
      try root.append([paragraph, decoratorParagraph])
      decoratorKey = decorator.key
      first = paragraph
    }
    view.layoutIfNeeded()
    guard let key = decoratorKey, let decoratorView = try decoratorViewForTest(view, key) else {
      return XCTFail("decorator view was not mounted")
    }
    let before = decoratorView.frame
    XCTAssertFalse(decoratorView.isHidden)

    try view.editor.update {
      _ = try first?.selectStart()
    }
    view.textView.insertText("\n")
    view.textView.insertText("\n")
    view.layoutIfNeeded()

    XCTAssertGreaterThan(decoratorView.frame.minY, before.minY + 10)
    XCTAssertEqual(decoratorView.frame.size, CGSize(width: 100, height: 100))
  }

  func testUserEditsAskAndNotifyExternalDelegate() throws {
    let (view, _) = try makeView()
    let textView = view.textView
    let spy = SpyDelegate()
    textView.delegate = spy

    spy.allowChange = false
    textView.insertText("blocked")
    XCTAssertEqual(textView.text, "")
    XCTAssertEqual(spy.changes, 0)

    spy.allowChange = true
    textView.insertText("abc")
    XCTAssertEqual(textView.text, "abc")
    XCTAssertEqual(spy.changes, 1)

    textView.deleteBackward()
    XCTAssertEqual(textView.text, "ab")
    XCTAssertEqual(spy.changes, 2)

    spy.allowChange = false
    textView.deleteBackward()
    XCTAssertEqual(textView.text, "ab")
    XCTAssertEqual(spy.changes, 2)
  }

  func testUIKitDelegateCallbacksReachExternalDelegate() throws {
    let (view, _) = try makeView()
    let textView = view.textView
    let spy = SpyDelegate()
    textView.delegate = spy
    textView.insertText(String(repeating: "line\n", count: 80))
    view.layoutIfNeeded()

    textView.selectedRange = NSRange(location: 2, length: 0)
    XCTAssertGreaterThan(spy.selectionChanges, 0)

    textView.setContentOffset(CGPoint(x: 0, y: 200), animated: false)
    XCTAssertGreaterThan(spy.scrolls, 0)
  }

  func testLexicalViewHostsTextViewSubclass() throws {
    let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: []), featureFlags: FeatureFlags(), textViewType: CustomTextView.self)
    XCTAssertTrue(view.textView is CustomTextView)
    view.textView.insertText("sub")
    XCTAssertEqual(view.textView.text, "sub")
    XCTAssertNotNil(view.textView.textLayoutManager)
  }

  func testCodeBlockBackgroundIsDrawnAcrossTheLine() throws {
    let (view, _) = try makeView()
    view.textView.backgroundColor = .white
    try view.editor.update {
      guard let root = getRoot() else { return }
      let code = createCodeNode()
      try code.append([createTextNode(text: "let x = 1")])
      try root.getChildren().forEach { try $0.remove() }
      try root.append([code])
    }
    view.layoutIfNeeded()
    let textView = view.textView
    guard let tlm = textView.textLayoutManager, let fragment = tlm.textLayoutFragment(for: tlm.documentRange.location) else {
      return XCTFail("no layout fragment")
    }
    let frame = fragment.layoutFragmentFrame
    let probe = CGPoint(x: textView.bounds.width - textView.textContainerInset.right - 20, y: frame.midY + textView.textContainerInset.top)
    let image = UIGraphicsImageRenderer(bounds: textView.bounds).image { context in
      textView.layer.render(in: context.cgContext)
    }
    let color = pixel(image, at: probe)
    XCTAssertLessThan(color.white, 0.9, "code block background should fill the line beyond the glyphs")
  }

  private func pixel(_ image: UIImage, at point: CGPoint) -> (white: CGFloat, alpha: CGFloat) {
    let scale = image.scale
    guard let cgImage = image.cgImage,
      let cropped = cgImage.cropping(to: CGRect(x: Int(point.x * scale), y: Int(point.y * scale), width: 1, height: 1))
    else { return (1, 0) }
    var data = [UInt8](repeating: 0, count: 4)
    let context = CGContext(data: &data, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    context?.draw(cropped, in: CGRect(x: 0, y: 0, width: 1, height: 1))
    return ((CGFloat(data[0]) + CGFloat(data[1]) + CGFloat(data[2])) / (3 * 255), CGFloat(data[3]) / 255)
  }

  func testSourcesNeverTouchTextKit1LayoutManager() throws {
    let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../Sources").standardized
    let files = FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil)?.compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" } ?? []
    XCTAssertFalse(files.isEmpty)
    for file in files {
      let text = try String(contentsOf: file, encoding: .utf8)
      XCTAssertFalse(text.contains(".layoutManager"), "\(file.lastPathComponent) touches UITextView.layoutManager, which switches it to TextKit 1")
    }
  }

  private func decoratorViewForTest(_ view: LexicalView, _ key: NodeKey) throws -> UIView? {
    var result: UIView?
    try view.editor.read { result = decoratorView(forKey: key, createIfNecessary: false) }
    return result
  }
}
