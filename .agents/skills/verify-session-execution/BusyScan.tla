---- MODULE BusyScan ----
EXTENDS Naturals, FiniteSets
CONSTANT StopOnBusy
VARIABLES phase, locked, retry, cursor, pending, busyWaits, direct
vars == <<phase, locked, retry, cursor, pending, busyWaits, direct>>
TypeOK == /\ phase \in {"idle", "scanning", "backoff", "closed"}
          /\ locked \in BOOLEAN /\ retry \in BOOLEAN /\ direct \in BOOLEAN
          /\ cursor \in 1..3 /\ pending \subseteq {1,2} /\ busyWaits \in 0..2
Init == /\ phase = "idle" /\ locked = TRUE /\ retry = FALSE
        /\ cursor = 1 /\ pending = {1,2} /\ busyWaits = 0 /\ direct = FALSE
Begin == /\ phase = "idle" /\ pending # {}
         /\ phase' = "scanning" /\ cursor' = 1 /\ busyWaits' = 0
         /\ UNCHANGED <<locked, retry, pending, direct>>
DoWrite == /\ phase = "scanning" /\ cursor \in pending
           /\ IF locked
                 THEN /\ busyWaits' = busyWaits + 1
                      /\ phase' = IF StopOnBusy THEN "backoff" ELSE IF cursor = 2 THEN "idle" ELSE "scanning"
                      /\ retry' = StopOnBusy /\ cursor' = cursor + 1
                      /\ UNCHANGED pending
                 ELSE /\ pending' = pending \ {cursor}
                      /\ cursor' = cursor + 1 /\ phase' = IF cursor = 2 THEN "idle" ELSE "scanning"
                      /\ UNCHANGED <<retry, busyWaits>>
           /\ UNCHANGED <<locked, direct>>
Retry == /\ phase = "backoff" /\ retry
         /\ phase' = "scanning" /\ retry' = FALSE /\ cursor' = 1 /\ busyWaits' = 0
         /\ UNCHANGED <<locked, pending, direct>>
Unlock == /\ locked /\ locked' = FALSE
          /\ UNCHANGED <<phase, retry, cursor, pending, busyWaits, direct>>
DirectInput == /\ ~locked /\ ~direct /\ phase # "closed"
               /\ direct' = TRUE
               /\ UNCHANGED <<phase, locked, retry, cursor, pending, busyWaits>>
Close == /\ phase # "closed" /\ phase' = "closed" /\ retry' = FALSE
         /\ UNCHANGED <<locked, cursor, pending, busyWaits, direct>>
Done == /\ (pending = {} \/ phase = "closed") /\ UNCHANGED vars
Next == Begin \/ DoWrite \/ Retry \/ Unlock \/ DirectInput \/ Close \/ Done
Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ WF_vars(Begin) /\ WF_vars(DoWrite) /\ WF_vars(Retry) /\ WF_vars(Unlock)
NativeBusyWaitBound == busyWaits <= 1
RetainedWhileLocked == locked => pending = {1,2}
ClosedCancelsRetry == phase = "closed" => ~retry
BackoffAllowsDirectInput == phase = "backoff" /\ ~locked /\ ~direct => ENABLED DirectInput
WorkEventuallyResumes == <> (pending = {} \/ phase = "closed")
====
