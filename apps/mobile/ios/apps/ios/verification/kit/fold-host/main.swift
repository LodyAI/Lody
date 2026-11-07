import UIKit

extension UIColor {
  static var lodyBackground: UIColor { .systemBackground }
}

#if compiler(>=6.4)
if #available(iOS 27.1, *) {
  let host = LodyFoldHost.make(onLayout: {})
  precondition(host != nil, "The current SDK must enable the Duo fold host")
  let leading = UIViewController()
  let trailing = UIViewController()
  host!.show(leading: leading, trailing: trailing)
  let arrangement = host!.controller as! UIArrangementViewController
  precondition(arrangement.viewController(for: .primary) === leading)
  precondition(arrangement.viewController(for: .secondary) === trailing)
  host!.show(leading: nil, trailing: nil)
  precondition(leading.parent == nil && trailing.parent == nil)
  print("PASS: Duo panes attach to the fold host and detach for layout transitions")
} else {
  precondition(LodyFoldHost.make(onLayout: {}) == nil)
  print("PASS: older runtimes retain the ordinary split")
}

#else
precondition(LodyFoldHost.make(onLayout: {}) == nil)
print("PASS: older SDKs retain the ordinary split")
#endif
