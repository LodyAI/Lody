import Foundation
import Lexical
@testable import LexicalHTML
import Testing

@Test func parsesTheBodyWithDecodedEntities() {
  let body = DOMDocument.parse(html: "<html><head><title>T</title></head><body><p class=\"a b\" style=\"Font-Weight: BOLD; text-align:center\">x &amp; y&nbsp;z</p></body></html>")
  #expect(body.name == "BODY")
  let p = body.children[0]
  #expect(p.name == "P")
  #expect(p.classList.contains("b"))
  #expect(p.style("font-weight") == "bold")
  #expect(p.style("text-align") == "center")
  #expect(p.textContent == "x & y\u{00A0}z")
  #expect(p.children[0].parent === p)
}

@Test func fragmentsGetAnImplicitBody() {
  let body = DOMDocument.parse(html: "<b>bold</b> tail")
  #expect(body.children.map(\.name) == ["B", "#text"])
  #expect(body.children[1].text == " tail")
  #expect(body.children[0].nextSibling === body.children[1])
  #expect(body.children[1].previousSibling === body.children[0])
}

@Test func activeAndEmbeddedContentIsDropped() {
  let html = "<p>keep</p><script>alert(1)</script><style>p{}</style><iframe src=x></iframe><object></object><embed><template><p>t</p></template><noscript><p>n</p></noscript><!-- note --><p>also</p>"
  let body = DOMDocument.parse(html: html)
  #expect(body.children.map(\.name) == ["P", "P"])
  #expect(body.textContent == "keepalso")
}

@Test func externalEntitiesAreNeverLoaded() {
  let html = "<!DOCTYPE html [<!ENTITY x SYSTEM \"file:///etc/hosts\">]><p>&x;</p>"
  #expect(!DOMDocument.parse(html: html).textContent.contains("localhost"))
}

@Test func deepNestingIsCappedWithoutCrashing() {
  let depth = 5000
  let html = "<p>top</p>" + String(repeating: "<div>", count: depth) + "leaf" + String(repeating: "</div>", count: depth)
  let body = DOMDocument.parse(html: html)
  var levels = 0
  var node: DOMNode? = body.children.last
  while let child = node?.children.first {
    levels += 1
    node = child
  }
  #expect(body.textContent.hasPrefix("top"))
  #expect(levels <= 256)
}

@Test func headlessEditorsOffTheMainThreadDoNotInterfere() async throws {
  let main = Editor.createHeadless(editorConfig: EditorConfig(theme: Theme(), plugins: []))
  let results = await withTaskGroup(of: String?.self) { group in
    for index in 0..<32 {
      group.addTask {
        let editor = Editor.createHeadless(editorConfig: EditorConfig(theme: Theme(), plugins: []))
        try? editor.update {
          try getRoot()?.getFirstChild()?.remove()
          let paragraph = createParagraphNode()
          try paragraph.append([createTextNode(text: "bg\(index)")])
          try getRoot()?.append([paragraph])
        }
        var text: String?
        try? editor.read { text = getRoot()?.getTextContent() }
        return text
      }
    }
    for index in 0..<32 {
      try? main.update {
        let paragraph = createParagraphNode()
        try paragraph.append([createTextNode(text: "m\(index)")])
        try getRoot()?.append([paragraph])
      }
    }
    var collected: [String?] = []
    for await result in group { collected.append(result) }
    return collected
  }
  #expect(Set(results.compactMap { $0 }) == Set((0..<32).map { "bg\($0)" }))
}

@Test func stylesheetRulesApplyUnderInlineStyles() {
  let html = "<html><head><style>span.s1 {font-weight: bold; font-style: normal} .note {font-style: italic} p {text-align: center}</style></head><body><p><span class=\"s1\" style=\"font-style: italic\">b</span><span class=\"note\">n</span></p></body></html>"
  let p = DOMDocument.parse(html: html).children[0]
  #expect(p.style("text-align") == "center")
  #expect(p.children[0].style("font-weight") == "bold")
  #expect(p.children[0].style("font-style") == "italic")
  #expect(p.children[1].style("font-style") == "italic")
}
