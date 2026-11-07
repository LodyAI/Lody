import ChatKit
import UIKit

@MainActor func advance(_ seconds: Double) {
  RunLoop.main.run(until: Date().addingTimeInterval(seconds))
}

let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
window.isHidden = false
let container = UIVisualEffectView(effect: UIGlassContainerEffect())
container.frame = window.bounds
window.addSubview(container)
let glass = CKGlassSurface(interactive: true)
glass.frame = CGRect(x: 20, y: 100, width: 200, height: 44)
container.contentView.addSubview(glass)
var hides = 0
glass.onHidden = { hides += 1 }
glass.setVisible(true, animated: false)
precondition(!glass.isHidden && glass.effect is UIGlassEffect)
glass.setVisible(false)
precondition(!glass.isHidden && !glass.isUserInteractionEnabled && glass.accessibilityElementsHidden,
  "Exit must keep the material mounted but stop accepting input immediately")
advance(0.1)
glass.setVisible(true)
advance(0.5)
precondition(hides == 0 && !glass.isHidden && glass.effect is UIGlassEffect && glass.contentView.alpha == 1,
  "Reversed exit: hides=\(hides), hidden=\(glass.isHidden), effect=\(String(describing: glass.effect)), content=\(glass.contentView.alpha), animating=\(glass.isTransitioning)")
glass.setVisible(false)
advance(0.5)
precondition(hides == 1 && glass.isHidden && glass.effect == nil)
glass.setVisible(true)
glass.setVisible(false)
advance(0.5)
precondition(glass.isHidden && !glass.isTransitioning, "A same-turn reversal must settle hidden")
glass.setVisible(true, animated: false)
glass.setVisible(false)
glass.removeFromSuperview()
precondition(glass.isHidden && !glass.isTransitioning && glass.effect == nil,
  "Unmounting must settle the pending exit")
container.contentView.addSubview(glass)
glass.setVisible(true)
UIView.performWithoutAnimation { glass.setVisible(false) }
precondition(glass.isHidden && !glass.isTransitioning && glass.effect == nil,
  "Disabled animations must finish synchronously")
print("Glass: retained exit, interaction gating, reversal, same-turn reversal, detach and no-animation passed")
