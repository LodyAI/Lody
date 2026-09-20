/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See vscode-fuzzy-score.LICENSE.txt in this directory.
 *--------------------------------------------------------------------------------------------*/

/**
 * Vendored from Visual Studio Code's `src/vs/base/common/fuzzyScorer.ts`:
 * https://github.com/microsoft/vscode/blob/a92c2f9316d5454e35bb4c2958fdc0f23bc87d5d/src/vs/base/common/fuzzyScorer.ts
 *
 * Lody modification: the small `CharCode` and `isUpper` dependencies used by
 * this scorer are inlined so the browser package does not depend on VS Code's
 * base layer. createFuzzyScoreOnly uses the same recurrence with reusable rows
 * and no position backtracking for file ranking; scoreFuzzy is unchanged.
 */

const CharCode = {
  Space: 32,
  DoubleQuote: 34,
  SingleQuote: 39,
  Dash: 45,
  Period: 46,
  Slash: 47,
  Colon: 58,
  A: 65,
  Z: 90,
  Backslash: 92,
  Underline: 95,
} as const;

function isUpper(code: number): boolean {
  return CharCode.A <= code && code <= CharCode.Z;
}

export type FuzzyScore = [number /* score */, number[] /* match positions */];

const NO_MATCH = 0;
const NO_SCORE: FuzzyScore = [NO_MATCH, []];

export function scoreFuzzy(
  target: string,
  query: string,
  queryLower: string,
  allowNonContiguousMatches: boolean
): FuzzyScore {
  if (!target || !query) {
    return NO_SCORE; // return early if target or query are undefined
  }

  const targetLength = target.length;
  const queryLength = query.length;

  if (targetLength < queryLength) {
    return NO_SCORE; // impossible for query to be contained in target
  }

  const targetLower = target.toLowerCase();
  return doScoreFuzzy(
    query,
    queryLower,
    queryLength,
    target,
    targetLower,
    targetLength,
    allowNonContiguousMatches
  );
}

function doScoreFuzzy(
  query: string,
  queryLower: string,
  queryLength: number,
  target: string,
  targetLower: string,
  targetLength: number,
  allowNonContiguousMatches: boolean
): FuzzyScore {
  const scores: number[] = [];
  const matches: number[] = [];

  //
  // Build Scorer Matrix:
  //
  // The matrix is composed of query q and target t. For each index we score
  // q[i] with t[i] and compare that with the previous score. If the score is
  // equal or larger, we keep the match. In addition to the score, we also keep
  // the length of the consecutive matches to use as boost for the score.
  //
  //      t   a   r   g   e   t
  //  q
  //  u
  //  e
  //  r
  //  y
  //
  for (let queryIndex = 0; queryIndex < queryLength; queryIndex++) {
    const queryIndexOffset = queryIndex * targetLength;
    const queryIndexPreviousOffset = queryIndexOffset - targetLength;

    const queryIndexGtNull = queryIndex > 0;

    const queryCharAtIndex = query[queryIndex];
    const queryLowerCharAtIndex = queryLower[queryIndex];

    for (let targetIndex = 0; targetIndex < targetLength; targetIndex++) {
      const targetIndexGtNull = targetIndex > 0;

      const currentIndex = queryIndexOffset + targetIndex;
      const leftIndex = currentIndex - 1;
      const diagIndex = queryIndexPreviousOffset + targetIndex - 1;

      const leftScore = targetIndexGtNull ? scores[leftIndex] : 0;
      const diagScore = queryIndexGtNull && targetIndexGtNull ? scores[diagIndex] : 0;

      const matchesSequenceLength = queryIndexGtNull && targetIndexGtNull ? matches[diagIndex] : 0;

      // If we are not matching on the first query character any more, we only produce a
      // score if we had a score previously for the last query index (by looking at the diagScore).
      // This makes sure that the query always matches in sequence on the target. For example
      // given a target of "ede" and a query of "de", we would otherwise produce a wrong high score
      // for query[1] ("e") matching on target[0] ("e") because of the "beginning of word" boost.
      let score: number;
      if (!diagScore && queryIndexGtNull) {
        score = 0;
      } else {
        score = computeCharScore(
          queryCharAtIndex,
          queryLowerCharAtIndex,
          target,
          targetLower,
          targetIndex,
          matchesSequenceLength
        );
      }

      // We have a score and its equal or larger than the left score
      // Match: sequence continues growing from previous diag value
      // Score: increases by diag score value
      const isValidScore = score && diagScore + score >= leftScore;
      if (
        isValidScore &&
        // We don't need to check if it's contiguous if we allow non-contiguous matches
        (allowNonContiguousMatches ||
          // We must be looking for a contiguous match.
          // Looking at an index higher than 0 in the query means we must have already
          // found out this is contiguous otherwise there wouldn't have been a score
          queryIndexGtNull ||
          // lastly check if the query is completely contiguous at this index in the target
          targetLower.startsWith(queryLower, targetIndex))
      ) {
        matches[currentIndex] = matchesSequenceLength + 1;
        scores[currentIndex] = diagScore + score;
      }

      // We either have no score or the score is lower than the left score
      // Match: reset to 0
      // Score: pick up from left hand side
      else {
        matches[currentIndex] = NO_MATCH;
        scores[currentIndex] = leftScore;
      }
    }
  }

  // Restore Positions (starting from bottom right of matrix)
  const positions: number[] = [];
  let queryIndex = queryLength - 1;
  let targetIndex = targetLength - 1;
  while (queryIndex >= 0 && targetIndex >= 0) {
    const currentIndex = queryIndex * targetLength + targetIndex;
    const match = matches[currentIndex];
    if (match === NO_MATCH) {
      targetIndex--; // go left
    } else {
      positions.push(targetIndex);

      // go up and left
      queryIndex--;
      targetIndex--;
    }
  }

  return [scores[queryLength * targetLength - 1], positions.reverse()];
}

function computeCharScore(
  queryCharAtIndex: string,
  queryLowerCharAtIndex: string,
  target: string,
  targetLower: string,
  targetIndex: number,
  matchesSequenceLength: number
): number {
  let score = 0;

  if (!considerAsEqual(queryLowerCharAtIndex, targetLower[targetIndex])) {
    return score; // no match of characters
  }

  // Character match bonus
  score += 1;

  // Consecutive match bonus: sequences up to 3 get the full bonus (6)
  // and the remainder gets half the bonus (3). This helps reduce the
  // overall boost for long sequence matches.
  if (matchesSequenceLength > 0) {
    score += Math.min(matchesSequenceLength, 3) * 6 + Math.max(0, matchesSequenceLength - 3) * 3;
  }

  // Same case bonus
  if (queryCharAtIndex === target[targetIndex]) {
    score += 1;
  }

  // Start of word bonus
  if (targetIndex === 0) {
    score += 8;
  } else {
    // After separator bonus
    const separatorBonus = scoreSeparatorAtPos(target.charCodeAt(targetIndex - 1));
    if (separatorBonus) {
      score += separatorBonus;
    }

    // Inside word upper case bonus (camel case). We only give this bonus if we're not in a contiguous sequence.
    // For example:
    // NPE => NullPointerException = boost
    // HTTP => HTTP = not boost
    else if (isUpper(target.charCodeAt(targetIndex)) && matchesSequenceLength === 0) {
      score += 2;
    }
  }

  return score;
}

function considerAsEqual(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }

  // Special case path separators: ignore platform differences
  if (a === '/' || a === '\\') {
    return b === '/' || b === '\\';
  }

  return false;
}

function scoreSeparatorAtPos(charCode: number): number {
  switch (charCode) {
    case CharCode.Slash:
    case CharCode.Backslash:
      return 5; // prefer path separators...
    case CharCode.Underline:
    case CharCode.Dash:
    case CharCode.Period:
    case CharCode.Space:
    case CharCode.SingleQuote:
    case CharCode.DoubleQuote:
    case CharCode.Colon:
      return 4; // ...over other separators
    default:
      return 0;
  }
}

/** Score-only non-contiguous matcher. Each caller owns its reusable scratch rows. */
export function createFuzzyScoreOnly() {
  let previousScores = new Float64Array(0);
  let currentScores = new Float64Array(0);
  let previousMatches = new Float64Array(0);
  let currentMatches = new Float64Array(0);
  return (
    target: string,
    query: string,
    queryLower: string,
    targetLower = target.toLowerCase()
  ): number => {
    if (!target || !query || target.length < query.length) return 0;
    // A subsequence is necessary, including VS Code's interchangeable slashes.
    // Bound by original UTF-16 lengths, exactly as the scoring matrix does.
    let matched = 0;
    for (let i = 0; i < target.length && matched < query.length; i++) {
      if (considerAsEqual(queryLower[matched], targetLower[i])) matched++;
    }
    if (matched < query.length) return 0;
    if (previousScores.length < target.length) {
      const capacity = Math.max(target.length, previousScores.length * 2);
      previousScores = new Float64Array(capacity);
      currentScores = new Float64Array(capacity);
      previousMatches = new Float64Array(capacity);
      currentMatches = new Float64Array(capacity);
    }
    for (let q = 0; q < query.length; q++) {
      for (let t = 0; t < target.length; t++) {
        const left = t > 0 ? currentScores[t - 1] : 0;
        const diagonal = q > 0 && t > 0 ? previousScores[t - 1] : 0;
        const sequence = q > 0 && t > 0 ? previousMatches[t - 1] : 0;
        const score =
          !diagonal && q > 0
            ? 0
            : computeCharScore(query[q], queryLower[q], target, targetLower, t, sequence);
        if (score && diagonal + score >= left) {
          currentScores[t] = diagonal + score;
          currentMatches[t] = sequence + 1;
        } else {
          currentScores[t] = left;
          currentMatches[t] = 0;
        }
      }
      [previousScores, currentScores] = [currentScores, previousScores];
      [previousMatches, currentMatches] = [currentMatches, previousMatches];
    }
    return previousScores[target.length - 1];
  };
}
