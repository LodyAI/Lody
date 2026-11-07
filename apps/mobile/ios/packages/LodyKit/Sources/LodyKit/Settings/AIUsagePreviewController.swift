import UIKit

@MainActor
final class AIUsagePreviewController: AIUsageController {
  private let fixture: AIUsageFixture
  private let probes = UIStackView()
  private let pending = AIUsagePreviewController.probe("usage-week-pending", "Week response pending")
  private let late = AIUsagePreviewController.probe("usage-late-settled", "Late week response delivered")

  init() {
    let fixture = AIUsageFixture()
    self.fixture = fixture
    super.init(workspace: "usage-fixture") { try await fixture.request($0) }
    title = "AI Usage"
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    probes.axis = .vertical
    probes.addArrangedSubview(pending)
    probes.addArrangedSubview(late)
    probes.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(probes)
    NSLayoutConstraint.activate([
      probes.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
      probes.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
      probes.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
    ])
    fixture.onChange = { [weak self] in self?.updateProbes() }
    updateProbes()
  }

  private func updateProbes() {
    pending.isHidden = !fixture.pending
    late.isHidden = !fixture.late
  }

  private static func probe(_ identifier: String, _ text: String) -> UILabel {
    let label = UILabel()
    label.text = text
    label.font = .preferredFont(forTextStyle: .body)
    label.adjustsFontForContentSizeCategory = true
    label.accessibilityIdentifier = identifier
    return label
  }
}

@MainActor
private final class AIUsageFixture {
  var onChange: (() -> Void)?
  private(set) var pending = false
  private(set) var late = false
  private var first = true
  private var dayReads = 0
  private var releaseWeek: CheckedContinuation<Void, Never>?

  isolated deinit { releaseWeek?.resume() }

  func request(_ request: UsageRequest) async throws -> UsageSnapshot {
    if request.range == .day {
      dayReads += 1
      if dayReads == 3 { throw CocoaError(.fileReadUnknown) }
    }
    if first {
      first = false
      throw CocoaError(.fileReadUnknown)
    }
    let result = Self.snapshot(request)
    if request.range == .week {
      pending = true
      onChange?()
      await withCheckedContinuation { releaseWeek = $0 }
    }
    if request.range == .month, let release = releaseWeek {
      releaseWeek = nil
      release.resume()
      pending = false
      late = true
      onChange?()
    }
    return result
  }

  private static func snapshot(_ request: UsageRequest) -> UsageSnapshot {
    let tokens: [UsageRange: Double] = [.day: 12500, .week: 17, .month: 400_000, .total: 0]
    let costs: [UsageRange: Double?] = [.day: nil, .week: 1.25, .month: 1.25, .total: 0]
    let total = tokens[request.range] ?? 0
    let cost = costs[request.range] ?? nil
    let hour = 3_600_000.0
    let start = 1_792_108_800_000.0
    let end = start + 24 * hour
    let day = request.range == .day
    let buckets = day
      ? [2000.0, 500, 6000, 1000, 2500, 500].enumerated().map {
        UsageBucket(bucketStartMs: start + Double($0.offset) * hour, tokens: $0.element, costUSD: nil)
      }
      : [UsageBucket(bucketStartMs: start, tokens: total, costUSD: cost)]
    return UsageSnapshot(
      workspaceId: request.workspaceId,
      range: request.range,
      retrievedAt: end - 1000,
      summary: day ? nil : UsageSummary(totals: UsageTotals(tokens: 999, costUSD: 99)),
      timeline: UsageTimeline(
        totals: UsageTotals(tokens: total, costUSD: cost), startMs: start, endMs: end,
        bucketSizeMs: day ? hour : 24 * hour, buckets: buckets
      ),
      errors: day ? [.summary] : []
    )
  }
}
