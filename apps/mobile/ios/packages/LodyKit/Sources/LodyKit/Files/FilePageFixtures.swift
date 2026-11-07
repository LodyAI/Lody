import LodyCore
import UIKit

@MainActor
final class FileFeedbackFixture {
  weak var owner: UIViewController?
  let outcome: String
  init(_ params: [String: Any]) { outcome = params["feedbackOutcome"] as? String ?? "sent" }
  var feedback: PreviewFeedback {
    PreviewFeedback(send: { [self] report in
      guard let owner else { throw PreviewFeedbackError.unavailable }
      try await LodyShell.shared.callback(from: owner, name: "onFeedback", value: report)
      if outcome == "failed" { throw PreviewFeedbackError.failed("send_failed") }
      return PreviewFeedbackResult(rawValue: outcome)!
    }, openSession: {})
  }
}

@MainActor
final class FileContentFixtureController: FileContentController {
  private let fixture: FileFeedbackFixture
  init(params: [String: Any]) {
    fixture = FileFeedbackFixture(params)
    super.init(sessionId: params["sessionId"] as! String, path: params["path"] as! String,
      line: params["line"] as? Int, preview: params["preview"] as? Bool ?? false,
      feedback: fixture.feedback, service: FileContentPreviewController.service)
    fixture.owner = self
  }
  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }
}

@MainActor
final class FileDiffFixtureController: FileDiffController {
  private let fixture: FileFeedbackFixture
  init(params: [String: Any]) {
    fixture = FileFeedbackFixture(params)
    super.init(request: .init(sessionId: params["sessionId"] as! String, entryId: params["entryId"] as? String, path: params["path"] as! String),
      feedback: fixture.feedback, service: FileDiffFixture().service, files: FileContentPreviewController.service)
    fixture.owner = self
  }
  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }
}

@MainActor
final class FilesFixtureController: FilesController {
  init(params: RuntimeContract.ListDirParams) {
    super.init(params: params, service: .init(list: { request in
      let payload = String(decoding: try JSONEncoder().encode(request), as: UTF8.self)
      let json = FilePreviewFixture.response(payload, listing: true)!
      return try JSONDecoder().decode(RuntimeContract.DirectoryListing.self, from: Data(json.utf8))
    }, open: { sessionId, path, controller in
      await FileContentController.open(sessionId: sessionId, path: path,
        service: .init(read: { session, path in
          // Keep the loading scene observable across the native sheet transition.
          if path.hasSuffix("report.md") { try await Task.sleep(for: .seconds(3)) }
          return try await FileContentPreviewController.service.read(session, path)
        }, quickLook: FileContentService.live.quickLook), from: controller)
    }))
  }
  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }
}
