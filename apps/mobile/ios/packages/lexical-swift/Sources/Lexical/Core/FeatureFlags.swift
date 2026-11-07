/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Foundation

@objc public final class FeatureFlags: NSObject {
  let reconcilerSanityCheck: Bool
  let proxyTextViewInputDelegate: Bool

  @objc public init(reconcilerSanityCheck: Bool = false, proxyTextViewInputDelegate: Bool = false) {
    self.reconcilerSanityCheck = reconcilerSanityCheck
    self.proxyTextViewInputDelegate = proxyTextViewInputDelegate
    super.init()
  }
}
