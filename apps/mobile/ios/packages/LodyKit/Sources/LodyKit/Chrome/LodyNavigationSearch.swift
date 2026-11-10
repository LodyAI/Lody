import UIKit

@MainActor
final class LodyNavigationSearch: NSObject, UISearchBarDelegate, UISearchResultsUpdating, UISearchControllerDelegate {
  struct Config: Decodable, Equatable {
    var placeholder: String?
    var placement: String?
    var hideWhenScrolling: Bool?
    var autoCapitalize: String?
    var obscureBackground: Bool?
    var hideNavigationBar: Bool?
    var allowToolbarIntegration: Bool?
  }

  struct Command: Decodable {
    var token: Int
    var action: String
  }

  let controller = UISearchController(searchResultsController: nil)
  var emit: ((String, String) -> Void)?
  private(set) var config = Config()
  private var lastCommand = 0
  /// The text last reported through `change`. UIKit clears the field without calling
  /// `textDidChange` when it dismisses the controller (e.g. the iOS 26 integrated button
  /// collapsing, or a pushed page), so every path re-syncs against the bar instead.
  private(set) var reportedText = ""

  override init() {
    super.init()
    controller.searchBar.delegate = self
    controller.searchResultsUpdater = self
    controller.delegate = self
  }

  var placement: UINavigationItem.SearchBarPlacement {
    let placements: [String: UINavigationItem.SearchBarPlacement] = [
      "stacked": .stacked,
      "inline": .integrated,
      "integrated": .integrated,
      "integratedButton": .integratedButton,
      "integratedCentered": .integratedCentered,
    ]
    return placements[config.placement ?? ""] ?? .automatic
  }

  var hidesWhenScrolling: Bool { config.hideWhenScrolling ?? true }
  var allowsToolbarIntegration: Bool { placement != .stacked && config.allowToolbarIntegration != false }

  func configure(_ next: Config) {
    config = next
    let bar = controller.searchBar
    bar.placeholder = next.placeholder
    let capitalization: [String: UITextAutocapitalizationType] = [
      "none": .none, "words": .words, "sentences": .sentences, "characters": .allCharacters,
    ]
    if let value = next.autoCapitalize.flatMap({ capitalization[$0] }) { bar.autocapitalizationType = value }
    if let value = next.obscureBackground { controller.obscuresBackgroundDuringPresentation = value }
    if let value = next.hideNavigationBar { controller.hidesNavigationBarDuringPresentation = value }
  }

  func perform(_ command: Command) {
    guard command.token > lastCommand else { return }
    lastCommand = command.token
    let bar = controller.searchBar
    switch command.action {
    case "focus": bar.becomeFirstResponder()
    case "blur": bar.resignFirstResponder()
    case "clearText":
      bar.text = ""
      reportChange()
    case "cancelSearch":
      searchBarCancelButtonClicked(bar)
      controller.isActive = false
    default: break
    }
  }

  func searchBarTextDidBeginEditing(_ searchBar: UISearchBar) {
    emit?("focus", searchBar.text ?? "")
  }

  func searchBarTextDidEndEditing(_ searchBar: UISearchBar) {
    emit?("blur", searchBar.text ?? "")
  }

  func searchBar(_ searchBar: UISearchBar, textDidChange searchText: String) {
    reportChange()
  }

  func searchBarSearchButtonClicked(_ searchBar: UISearchBar) {
    emit?("submit", searchBar.text ?? "")
  }

  func searchBarCancelButtonClicked(_ searchBar: UISearchBar) {
    searchBar.text = ""
    searchBar.resignFirstResponder()
    emit?("cancel", "")
    reportChange()
  }

  func updateSearchResults(for searchController: UISearchController) {
    reportChange()
  }

  func didDismissSearchController(_ searchController: UISearchController) {
    reportChange()
    if reportedText.isEmpty { emit?("cancel", "") }
  }

  /// Reports the bar's current text once per distinct value, whichever UIKit path changed it.
  private func reportChange() {
    let text = controller.searchBar.text ?? ""
    guard text != reportedText else { return }
    reportedText = text
    emit?("change", text)
  }
}
