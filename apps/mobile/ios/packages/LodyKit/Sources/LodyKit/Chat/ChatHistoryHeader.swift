import UIKit

/// A real scroll-content header, shared by touch and VoiceOver pagination.
final class ChatHistoryHeader: UICollectionReusableView {
  let button = UIButton(type: .system)
  var load: (() -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    button.accessibilityIdentifier = "chat-history"
    button.addAction(UIAction { [weak self] _ in self?.load?() }, for: .touchUpInside)
    addSubview(button)
    button.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      button.centerXAnchor.constraint(equalTo: centerXAnchor),
      button.topAnchor.constraint(equalTo: topAnchor),
      button.bottomAnchor.constraint(equalTo: bottomAnchor),
      button.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 20),
      button.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -20),
    ])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(loading: Bool, hasEarlier: Bool) {
    let key: String
    if loading { key = "native.chat.history.loading" }
    else if hasEarlier { key = "native.chat.history.more" }
    else { key = "native.chat.history.start" }
    let canLoad = hasEarlier && !loading
    var configuration = UIButton.Configuration.plain()
    configuration.title = String(localized: String.LocalizationValue(key), bundle: .lody)
    configuration.baseForegroundColor = canLoad ? .lodyAccent : .secondaryLabel
    configuration.showsActivityIndicator = loading
    configuration.imagePadding = 8
    configuration.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
      var outgoing = incoming
      outgoing.font = UIFont.preferredFont(forTextStyle: .footnote)
      return outgoing
    }
    button.configuration = configuration
    button.isUserInteractionEnabled = canLoad
    button.accessibilityTraits = canLoad ? .button : .staticText
  }
}
