import Foundation
import CoreGraphics

/// Geometry stays in the current view's coordinates, including during folds
/// and Split View. Screen dimensions and device idioms cannot describe it.
enum LodyViewportLayout {
    /// Find a vertical strip beside the web content which can hold all actions.
    /// System occlusions and a docked keyboard divide the strip into intervals.
    static func sideRailFrame(in bounds: CGRect, systemHasVerticalBar: Bool, left: CGFloat, right: CGFloat,
                              occlusions: [CGRect], divisions: [CGRect] = [], bottomLimit: CGFloat,
                              itemCount: Int) -> CGRect? {
        let itemHeight: CGFloat = 44
        let gap: CGFloat = 8
        guard systemHasVerticalBar, itemCount > 0, !occlusions.isEmpty else { return nil }
        let content = contentFrame(in: bounds, left: left, right: right)
        let left = content.minX - bounds.minX
        let right = bounds.maxX - content.maxX
        let minimumStripWidth = itemHeight + 16 // 8-point margins around a touch target.
        let useLeft = left >= minimumStripWidth && left >= right
        let stripWidth = useLeft ? left : right
        guard stripWidth >= minimumStripWidth else { return nil }
        let strip = CGRect(x: useLeft ? bounds.minX : bounds.maxX - stripWidth,
                           y: bounds.minY, width: stripWidth,
                           height: max(0, min(bounds.maxY, bottomLimit) - bounds.minY))
        guard occlusions.contains(where: { $0.intersects(strip) }) else { return nil }
        var intervals = [(strip.minY, strip.maxY)]
        for obstruction in (occlusions + divisions) where obstruction.intersects(strip) {
            let start = max(strip.minY, obstruction.minY)
            let end = min(strip.maxY, obstruction.maxY)
            intervals = intervals.flatMap { lo, hi in
                if end <= lo || start >= hi { return [(lo, hi)] }
                return [(lo, min(hi, start)), (max(lo, end), hi)].filter { $0.1 > $0.0 }
            }
        }
        let needed = CGFloat(itemCount) * itemHeight + CGFloat(itemCount - 1) * gap
        guard let interval = intervals.first(where: { $0.1 - $0.0 >= needed }) else { return nil }
        return CGRect(x: strip.midX - itemHeight / 2, y: interval.0,
                      width: itemHeight, height: needed)
    }

    static func contentFrame(in bounds: CGRect, left: CGFloat, right: CGFloat) -> CGRect {
        let leading = min(max(0, left), bounds.width)
        let trailing = min(max(0, right), bounds.width - leading)
        return CGRect(
            x: bounds.minX + leading, y: bounds.minY,
            width: bounds.width - leading - trailing, height: bounds.height
        )
    }

    /// Publish a full-height vertical division in WebView coordinates.
    static func verticalDivision(in viewport: CGRect, regions: [CGRect]) -> CGRect? {
        for region in regions {
            let clipped = viewport.intersection(region)
            guard !clipped.isNull, !clipped.isEmpty,
                  clipped.height >= viewport.height - 1,
                  clipped.width < viewport.width,
                  clipped.minX > viewport.minX, clipped.maxX < viewport.maxX else { continue }
            return CGRect(x: clipped.minX - viewport.minX, y: 0,
                          width: clipped.width, height: viewport.height)
        }
        return nil
    }

    static func horizontalDivision(in viewport: CGRect, regions: [CGRect]) -> CGRect? {
        for region in regions {
            let clipped = viewport.intersection(region)
            guard !clipped.isNull, !clipped.isEmpty,
                  clipped.width >= viewport.width - 1,
                  clipped.height < viewport.height,
                  clipped.minY > viewport.minY, clipped.maxY < viewport.maxY else { continue }
            return CGRect(x: 0, y: clipped.minY - viewport.minY,
                          width: viewport.width, height: clipped.height)
        }
        return nil
    }

    static func divisionScript(_ division: CGRect?, horizontal: CGRect?, viewportWidth: CGFloat,
                               viewportHeight: CGFloat) -> String {
        let value = division.map { "{left: \($0.minX), width: \($0.width), viewportWidth: \(viewportWidth)}" } ?? "null"
        let horizontalValue = horizontal.map { "{top: \($0.minY), height: \($0.height), viewportHeight: \(viewportHeight)}" } ?? "null"
        return """
        window.__LODY_VERTICAL_DIVISION__ = \(value);
        window.__LODY_HORIZONTAL_DIVISION__ = \(horizontalValue);
        window.dispatchEvent(new CustomEvent('lody:division-change'));
        """
    }

    static func keyboardHeight(in viewport: CGRect, guide: CGRect, bottomSafeArea: CGFloat) -> Int {
        let overlap = viewport.intersection(guide)
        // A dismissed/undocked keyboard's guide occupies only the bottom safe
        // area. Floating or partial-width occlusion must not lift the whole UI.
        guard !overlap.isNull, !overlap.isEmpty,
              overlap.maxY >= viewport.maxY - 0.5,
              overlap.width >= viewport.width - 0.5,
              overlap.height > bottomSafeArea + 0.5 else { return 0 }
        return Int(ceil(overlap.height))
    }

    static func keyboardScript(height: Int) -> String {
        """
        window.__LODY_NATIVE_VIEWPORT__ = true;
        (function () {
          var root = document.documentElement;
          if (!root) return;
          var value = '\(height)px';
          if (root.style.getPropertyValue('--native-keyboard-height') === value) return;
          root.style.setProperty('--native-keyboard-height', value);
          window.dispatchEvent(new CustomEvent('lody:keyboard-resize', { detail: { height: \(height) } }));
        })();
        """
    }
}
