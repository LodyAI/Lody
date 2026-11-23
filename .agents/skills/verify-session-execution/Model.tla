---- MODULE Model ----
EXTENDS Naturals
CONSTANTS FaultA, IsolateRetries, AllowStop, ChartOnly, PermitReplay, DropRetryEvidence, StaleRelease
VARIABLES aAttempted, aRetry, aReleased, aFailureObserved, bArrived, bIntent, bBatch, bWorker, bRunning, bActive, bDispatch, bConsumed, bReleased, paused, stopUsed, scanner, wake, readFoundB, invalidStart
vars == <<aAttempted, aRetry, aReleased, aFailureObserved, bArrived, bIntent, bBatch, bWorker, bRunning, bActive, bDispatch, bConsumed, bReleased, paused, stopUsed, scanner, wake, readFoundB, invalidStart>>
TypeOK == aAttempted \in BOOLEAN
    /\ aRetry \in BOOLEAN
    /\ aReleased \in BOOLEAN
    /\ aFailureObserved \in BOOLEAN
    /\ bArrived \in BOOLEAN
    /\ bIntent \in BOOLEAN
    /\ bBatch \in {"none", "prepared", "submitting", "settled", "unknown", "superseded"}
    /\ bWorker \in BOOLEAN
    /\ bRunning \in BOOLEAN
    /\ bActive \in BOOLEAN
    /\ bDispatch \in 0..2
    /\ bConsumed \in BOOLEAN
    /\ bReleased \in BOOLEAN
    /\ paused \in BOOLEAN
    /\ stopUsed \in BOOLEAN
    /\ scanner \in {"waiting", "retry", "read", "prepare", "launch", "failed"}
    /\ wake \in BOOLEAN
    /\ readFoundB \in BOOLEAN
    /\ invalidStart \in BOOLEAN
Init == aAttempted = FALSE
    /\ aRetry = FALSE
    /\ aReleased = FALSE
    /\ aFailureObserved = FALSE
    /\ bArrived = FALSE
    /\ bIntent = FALSE
    /\ bBatch = "none"
    /\ bWorker = FALSE
    /\ bRunning = FALSE
    /\ bActive = FALSE
    /\ bDispatch = 0
    /\ bConsumed = FALSE
    /\ bReleased = FALSE
    /\ paused = FALSE
    /\ stopUsed = FALSE
    /\ scanner = "waiting"
    /\ wake = TRUE
    /\ readFoundB = FALSE
    /\ invalidStart = FALSE

RecordASettlement == ~aAttempted
    /\ aAttempted' = (TRUE)
    /\ aRetry' = (FaultA)
    /\ wake' = (TRUE)
    /\ UNCHANGED <<aReleased, aFailureObserved, bArrived, bIntent, bBatch, bWorker, bRunning, bActive, bDispatch, bConsumed, bReleased, paused, stopUsed, scanner, readFoundB, invalidStart>>

ReleaseA == aAttempted /\ ~aReleased
    /\ aReleased' = (TRUE)
    /\ wake' = (TRUE)
    /\ bActive' = (IF StaleRelease THEN FALSE ELSE bActive)
    /\ UNCHANGED <<aAttempted, aRetry, aFailureObserved, bArrived, bIntent, bBatch, bWorker, bRunning, bDispatch, bConsumed, bReleased, paused, stopUsed, scanner, readFoundB, invalidStart>>

BResultArrives == ~bArrived /\ (~ChartOnly \/ aReleased)
    /\ bArrived' = (TRUE)
    /\ bIntent' = (~paused)
    /\ UNCHANGED <<aAttempted, aRetry, aReleased, aFailureObserved, bBatch, bWorker, bRunning, bActive, bDispatch, bConsumed, bReleased, paused, stopUsed, scanner, wake, readFoundB, invalidStart>>

Wake == ~wake /\ (aRetry \/ bIntent)
    /\ wake' = (TRUE)
    /\ UNCHANGED <<aAttempted, aRetry, aReleased, aFailureObserved, bArrived, bIntent, bBatch, bWorker, bRunning, bActive, bDispatch, bConsumed, bReleased, paused, stopUsed, scanner, readFoundB, invalidStart>>

TakeWake == wake /\ scanner = "waiting" /\ (~ChartOnly \/ (aReleased /\ bArrived))
    /\ wake' = (FALSE)
    /\ scanner' = ("retry")
    /\ readFoundB' = (FALSE)
    /\ UNCHANGED <<aAttempted, aRetry, aReleased, aFailureObserved, bArrived, bIntent, bBatch, bWorker, bRunning, bActive, bDispatch, bConsumed, bReleased, paused, stopUsed, invalidStart>>

RetryReceipts == scanner = "retry"
    /\ scanner' = (IF aRetry /\ FaultA /\ ~IsolateRetries THEN "failed" ELSE "read")
    /\ aFailureObserved' = (aFailureObserved \/ (aRetry /\ FaultA))
    /\ aRetry' = (IF aRetry /\ (~FaultA \/ DropRetryEvidence) THEN FALSE ELSE aRetry)
    /\ UNCHANGED <<aAttempted, aReleased, bArrived, bIntent, bBatch, bWorker, bRunning, bActive, bDispatch, bConsumed, bReleased, paused, stopUsed, wake, readFoundB, invalidStart>>

ReadPending == scanner = "read"
    /\ readFoundB' = (bIntent)
    /\ scanner' = ("prepare")
    /\ UNCHANGED <<aAttempted, aRetry, aReleased, aFailureObserved, bArrived, bIntent, bBatch, bWorker, bRunning, bActive, bDispatch, bConsumed, bReleased, paused, stopUsed, wake, invalidStart>>

PrepareBatch == scanner = "prepare"
    /\ bBatch' = (IF ~bRunning /\ readFoundB /\ bIntent /\ ~paused /\ bBatch = "none" THEN "prepared" ELSE bBatch)
    /\ scanner' = (IF ~bRunning /\ readFoundB /\ bIntent /\ ~paused /\ bBatch \in {"none", "prepared"} THEN "launch" ELSE "waiting")
    /\ UNCHANGED <<aAttempted, aRetry, aReleased, aFailureObserved, bArrived, bIntent, bWorker, bRunning, bActive, bDispatch, bConsumed, bReleased, paused, stopUsed, wake, readFoundB, invalidStart>>

LaunchWorker == scanner = "launch"
    /\ bWorker' = (TRUE)
    /\ bRunning' = (TRUE)
    /\ scanner' = ("waiting")
    /\ UNCHANGED <<aAttempted, aRetry, aReleased, aFailureObserved, bArrived, bIntent, bBatch, bActive, bDispatch, bConsumed, bReleased, paused, stopUsed, wake, readFoundB, invalidStart>>

BeginB == bWorker /\ ~bActive /\ bBatch = "prepared" /\ ~paused
    /\ bWorker' = (FALSE)
    /\ bActive' = (TRUE)
    /\ UNCHANGED <<aAttempted, aRetry, aReleased, aFailureObserved, bArrived, bIntent, bBatch, bRunning, bDispatch, bConsumed, bReleased, paused, stopUsed, scanner, wake, readFoundB, invalidStart>>

RejectWorker == bWorker /\ (paused \/ bBatch # "prepared" \/ bActive)
    /\ bWorker' = (FALSE)
    /\ bRunning' = (FALSE)
    /\ UNCHANGED <<aAttempted, aRetry, aReleased, aFailureObserved, bArrived, bIntent, bBatch, bActive, bDispatch, bConsumed, bReleased, paused, stopUsed, scanner, wake, readFoundB, invalidStart>>

SubmitB == bActive /\ bDispatch < 2 /\ ((~paused /\ bBatch = "prepared") \/ (PermitReplay /\ bBatch \in {"submitting", "unknown"}))
    /\ bBatch' = ("submitting")
    /\ bDispatch' = (bDispatch + 1)
    /\ invalidStart' = (invalidStart \/ paused)
    /\ UNCHANGED <<aAttempted, aRetry, aReleased, aFailureObserved, bArrived, bIntent, bWorker, bRunning, bActive, bConsumed, bReleased, paused, stopUsed, scanner, wake, readFoundB>>

SettleB == bBatch = "submitting"
    /\ bBatch' = ("settled")
    /\ bConsumed' = (TRUE)
    /\ bIntent' = (FALSE)
    /\ UNCHANGED <<aAttempted, aRetry, aReleased, aFailureObserved, bArrived, bWorker, bRunning, bActive, bDispatch, bReleased, paused, stopUsed, scanner, wake, readFoundB, invalidStart>>

UnknownB == bBatch = "submitting"
    /\ bBatch' = ("unknown")
    /\ bConsumed' = (TRUE)
    /\ bIntent' = (FALSE)
    /\ UNCHANGED <<aAttempted, aRetry, aReleased, aFailureObserved, bArrived, bWorker, bRunning, bActive, bDispatch, bReleased, paused, stopUsed, scanner, wake, readFoundB, invalidStart>>

ReleaseB == bActive /\ bConsumed
    /\ bActive' = (FALSE)
    /\ bReleased' = (TRUE)
    /\ wake' = (TRUE)
    /\ UNCHANGED <<aAttempted, aRetry, aReleased, aFailureObserved, bArrived, bIntent, bBatch, bWorker, bRunning, bDispatch, bConsumed, paused, stopUsed, scanner, readFoundB, invalidStart>>

ReleaseStoppedB == bActive /\ paused /\ bDispatch = 0
    /\ bActive' = (FALSE)
    /\ bReleased' = (TRUE)
    /\ wake' = (TRUE)
    /\ UNCHANGED <<aAttempted, aRetry, aReleased, aFailureObserved, bArrived, bIntent, bBatch, bWorker, bRunning, bDispatch, bConsumed, paused, stopUsed, scanner, readFoundB, invalidStart>>

EndWorker == bRunning /\ bReleased
    /\ bRunning' = (FALSE)
    /\ UNCHANGED <<aAttempted, aRetry, aReleased, aFailureObserved, bArrived, bIntent, bBatch, bWorker, bActive, bDispatch, bConsumed, bReleased, paused, stopUsed, scanner, wake, readFoundB, invalidStart>>

StopB == AllowStop /\ ~stopUsed
    /\ stopUsed' = (TRUE)
    /\ paused' = (TRUE)
    /\ bIntent' = (FALSE)
    /\ bBatch' = (IF bBatch = "prepared" THEN "superseded" ELSE bBatch)
    /\ UNCHANGED <<aAttempted, aRetry, aReleased, aFailureObserved, bArrived, bWorker, bRunning, bActive, bDispatch, bConsumed, bReleased, scanner, wake, readFoundB, invalidStart>>

EndFailedScan == scanner = "failed"
    /\ scanner' = ("waiting")
    /\ UNCHANGED <<aAttempted, aRetry, aReleased, aFailureObserved, bArrived, bIntent, bBatch, bWorker, bRunning, bActive, bDispatch, bConsumed, bReleased, paused, stopUsed, wake, readFoundB, invalidStart>>

Idle == scanner = "waiting" /\ ~wake /\ ~aRetry /\ ~bIntent /\ aReleased /\ ~bWorker /\ ~bRunning /\ ~bActive
    /\ UNCHANGED <<aAttempted, aRetry, aReleased, aFailureObserved, bArrived, bIntent, bBatch, bWorker, bRunning, bActive, bDispatch, bConsumed, bReleased, paused, stopUsed, scanner, wake, readFoundB, invalidStart>>

Next == RecordASettlement \/ ReleaseA \/ BResultArrives \/ Wake \/ TakeWake \/ RetryReceipts \/ ReadPending \/ PrepareBatch \/ LaunchWorker \/ BeginB \/ RejectWorker \/ SubmitB \/ SettleB \/ UnknownB \/ ReleaseB \/ ReleaseStoppedB \/ EndWorker \/ StopB \/ EndFailedScan \/ Idle
Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ WF_vars(Wake) /\ WF_vars(TakeWake) /\ WF_vars(RetryReceipts) /\ WF_vars(ReadPending) /\ WF_vars(PrepareBatch) /\ WF_vars(LaunchWorker) /\ WF_vars(BeginB) /\ WF_vars(RejectWorker) /\ WF_vars(SubmitB) /\ WF_vars(EndFailedScan)
AtMostOnce == bDispatch <= 1
NoStartAfterStop == ~invalidStart
ConsumedOnlyAfterStart == bConsumed => bDispatch > 0
RetryEvidenceRetained == (FaultA /\ aAttempted) => aRetry
OldReleaseCannotFreeSuccessor == (bDispatch = 1 /\ ~bReleased) => bActive
HealthySessionProgress == (aReleased /\ bIntent /\ ~paused) ~> (bDispatch = 1)
====
