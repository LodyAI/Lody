import Foundation

let base = HTMLPreviewResource.url(path: "docs/intro page.html", host: "preview")
assert(base.absoluteString == "lody-preview://preview/__lody_files/docs/intro%20page.html")
assert(!URL(string: "/assets/app.js", relativeTo: base)!.absoluteURL.path.hasPrefix(HTMLPreviewResource.filePrefix))
let relative = URL(string: "../assets/app.js?v=1", relativeTo: base)!.absoluteURL
assert(HTMLPreviewResource.path(relative, documentPath: "docs/intro page.html") == "assets/app.js")
let absolute = HTMLPreviewResource.url(path: "/Users/example/project/demo.html", host: "preview")
let image = URL(string: "./image.png", relativeTo: absolute)!.absoluteURL
assert(HTMLPreviewResource.path(image, documentPath: "/Users/example/project/demo.html") == "/Users/example/project/image.png")
for value in ["http://localhost:5173/a", "http://127.0.0.1/a", "http://[::1]/a", "https://test.localhost/a"] {
  assert(HTMLPreviewResource.code(URL(string: value)!) == "local_service_unavailable")
}
assert(HTMLPreviewResource.code(URL(string: "https://cdn.example.com/app.js")!) == "resource_failed")
assert(HTMLPreviewResource.code(URL(string: "file:///Users/example/a.png")!) == "local_file_unavailable")
assert(HTMLPreviewResource.safeReference("https://user:secret@example.com/a?token=secret#secret") == "https://example.com/a")
assert(HTMLPreviewResource.safeReference("./a.png?token=secret") == "./a.png")
print("PASS: relative/absolute paths, loopback service classification and diagnostic credential redaction")

assert(HTMLPreviewText.isHTML("docs/demo.HTM"))
assert(!HTMLPreviewText.isHTML("docs/demo.html.ts"))
func error(_ message: String) -> NSError { NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
assert(HTMLPreviewText.readError(error("Code Collab RPC owner session mismatch")) == "resource_failed")
assert(HTMLPreviewText.readError(error("permission_denied")) == "permission_denied")
let issues = [["reference": "../assets/app.js", "path": "assets/app.js", "code": "file_not_found", "kind": "script"]]
let report = HTMLPreviewText.report(path: "docs/index.html", issues: issues)
let json = String(report[report.firstIndex(of: "{")!...])
let parsed = try! JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
assert(parsed["file"] as? String == "docs/index.html")
assert(parsed["issues"] as? [[String: String]] == issues)
print("PASS: preview reports preserve original references and unclassified errors remain explicit")
