import UIKit

let owner = UIViewController()
let firstPage = UIViewController()
let secondPage = UIViewController()
let first = UIScrollView()
let second = UIScrollView()
owner.addChild(firstPage)
owner.addChild(secondPage)
owner.view.addSubview(firstPage.view)
owner.view.addSubview(secondPage.view)
firstPage.view.addSubview(first)
secondPage.view.addSubview(second)

LodyScrollEdges.navigation(first)
precondition(!first.topEdgeEffect.isHidden && first.topEdgeEffect.style == .soft)
precondition(!first.bottomEdgeEffect.isHidden && first.bottomEdgeEffect.style == .soft)
LodyScrollEdges.grouped(second)
precondition(second.topEdgeEffect.style == .soft && second.bottomEdgeEffect.style == .soft)

let chat = UIScrollView()
LodyScrollEdges.chat(chat)
precondition(!chat.topEdgeEffect.isHidden && chat.topEdgeEffect.style == .soft)
precondition(chat.bottomEdgeEffect.isHidden, "Chat replaces the system bottom edge with LodyEdgeFade")

func maskAlpha(_ mask: UIImage, row: Int) -> CGFloat {
  let cgImage = mask.cgImage!
  var pixel: [UInt8] = [0, 0, 0, 0]
  let context = CGContext(data: &pixel, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  context.draw(cgImage, in: CGRect(x: 0, y: row - cgImage.height + 1, width: 1, height: cgImage.height))
  return CGFloat(pixel[3]) / 255
}
let bottomMask = LodyEdgeFade.bottomMask
let bottomRows = bottomMask.cgImage!.height
precondition(maskAlpha(bottomMask, row: 0) < 0.02 && maskAlpha(bottomMask, row: bottomRows - 1) > 0.98,
  "The bottom fade must be clear at its top edge and solid at the bottom")
precondition(bottomMask.capInsets.bottom == 0 && bottomMask.capInsets.top == bottomMask.size.height - 1,
  "Taller bottom fades must stretch only the solid region, keeping the gradient height fixed")
let topMask = LodyEdgeFade.topMask
let topRows = topMask.cgImage!.height
precondition(maskAlpha(topMask, row: 0) > 0.98 && maskAlpha(topMask, row: topRows - 1) < 0.02,
  "The top fade must be solid under the bars and clear at its lower edge")
precondition(topMask.capInsets.top == 0 && topMask.capInsets.bottom == topMask.size.height - 1,
  "Taller top fades must stretch only the solid region, keeping the gradient height fixed")
precondition(!LodyEdgeFade(edge: .top).isUserInteractionEnabled && !LodyEdgeFade().isUserInteractionEnabled,
  "Fades must not intercept content touches")

// A child controller's registration alone is not the outer sheet's contract.
LodyScrollEdges.bind(first, to: firstPage)
LodyScrollEdges.bind(first, to: owner)
precondition(owner.contentScrollView(for: .top) === first)
precondition(owner.contentScrollView(for: .bottom) === first)

// Committing a page change publishes the newly visible list to the sheet.
LodyScrollEdges.bind(second, to: secondPage)
LodyScrollEdges.bind(second, to: owner)
LodyScrollEdges.unbind(first, from: owner)
precondition(owner.contentScrollView(for: .top) === second)
precondition(owner.contentScrollView(for: .bottom) === second,
  "Detaching an old page must not clear the current page's scroll owner")

// Unmounting releases the actual registered page, so a composer cannot retain it.
LodyScrollEdges.unbind(second, from: owner)
precondition(owner.contentScrollView(for: .top) !== second)
precondition(owner.contentScrollView(for: .bottom) !== second)
print("Scroll edges: chat fade, nested-page publication, replacement and guarded cleanup pass")
