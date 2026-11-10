import UIKit

// Native session fixtures share the same scripted service and request projection.
@MainActor
final class PermissionSheetPreviewController: PermissionController {
  private let fixture: PermissionFixture
  private let probe = UIView()

  init(scenario: String) {
    let fixture = PermissionFixture(waiting: false, deferred: scenario == "waiting")
    self.fixture = fixture
    if scenario != "waiting" { fixture.request(questions: scenario == "questions") }
    super.init(sessionId: "permission-preview", service: fixture.service, source: PermissionSource { receive in
      var projection = PermissionProjection()
      receive(.waiting)
      return fixture.watch { event in
        projection.receive(generation: event.generation, phase: event.state, json: event.session)
        receive(projection.state)
      }
    })
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    probe.frame = CGRect(x: 0, y: 0, width: 1, height: 1)
    probe.isAccessibilityElement = true
    probe.accessibilityIdentifier = "permission-sheet-probe"
    view.addSubview(probe)
    fixture.changed = { [weak self] in self?.probe.accessibilityValue = self?.fixture.log.joined(separator: ",") }
    probe.accessibilityValue = fixture.log.joined(separator: ",")
  }

  override func didMove(toParent parent: UIViewController?) {
    super.didMove(toParent: parent)
    parent?.navigationItem.leftBarButtonItem = UIBarButtonItem(title: "Request controls", menu: UIMenu(children: [
      UIAction(title: "Resolve target") { [weak self] _ in self?.fixture.request(questions: false) },
      UIAction(title: "Remote answer") { [weak self] _ in self?.fixture.resolve() },
      UIAction(title: "Replace during send") { [weak self] _ in self?.fixture.replacement() },
      UIAction(title: "Suspend") { [weak self] _ in self?.fixture.suspend() },
      UIAction(title: "Resume") { [weak self] _ in self?.fixture.resume() },
    ]))
  }
}
