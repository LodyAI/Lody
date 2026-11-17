---- MODULE Delivery ----
EXTENDS Naturals, FiniteSets
CONSTANTS LoseFirst, DurableFailures
VARIABLES body, rpc, receipt, activation, latest, missing, failed, accepted, started, finished, active, badStart
vars == <<body, rpc, receipt, activation, latest, missing, failed, accepted, started, finished, active, badStart>>
TypeOK == body \subseteq 1..2
    /\ rpc \subseteq 1..2
    /\ receipt \subseteq 1..2
    /\ activation \subseteq 1..2
    /\ latest \in 0..2
    /\ missing \in 0..2
    /\ failed \subseteq 1..2
    /\ accepted \subseteq 1..2
    /\ started \subseteq 1..2
    /\ finished \subseteq started
    /\ active \in 0..2
    /\ badStart \in BOOLEAN
Init == body = {}
    /\ rpc = {}
    /\ receipt = {}
    /\ activation = {}
    /\ latest = 0
    /\ missing = 0
    /\ failed = {}
    /\ accepted = {}
    /\ started = {}
    /\ finished = {}
    /\ active = 0
    /\ badStart = FALSE

Blocked(i) == i = missing \/ (DurableFailures /\ i \in failed)
Source(i) == i \in body \/ i \in rpc

Body(i) == (i \notin body /\ (~LoseFirst \/ i # 1))
    /\ body' = (body \cup {i})
    /\ UNCHANGED <<rpc, receipt, activation, latest, missing, failed, accepted, started, finished, active, badStart>>

Rpc(i) == (i \notin rpc /\ (~LoseFirst \/ i # 1))
    /\ rpc' = (rpc \cup {i})
    /\ UNCHANGED <<body, receipt, activation, latest, missing, failed, accepted, started, finished, active, badStart>>

Receipt(i) == (i \notin receipt)
    /\ receipt' = (receipt \cup {i})
    /\ UNCHANGED <<body, rpc, activation, latest, missing, failed, accepted, started, finished, active, badStart>>

Activation(i) == (i \notin activation)
    /\ activation' = (activation \cup {i})
    /\ latest' = (IF i > latest THEN i ELSE latest)
    /\ UNCHANGED <<body, rpc, receipt, missing, failed, accepted, started, finished, active, badStart>>

Expire == (latest # 0 /\ ~Source(latest) /\ latest \notin failed /\ latest \notin accepted)
    /\ missing' = (latest)
    /\ failed' = (failed \cup {latest})
    /\ UNCHANGED <<body, rpc, receipt, activation, latest, accepted, started, finished, active, badStart>>

Accept(i) == (Source(i) /\ i \in receipt /\ ~Blocked(i) /\ i \notin accepted /\ (latest # 0 \/ rpc # {}))
    /\ accepted' = (accepted \cup {i})
    /\ UNCHANGED <<body, rpc, receipt, activation, latest, missing, failed, started, finished, active, badStart>>

Start(i) == (active = 0 /\ i \in accepted /\ i \notin started /\ ~Blocked(i))
    /\ started' = (started \cup {i})
    /\ active' = (i)
    /\ badStart' = (badStart \/ i \in failed)
    /\ UNCHANGED <<body, rpc, receipt, activation, latest, missing, failed, accepted, finished>>

Finish == (active # 0)
    /\ finished' = (finished \cup {active})
    /\ active' = (0)
    /\ UNCHANGED <<body, rpc, receipt, activation, latest, missing, failed, accepted, started, badStart>>

Done == (\A i \in 1..2 : (i \in finished \/ i \in failed \/ (LoseFirst /\ i = 1)))
    /\ UNCHANGED <<body, rpc, receipt, activation, latest, missing, failed, accepted, started, finished, active, badStart>>

Next == (\E i \in 1..2 : Body(i) \/ Rpc(i) \/ Receipt(i) \/ Activation(i) \/ Accept(i) \/ Start(i)) \/ Expire \/ Finish \/ Done
Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ (\A i \in 1..2 : WF_vars(Body(i))) /\ (\A i \in 1..2 : WF_vars(Rpc(i))) /\ (\A i \in 1..2 : WF_vars(Receipt(i))) /\ (\A i \in 1..2 : WF_vars(Activation(i))) /\ (\A i \in 1..2 : WF_vars(Accept(i))) /\ (\A i \in 1..2 : WF_vars(Start(i))) /\ (WF_vars(Expire)) /\ (WF_vars(Finish))
ReceiptBeforeStart == started \subseteq receipt
PayloadBeforeStart == started \subseteq (body \cup rpc)
NoFailedReplay == ~badStart
HealthySecondProgress == <> (2 \in finished \/ 2 \in failed)
EveryInputOutcome == <> (\A i \in 1..2 : i \in finished \/ i \in failed)

====
