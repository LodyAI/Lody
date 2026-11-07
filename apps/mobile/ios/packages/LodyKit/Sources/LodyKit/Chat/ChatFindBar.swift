import UIKit

final class ChatFindBar: UIView, UITextFieldDelegate {
  let field = UISearchTextField()
  private let count = UILabel()
  private let previous = UIButton(type: .system)
  private let nextButton = UIButton(type: .system)
  private let close = UIButton(type: .system)
  private let scope = UILabel()
  let preferredHeight: CGFloat = 96
  var changed: (() -> Void)?
  var move: ((Int) -> Void)?
  var dismiss: (() -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .lodyBackground
    clipsToBounds = true
    accessibilityIdentifier = "chat-find"
    field.placeholder = String(localized: "native.chat.find.placeholder", bundle: .lody)
    field.accessibilityIdentifier = "chat-find-field"
    field.autocorrectionType = .no
    field.autocapitalizationType = .none
    field.returnKeyType = .search
    field.delegate = self
    field.addTarget(self, action: #selector(textChanged), for: .editingChanged)
    count.font = .preferredFont(forTextStyle: .footnote)
    count.textColor = .secondaryLabel
    count.accessibilityIdentifier = "chat-find-count"
    count.setContentCompressionResistancePriority(.required, for: .horizontal)
    configure(previous, symbol: "chevron.up", key: "previous", action: { [weak self] in self?.move?(-1) })
    configure(nextButton, symbol: "chevron.down", key: "next", action: { [weak self] in self?.move?(1) })
    close.setTitle(String(localized: "native.chat.find.done", bundle: .lody), for: .normal)
    close.accessibilityIdentifier = "chat-find-close"
    close.accessibilityHint = String(localized: "native.chat.find.close", bundle: .lody)
    close.addAction(UIAction { [weak self] _ in self?.dismiss?() }, for: .touchUpInside)
    close.setContentHuggingPriority(.required, for: .horizontal)
    close.setContentCompressionResistancePriority(.required, for: .horizontal)
    let stack = UIStackView(arrangedSubviews: [field, close])
    stack.axis = .horizontal
    stack.spacing = 12
    stack.alignment = .center
    stack.translatesAutoresizingMaskIntoConstraints = false
    addSubview(stack)
    scope.font = .preferredFont(forTextStyle: .caption2)
    scope.textColor = .secondaryLabel
    scope.text = String(localized: "native.chat.find.loadedOnly", bundle: .lody)
    scope.accessibilityIdentifier = "chat-find-scope"
    scope.isHidden = true
    scope.translatesAutoresizingMaskIntoConstraints = false
    let status = UIStackView(arrangedSubviews: [count, scope])
    status.axis = .vertical
    status.spacing = 2
    let results = UIStackView(arrangedSubviews: [status, previous, nextButton])
    results.axis = .horizontal
    results.alignment = .center
    results.spacing = 4
    results.translatesAutoresizingMaskIntoConstraints = false
    addSubview(results)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
      stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
      stack.topAnchor.constraint(equalTo: topAnchor, constant: 4),
      stack.heightAnchor.constraint(equalToConstant: 44),
      field.heightAnchor.constraint(equalToConstant: 44),
      close.widthAnchor.constraint(greaterThanOrEqualToConstant: 44),
      close.heightAnchor.constraint(equalToConstant: 44),
      results.leadingAnchor.constraint(equalTo: stack.leadingAnchor),
      results.trailingAnchor.constraint(equalTo: stack.trailingAnchor),
      results.topAnchor.constraint(equalTo: stack.bottomAnchor),
      results.heightAnchor.constraint(equalToConstant: 44),
    ])
    isHidden = true
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  private func configure(_ button: UIButton, symbol: String, key: String, action: @escaping () -> Void) {
    button.setImage(UIImage(systemName: symbol), for: .normal)
    button.accessibilityIdentifier = "chat-find-" + key
    button.accessibilityLabel = String(localized: String.LocalizationValue("native.chat.find." + key), bundle: .lody)
    button.addAction(UIAction { _ in action() }, for: .touchUpInside)
    button.widthAnchor.constraint(equalToConstant: 44).isActive = true
    button.heightAnchor.constraint(equalToConstant: 44).isActive = true
  }

  func update(current: Int, total: Int, partial: Bool) {
    scope.isHidden = !partial
    count.text = total == 0 ? String(localized: "native.chat.find.noResults", bundle: .lody) : "\(current) / \(total)"
    if field.text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false { count.text = "" }
    count.accessibilityLabel = count.text
    count.accessibilityHint = partial ? String(localized: "native.chat.find.loadedOnly", bundle: .lody) : nil
    field.accessibilityHint = partial ? String(localized: "native.chat.find.loadedOnly", bundle: .lody) : nil
    previous.isEnabled = total > 0
    nextButton.isEnabled = total > 0
  }

  @objc private func textChanged() { changed?() }
  func textFieldShouldReturn(_ textField: UITextField) -> Bool { move?(1); return false }
}
