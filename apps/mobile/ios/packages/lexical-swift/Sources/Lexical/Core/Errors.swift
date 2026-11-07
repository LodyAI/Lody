/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Foundation

public enum LexicalError: Error {
  case `internal`(String)
  case invariantViolation(String)
  case sanityCheck(errorMessage: String, textViewText: String, fullReconcileText: String)
  case reconciler(String)
  case rangeCacheSearch(String)
}
