# Current finite-model reports

Produced with the pinned pstack statechart tool. Current profiles pass; old broken variants are listed separately below. Display charts are separate restricted projections, not proof bounds.

## safety

# Model

TLC reached 1,112 states, more than the chart budget of 500, so the command wrote no chart.mmd.

## Rules that hold
TypeOK, AtMostOnce, NoStartAfterStop, ConsumedOnlyAfterStart, RetryEvidenceRetained, OldReleaseCannotFreeSuccessor, NoDeadlock

## progress

# Model

TLC reached 459 states and 1197 steps. The chart draws 459 states and 1197 arrows.

## Rules that hold
TypeOK, AtMostOnce, NoStartAfterStop, ConsumedOnlyAfterStart, RetryEvidenceRetained, OldReleaseCannotFreeSuccessor, NoDeadlock, HealthySessionProgress

## control

# Model

TLC reached 459 states and 1197 steps. The chart draws 459 states and 1197 arrows.

## Rules that hold
TypeOK, AtMostOnce, NoStartAfterStop, ConsumedOnlyAfterStart, RetryEvidenceRetained, OldReleaseCannotFreeSuccessor, NoDeadlock, HealthySessionProgress

## delivery-safety

# Model

TLC reached 1,696 states, more than the chart budget of 500, so the command wrote no chart.mmd.

## Rules that hold
TypeOK, NoFailedReplay, ReceiptBeforeStart, PayloadBeforeStart, NoDeadlock

## delivery-progress

# Model

TLC reached 1,696 states, more than the chart budget of 500, so the command wrote no chart.mmd.

## Rules that hold
TypeOK, NoFailedReplay, ReceiptBeforeStart, PayloadBeforeStart, NoDeadlock, EveryInputOutcome

## delivery-partition

# Model

TLC reached 246 states and 809 steps. The chart draws 246 states and 727 arrows.
The chart does not draw 82 steps that stay in one chart state.

## Rules that hold
TypeOK, NoFailedReplay, ReceiptBeforeStart, PayloadBeforeStart, NoDeadlock, HealthySecondProgress

## delivery-negative-ack

# Model

TLC reached 1,696 states, more than the chart budget of 500, so the command wrote no chart.mmd.

## Rules that hold
TypeOK, NoFailedReplay, NoDeadlock

## delivery-durable-control

# Model

TLC reached 1,696 states, more than the chart budget of 500, so the command wrote no chart.mmd.

## Rules that hold
TypeOK, ReceiptBeforeStart, PayloadBeforeStart, NoFailedReplay, NoDeadlock, EveryInputOutcome

## gate-current

# Model

TLC reached 8 states and 13 steps. The chart draws 5 states and 8 arrows.
The chart does not draw 5 steps that stay in one chart state.

## Rules that hold
TypeOK, ReleasedFlagConsistent, NoLateWrites, NoDeadlock, OutputEventuallyUnblocked, DisposeUnblocks, DeadlineUnblocks

## gate-completing

# Model

TLC reached 12 states and 24 steps. The chart draws 12 states and 19 arrows.
The chart does not draw 5 steps that stay in one chart state.

## Rules that hold
TypeOK, ReleasedFlagConsistent, NoLateWrites, NoDeadlock, OutputEventuallyUnblocked, DisposeUnblocks, DeadlineUnblocks

## gate-deadlock

# Model

TLC reached 8 states and 13 steps. The chart draws 8 states and 10 arrows.
The chart does not draw 3 steps that stay in one chart state.

## Rules that hold
TypeOK, ReleasedFlagConsistent, NoLateWrites, NoDeadlock

## gate-cancel-control

# Model

TLC reached 8 states and 13 steps. The chart draws 8 states and 10 arrows.
The chart does not draw 3 steps that stay in one chart state.

## Rules that hold
TypeOK, ReleasedFlagConsistent, NoLateWrites, NoDeadlock, OutputEventuallyUnblocked, DisposeUnblocks, DeadlineUnblocks
