import Foundation

assert(ChatFileLink("docs/report%20one.md#L12-L20")?.path == "docs/report one.md")
assert(ChatFileLink("docs/report%20one.md#L12-L20")?.line == 12)
assert(ChatFileLink("C:\\repo\\sample.swift:2")?.path == "C:/repo/sample.swift")
assert(ChatFileLink("C:\\repo\\sample.swift:2")?.line == 2)
assert(ChatFileLink("../photo.png")?.path == "../photo.png")
for href in ["https://example.com/report.md", "javascript:alert(1)", "file:///etc/passwd", "//example.com/a.md", "#heading", "report.md?download", "a%00.md"] {
  assert(ChatFileLink(href) == nil, href)
}
print("PASS: file links preserve paths and line anchors while rejecting external schemes and malformed targets")
