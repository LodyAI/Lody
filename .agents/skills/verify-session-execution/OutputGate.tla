---- MODULE OutputGate ----
EXTENDS Naturals
CONSTANTS HookHangs, CancelReleases, DeadlineReleases, FenceLateWrite, AbortOnDeadline
VARIABLES phase, hook, timer, disposed, output, aborted, staleWrite, metadata
vars == <<phase, hook, timer, disposed, output, aborted, staleWrite, metadata>>
TypeOK == /\ phase \in {"waiting", "opening", "open"}
          /\ hook \in {"idle", "waiting", "done"}
          /\ timer \in BOOLEAN /\ disposed \in BOOLEAN
          /\ output \in BOOLEAN /\ aborted \in BOOLEAN /\ staleWrite \in BOOLEAN /\ metadata \in BOOLEAN
Init == /\ phase = "waiting" /\ hook = "idle" /\ timer = TRUE
        /\ disposed = FALSE /\ output = FALSE /\ aborted = FALSE /\ staleWrite = FALSE /\ metadata = FALSE
ObserveHistory == /\ phase = "waiting"
                  /\ phase' = "opening" /\ hook' = "waiting"
                  /\ timer' = IF DeadlineReleases THEN timer ELSE FALSE
                  /\ UNCHANGED <<disposed, output, aborted, staleWrite, metadata>>
Deadline == /\ timer
            /\ timer' = FALSE
            /\ phase' = IF DeadlineReleases THEN "open" ELSE "opening"
            /\ hook' = IF hook = "idle" THEN "waiting" ELSE hook
            /\ aborted' = (aborted \/ AbortOnDeadline)
            /\ UNCHANGED <<disposed, output, staleWrite, metadata>>
HookCompletes == /\ hook = "waiting" /\ ~HookHangs
                 /\ hook' = "done" /\ phase' = "open" /\ timer' = FALSE
                 /\ staleWrite' = (staleWrite \/ (disposed /\ ~FenceLateWrite))
                 /\ metadata' = (metadata \/ ~aborted \/ ~FenceLateWrite)
                 /\ UNCHANGED aborted
                 /\ UNCHANGED <<disposed, output>>
Dispose == /\ ~disposed
           /\ disposed' = TRUE /\ timer' = FALSE
           /\ phase' = IF CancelReleases \/ phase = "waiting" THEN "open" ELSE phase
           /\ aborted' = (aborted \/ CancelReleases \/ phase = "waiting")
           /\ UNCHANGED <<hook, output, staleWrite, metadata>>
WriteOutput == /\ phase = "open" /\ ~output
               /\ output' = TRUE
               /\ UNCHANGED <<phase, hook, timer, disposed, aborted, staleWrite, metadata>>
Done == /\ output /\ phase = "open"
        /\ UNCHANGED vars
Next == ObserveHistory \/ Deadline \/ HookCompletes \/ Dispose \/ WriteOutput \/ Done
Spec == Init /\ [][Next]_vars
\* Progress must not depend on a user eventually pressing Stop.
FairSpec == Spec /\ WF_vars(Deadline) /\ WF_vars(HookCompletes) /\ WF_vars(WriteOutput)
ReleasedFlagConsistent == phase = "open" => ~timer
NoLateWrites == ~staleWrite
LiveCallbackKeepsMetadata == hook = "done" /\ ~disposed => metadata
OutputEventuallyUnblocked == <> (phase = "open")
DisposeUnblocks == disposed ~> (phase = "open")
DeadlineUnblocks == ~timer ~> (phase = "open")
====
