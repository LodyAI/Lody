import LodyCore
import UIKit

@MainActor
final class ItemDetailPreviewController: ItemDetailController {
  private let fixture: ItemDetailFixture

  init(scenario: String) {
    let fixture = ItemDetailFixture(scenario: scenario)
    self.fixture = fixture
    super.init(sessionId: "item-preview", entryId: "entry", itemIds: ["item"], generation: 0, service: fixture.service)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func didMove(toParent parent: UIViewController?) {
    super.didMove(toParent: parent)
    if fixture.scenario == "paging" {
      parent?.navigationItem.leftBarButtonItem = UIBarButtonItem(title: "Update", primaryAction: UIAction { [weak self] _ in
        self?.fixture.update()
      })
    }
  }
}

@MainActor
private final class ItemDetailFixture {
  let scenario: String
  private var attempts = 0
  private var pages = 0
  private var revision = 1
  private var receive: (@MainActor (Int, String?) -> Void)?
  init(scenario: String) { self.scenario = scenario }

  var service: ItemDetailService {
    ItemDetailService(load: { [self] params in
      try await Task.sleep(for: .milliseconds(200))
      attempts += 1
      if scenario == "paging", attempts == 1 { throw CocoaError(.fileReadUnknown) }
      if params.cursor != nil {
        pages += 1
        if pages == 1 { throw CocoaError(.fileReadUnknown) }
        return .init(itemId: params.itemId, rev: revision,
                     blocks: [block(["type": "terminal_output", "output": "Second page output"])], truncated: false)
      }
      if scenario == "diff" {
        return .init(itemId: params.itemId, rev: revision, blocks: [block([
          "type": "diff", "path": "src/inline.ts", "oldText": "export const greeting = 'hi'\n",
          "newText": "export const greeting = 'hello'\n",
        ])], truncated: false)
      }
      if scenario == "subtask" {
        return .init(itemId: params.itemId, rev: revision, blocks: [
          block(["type": "terminal_command", "command": "cat ChatComposerView.swift"]),
          block(["type": "terminal_output", "output": "The action bar is ChatActionBarView."]),
        ], truncated: false)
      }
      return .init(itemId: params.itemId, rev: revision, blocks: [
        block(["type": "terminal_command", "command": "swift", "args": ["test"], "cwd": "packages/lody-core"]),
        block(["type": "terminal_output", "output": "Revision \(revision) output", "exitStatus": ["exitCode": 1]]),
      ], rawInput: .init(value: .object(["fixture": .string("raw input")])),
      rawOutput: .init(value: .object(["fixture": .string("raw output")])), truncated: revision == 1,
      nextCursor: revision == 1 ? "next" : nil)
    }, observe: { [self] receive in
      self.receive = receive
      return { [weak self] in self?.receive = nil }
    })
  }

  func update() {
    revision += 1
    receive?(0, "{\"v\":1,\"revision\":\(revision),\"status\":\"live\",\"entries\":[{\"id\":\"entry\",\"items\":[{\"itemId\":\"item\",\"rev\":\(revision)}]}]}")
  }

  private func block(_ value: [String: Any]) -> RuntimeContract.JSONValue {
    try! JSONDecoder().decode(RuntimeContract.JSONValue.self, from: JSONSerialization.data(withJSONObject: value))
  }
}
