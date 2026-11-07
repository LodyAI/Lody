import UIKit

@MainActor
final class FileContentPreviewController: UIViewController {
  private struct Fixture {
    var id: String
    var title: String
    var path: String
    var line: Int?
    var preview = false
    var feedback: Result<PreviewFeedbackResult, PreviewFeedbackError>?
  }

  private static let fixtures = [
    Fixture(id: "file:report.md", title: "Markdown", path: "docs/report.md"),
    Fixture(id: "file:sample.swift", title: "Source line 120", path: "docs/sample.swift", line: 120),
    Fixture(id: "file:missing.txt", title: "Missing file", path: "docs/missing.txt"),
    Fixture(id: "file:rpc-error.md", title: "Read failure", path: "rpc-error.md"),
    Fixture(id: "html:source", title: "HTML source", path: "docs/interactive.html", feedback: .success(.sent)),
    Fixture(id: "html:failures", title: "HTML resource failures", path: "docs/broken.html", preview: true, feedback: .success(.sent)),
    Fixture(id: "html:feedback-failure", title: "HTML feedback failure", path: "docs/broken.html", preview: true, feedback: .failure(.failed("send_failed"))),
    Fixture(id: "html:queued", title: "HTML queued feedback", path: "docs/broken.html", preview: true, feedback: .success(.queued)),
    Fixture(id: "html:diff", title: "HTML diff", path: "docs/interactive.html", feedback: .success(.sent)),
  ]

  private let list = LodyGroupedList(frame: .zero)
  private let report = UIView(frame: CGRect(x: 0, y: 0, width: 44, height: 44))

  override func viewDidLoad() {
    super.viewDidLoad()
    list.frame = view.bounds
    list.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    list.forwarded = { [weak self] name, body in
      guard name == "rowPress", let id = body["id"] as? String, let fixture = Self.fixtures.first(where: { $0.id == id }) else { return }
      self?.open(fixture)
    }
    view.addSubview(list)
    report.isAccessibilityElement = true
    report.accessibilityIdentifier = "html-feedback-report"
    report.isUserInteractionEnabled = false
    report.isHidden = true
    view.addSubview(report)
    var section = LodyListSection()
    section.id = "files"
    section.rows = Self.fixtures.map { fixture in
      var row = LodyListRow()
      row.id = fixture.id
      row.title = fixture.title
      row.subtitle = fixture.path
      row.subtitleMono = true
      row.action = true
      row.navigates = true
      row.disclosure = true
      return row
    }
    list.setSections([section])
  }

  private func open(_ fixture: Fixture) {
    let feedback = fixture.feedback.map { outcome in
      PreviewFeedback(
        send: { [weak self] text in
          self?.report.accessibilityLabel = text
          self?.report.isHidden = false
          return try outcome.get()
        },
        openSession: {}
      )
    }
    if fixture.id == "html:diff" {
      let request = FileDiffRequest(sessionId: "ui-verify-diff", entryId: "diff-preview", path: fixture.path)
      let diff = FileDiffController(request: request, feedback: feedback, service: FileDiffFixture().service, files: Self.service)
      LodyShell.shared.pushNative(diff, title: FilePathText.basename(fixture.path), from: self)
      return
    }
    let content = FileContentController(
      sessionId: "ui-verify-files", path: fixture.path, line: fixture.line, preview: fixture.preview, feedback: feedback, service: Self.service
    )
    LodyShell.shared.presentNative(content, title: FilePathText.basename(fixture.path), grabber: true)
  }

  static let service = FileContentService(
    read: { sessionId, path in
      let payload = String(decoding: try JSONSerialization.data(withJSONObject: ["sessionId": sessionId, "path": path]), as: UTF8.self)
      if let failure = FilePreviewFixture.failure(payload) { throw failure }
      guard let response = FilePreviewFixture.response(payload) else { return .failed(code: "file_not_found") }
      if !path.hasSuffix(".html"), !path.contains("/assets/") { try await Task.sleep(for: .milliseconds(800)) }
      return FileContentService.parse(response)
    },
    quickLook: { _, _, _ in false }
  )
}
