import LodyCore
import UIKit

@MainActor
final class PermissionQuestionView: UIView {
  private struct Draft {
    var labels: [String] = []
    var text = ""
    var answered: Bool { !text.isEmpty || !labels.isEmpty }
  }

  private let meta: SessionPermission.Questions
  private let list = LodyGroupedList(frame: .zero)
  private let submit = UIButton(type: .system)
  private let error = UILabel()
  private var drafts: [Draft]
  private var page = 0
  private var busy = false
  var onSubmit: (([String: RuntimeContract.JSONValue]) -> Void)?
  var prompt: ((UIAlertController) -> Void)?

  init(meta: SessionPermission.Questions) {
    self.meta = meta
    drafts = meta.questions.map { _ in Draft() }
    super.init(frame: .zero)
    list.accessibilityIdentifier = "question-list"
    list.setSegmentsStyle("steps")
    if meta.questions.count > 1 { list.setSegments(meta.questions.map(\.header)) }
    list.forwarded = { [weak self] event, body in
      guard let self, !busy else { return }
      if event == "segmentChange", let index = body["index"] as? Int {
        page = index
        render()
      } else if event == "rowPress", let id = body["id"] as? String {
        choose(id)
      }
    }
    error.numberOfLines = 0
    error.font = .preferredFont(forTextStyle: .footnote)
    error.textColor = .systemRed
    error.textAlignment = .center
    submit.configuration = .filled()
    submit.configuration?.cornerStyle = .capsule
    submit.addAction(UIAction { [weak self] _ in self?.advance() }, for: .touchUpInside)
    let footer = UIStackView(arrangedSubviews: [error, submit])
    footer.axis = .vertical
    footer.spacing = 10
    for child in [list, footer] {
      child.translatesAutoresizingMaskIntoConstraints = false
      addSubview(child)
    }
    NSLayoutConstraint.activate([
      list.topAnchor.constraint(equalTo: topAnchor), list.leadingAnchor.constraint(equalTo: leadingAnchor),
      list.trailingAnchor.constraint(equalTo: trailingAnchor), list.bottomAnchor.constraint(equalTo: footer.topAnchor, constant: -12),
      footer.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
      footer.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
      footer.bottomAnchor.constraint(equalTo: safeAreaLayoutGuide.bottomAnchor, constant: -12),
      submit.heightAnchor.constraint(greaterThanOrEqualToConstant: 50),
    ])
    render()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  func update(busy: Bool, error: String) {
    self.busy = busy
    list.isUserInteractionEnabled = !busy
    self.error.text = error
    self.error.isHidden = error.isEmpty
    render()
  }

  private func render() {
    let question = meta.questions[page], draft = drafts[page]
    var rows = question.options.enumerated().map { index, option in
      var row = LodyListRow()
      row.id = "question-option-\(index)"
      row.title = option.label
      row.subtitle = [option.description, option.preview].compactMap { $0 }.joined(separator: "\n")
      row.subtitleMono = option.preview != nil
      row.wrapSubtitle = true
      row.action = !busy
      row.selected = draft.labels.contains(option.label)
      return row
    }
    if meta.allowsText(at: page) {
      var row = LodyListRow()
      row.id = "question-custom"
      row.title = String(localized: String.LocalizationValue(question.options.isEmpty ? "question.custom" : "question.otherAnswer"), bundle: .lody)
      if !draft.text.isEmpty { row.title = question.isSecret == true ? "••••••••" : draft.text }
      row.image = "pencil"
      row.action = !busy
      row.selected = !draft.text.isEmpty
      rows.append(row)
    }
    var section = LodyListSection()
    section.id = "question-\(page)"
    section.header = question.question
    section.headerProminent = true
    section.footer = String(localized: "question.freeText", bundle: .lody)
    if !question.options.isEmpty { section.footer = String(localized: String.LocalizationValue(question.multiSelect ? "question.multiple" : "question.single"), bundle: .lody) }
    section.rows = rows
    list.setSections([section], animated: false)
    list.setSelectedSegment(page)
    list.setSegmentsDone(drafts.map(\.answered))
    let last = page == drafts.count - 1
    submit.accessibilityIdentifier = last ? "question-submit" : "question-next"
    submit.configuration?.title = String(localized: String.LocalizationValue(last ? "question.submit" : "question.next"), bundle: .lody)
    submit.configuration?.showsActivityIndicator = busy
    submit.isEnabled = !busy && (last ? drafts.allSatisfy(\.answered) : draft.answered)
  }

  private func choose(_ id: String) {
    let question = meta.questions[page]
    if id == "question-custom" {
      let index = page
      let alert = UIAlertController(title: question.header, message: question.question, preferredStyle: .alert)
      alert.addTextField {
        $0.isSecureTextEntry = question.isSecret == true
        $0.text = self.drafts[index].text
      }
      alert.addAction(UIAlertAction(title: String(localized: "common.cancel", bundle: .lody), style: .cancel))
      alert.addAction(UIAlertAction(title: String(localized: "common.done", bundle: .lody), style: .default) { [weak self, weak alert] _ in
        guard let self else { return }
        drafts[index] = Draft(text: alert?.textFields?.first?.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "")
        render()
      })
      prompt?(alert)
      return
    }
    guard let index = Int(id.replacingOccurrences(of: "question-option-", with: "")) else { preconditionFailure("Unknown question row: \(id)") }
    let label = question.options[index].label
    var labels = [label]
    if question.multiSelect {
      labels = drafts[page].labels
      if labels.contains(label) { labels.removeAll { $0 == label } } else { labels.append(label) }
    }
    drafts[page] = Draft(labels: labels)
    render()
  }

  private func advance() {
    if page < drafts.count - 1 { page += 1; render(); return }
    var answers: [String: RuntimeContract.JSONValue] = [:]
    for (index, draft) in drafts.enumerated() {
      let key = meta.key(at: index)
      if !draft.text.isEmpty { answers[key] = .string(draft.text) }
      else if meta.questions[index].multiSelect { answers[key] = .array(draft.labels.map { .string($0) }) }
      else { answers[key] = .string(draft.labels[0]) }
    }
    onSubmit?(answers)
  }
}
