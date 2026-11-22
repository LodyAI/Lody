import Foundation
import CoreGraphics

@main
enum ViewportLayoutTests {
    static func main() throws {
        let folded = CGRect(x: 0, y: 0, width: 400, height: 800)
        let unfolded = CGRect(x: 0, y: 0, width: 900, height: 600)
        let leftChrome = LodyViewportLayout.contentFrame(in: unfolded, left: 64, right: 12)
        let rightChrome = LodyViewportLayout.contentFrame(in: unfolded, left: 12, right: 64)
        precondition(leftChrome == CGRect(x: 64, y: 0, width: 824, height: 600))
        precondition(rightChrome == CGRect(x: 12, y: 0, width: 824, height: 600))
        precondition(LodyViewportLayout.contentFrame(in: folded, left: 0, right: 0) == folded)
        precondition(LodyViewportLayout.contentFrame(in: folded, left: 500, right: 50).width == 0)

        let viewport = CGRect(x: 84, y: 0, width: 867, height: 669)
        let crease = CGRect(x: 455.5, y: 0, width: 40, height: 669)
        precondition(LodyViewportLayout.verticalDivision(in: viewport, regions: [crease]) ==
                     CGRect(x: 371.5, y: 0, width: 40, height: 669))
        precondition(LodyViewportLayout.verticalDivision(in: viewport, regions: []) == nil)
        precondition(LodyViewportLayout.verticalDivision(in: viewport, regions: [
            CGRect(x: 0, y: 300, width: 951, height: 40)
        ]) == nil)
        precondition(LodyViewportLayout.verticalDivision(in: viewport, regions: [
            CGRect(x: 10, y: 0, width: 50, height: 669)
        ]) == nil)

        let portrait = CGRect(x: 0, y: 0, width: 669, height: 951)
        let horizontal = CGRect(x: 0, y: 455.5, width: 669, height: 40)
        precondition(LodyViewportLayout.horizontalDivision(in: portrait, regions: [horizontal]) == horizontal)
        precondition(LodyViewportLayout.horizontalDivision(in: portrait, regions: [crease]) == nil)
        precondition(LodyViewportLayout.horizontalDivision(in: portrait, regions: []) == nil)
        let offsetViewport = CGRect(x: 0, y: 30, width: 669, height: 900)
        precondition(LodyViewportLayout.horizontalDivision(in: offsetViewport, regions: [horizontal]) ==
                     CGRect(x: 0, y: 425.5, width: 669, height: 40))

        let screen = CGRect(x: 0, y: 0, width: 678, height: 466)
        let camera = CGRect(x: 594, y: 0, width: 84, height: 124)
        // A camera cutout and wide landscape safe area alone do not imply a vertical bar.
        precondition(LodyViewportLayout.sideRailFrame(in: screen, systemHasVerticalBar: false,
            left: 62, right: 62, occlusions: [CGRect(x: 616, y: 0, width: 62, height: 124)],
            bottomLimit: 432, itemCount: 1) == nil)
        let rail = LodyViewportLayout.sideRailFrame(in: screen, systemHasVerticalBar: true, left: 0, right: 84,
                                                    occlusions: [camera], bottomLimit: 432, itemCount: 4)
        precondition(rail == CGRect(x: 614, y: 124, width: 44, height: 200))
        precondition(LodyViewportLayout.sideRailFrame(in: screen, systemHasVerticalBar: true, left: 0, right: 84,
                                                      occlusions: [camera], bottomLimit: 300, itemCount: 4) == nil)
        // A fold further divides the side strip, but cannot by itself enable the rail.
        let horizontalFold = CGRect(x: 0, y: 180, width: 678, height: 40)
        precondition(LodyViewportLayout.sideRailFrame(in: screen, systemHasVerticalBar: true, left: 0, right: 84,
            occlusions: [camera], divisions: [horizontalFold], bottomLimit: 432, itemCount: 4) ==
            CGRect(x: 614, y: 220, width: 44, height: 200))
        precondition(LodyViewportLayout.sideRailFrame(in: screen, systemHasVerticalBar: true, left: 0, right: 84,
            occlusions: [], divisions: [horizontalFold], bottomLimit: 432, itemCount: 1) == nil)
        let leftCamera = CGRect(x: 0, y: 0, width: 84, height: 124)
        precondition(LodyViewportLayout.sideRailFrame(in: screen, systemHasVerticalBar: true, left: 84, right: 0,
                                                      occlusions: [leftCamera], bottomLimit: 432, itemCount: 1)?.minX == 20)
        precondition(LodyViewportLayout.sideRailFrame(in: screen, systemHasVerticalBar: true, left: 0, right: 84,
                                                      occlusions: [], bottomLimit: 432, itemCount: 1) == nil)
        precondition(LodyViewportLayout.sideRailFrame(in: screen, systemHasVerticalBar: true, left: 0, right: 59,
                                                      occlusions: [camera], bottomLimit: 432, itemCount: 1) == nil)
        let oversized = LodyViewportLayout.sideRailFrame(in: screen, systemHasVerticalBar: true, left: 1000, right: 0,
                                                          occlusions: [leftCamera], bottomLimit: 432, itemCount: 1)
        precondition(oversized.map { screen.contains($0) } == true)

        func height(_ viewport: CGRect, _ guide: CGRect, safeArea: CGFloat = 20) -> Int {
            LodyViewportLayout.keyboardHeight(in: viewport, guide: guide, bottomSafeArea: safeArea)
        }
        // The same window can resize while the keyboard remains visible.
        let foldedKeyboard = CGRect(x: 0, y: 500, width: 400, height: 300)
        let unfoldedKeyboard = CGRect(x: 0, y: 300, width: 900, height: 300)
        precondition(height(folded, foldedKeyboard) == 300)
        precondition(height(rightChrome, unfoldedKeyboard) == 300)
        let split = CGRect(x: 450, y: 0, width: 450, height: 600)
        precondition(height(split, unfoldedKeyboard) == 300)
        precondition(height(CGRect(x: 0, y: 0, width: 400, height: 550), foldedKeyboard) == 50)

        // Dismissed/hardware keyboards leave only the home-indicator guide.
        precondition(height(folded, CGRect(x: 0, y: 780, width: 400, height: 20)) == 0)
        precondition(height(folded, .zero, safeArea: 0) == 0)
        precondition(height(folded, CGRect(x: 0, y: 800, width: 400, height: 300)) == 0)
        // Floating keyboards cannot add a full-width bottom inset.
        precondition(height(folded, CGRect(x: 100, y: 500, width: 200, height: 300)) == 0)
        precondition(height(folded, CGRect(x: 0, y: 300, width: 400, height: 300)) == 0)
        precondition(height(folded, CGRect(x: 0, y: 499.75, width: 400, height: 300.25)) == 301)

        // Exercise the actual generated scripts in the renderer bridge tests.
        let scripts = [0, 300, 50, 0].map { LodyViewportLayout.keyboardScript(height: $0) }
        let data = try JSONSerialization.data(withJSONObject: scripts)
        print(String(decoding: data, as: UTF8.self))
    }
}
