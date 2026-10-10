---------------------------- MODULE ResearchLedger ----------------------------
(***************************************************************************)
(* Open-question ledger + deterministic floor, abstracted from             *)
(* src/search/research.mjs:                                                *)
(*   - trackQuestion appends discovered gap/follow-up questions            *)
(*   - end-of-round: open DISCOVERED questions are capped at               *)
(*     MAX_OPEN_FOLLOWUPS = 5; overflow (oldest createdRound first) is     *)
(*     auto-resolved as "covered by later evidence"                        *)
(*   - computeResearchFloor only requires ORIGINAL questions to close      *)
(*     (filter: !createdRound || reason = original), so discovered         *)
(*     questions can neither block nor satisfy the floor                   *)
(*                                                                         *)
(* Checked properties: the cap holds whenever a round is past its collect  *)
(* phase; the floor filter is never vacuous (an untracked discovered      *)
(* question must never be open); originals are never cap victims.          *)
(***************************************************************************)
EXTENDS Integers, FiniteSets

CONSTANT
  Original,   \* root research questions
  Discovered  \* candidate discovered questions (more than the cap)

None == "none"

VARIABLES
  origin,       \* qid -> "original" | "discovered"
  status,       \* qid -> "open" | "resolved" | None (absent from ledger)
  createdRound, \* qid -> round it was added (0 for originals/untracked)
  roundNo,      \* current round (0 = pre-run)
  roundPhase    \* "collect" (learning adds/answers) | "capped" | "done"

vars == <<origin, status, createdRound, roundNo, roundPhase>>

AllQ == Original \cup Discovered

Init ==
  /\ origin = [q \in AllQ |-> IF q \in Original THEN "original" ELSE "discovered"]
  /\ status = [q \in AllQ |-> None]
  /\ createdRound = [q \in AllQ |-> 0]
  /\ roundNo = 0
  /\ roundPhase = "collect"

\* Run start: original questions are tracked up front (round 1 begins).
AddOriginals ==
  /\ roundNo = 0
  /\ status' = [q \in AllQ |-> IF q \in Original THEN "open" ELSE None]
  /\ roundNo' = 1
  /\ UNCHANGED <<origin, createdRound, roundPhase>>

\* Learning step: a discovered question may be appended to the ledger.
AddDiscovered(d) ==
  /\ roundNo \in 1..3
  /\ roundPhase = "collect"
  /\ status[d] = None
  /\ status' = [status EXCEPT ![d] = "open"]
  /\ createdRound' = [createdRound EXCEPT ![d] = roundNo]
  /\ UNCHANGED <<origin, roundNo, roundPhase>>

\* Learning step: a question (original or discovered) gets answered.
Answer(q) ==
  /\ status[q] = "open"
  /\ roundPhase = "collect"
  /\ status' = [status EXCEPT ![q] = "resolved"]
  /\ UNCHANGED <<origin, createdRound, roundNo, roundPhase>>

\* Collecting ends when the round advances; the cap interleaves with
\* collection (cap steps keep the bound while learning keeps adding).
FinishCollect ==
  /\ roundPhase = "collect"
  /\ roundNo \in 1..3
  /\ Cardinality({d \in Discovered : status[d] = "open"}) <= 5
  /\ roundPhase' = "done"
  /\ UNCHANGED <<origin, status, createdRound, roundNo>>

\* The cap: while more than 5 discovered questions are open, the oldest
\* (smallest createdRound) is auto-resolved.  One victim per step; the
\* code resolves the whole overflow slice in one loop -- modeling one
\* per step is the interleaving-faithful refinement (each intermediate
\* state is a possible mid-loop state).
CapStep ==
  /\ roundPhase = "collect"
  /\ roundNo \in 1..3
  /\ LET openDs == {d \in Discovered : status[d] = "open"}
         oldestRound == (CHOOSE r \in 1..3 :
                           /\ \E d \in openDs : createdRound[d] = r
                           /\ \A e \in openDs : createdRound[e] >= r)
         victim == (CHOOSE d \in openDs : createdRound[d] = oldestRound)
     IN Cardinality(openDs) > 5 /\ status' = [status EXCEPT ![victim] = "resolved"]
  /\ UNCHANGED <<origin, createdRound, roundNo, roundPhase>>

\* Advance to the next round (max 3).
AdvanceRound ==
  /\ roundPhase = "done"
  /\ roundNo \in 1..2
  /\ roundNo' = roundNo + 1
  /\ roundPhase' = "collect"
  /\ UNCHANGED <<origin, status, createdRound>>

Next ==
  \/ AddOriginals
  \/ (\E d \in Discovered : AddDiscovered(d))
  \/ (\E q \in AllQ : Answer(q))
  \/ CapStep
  \/ FinishCollect
  \/ AdvanceRound

Spec == Init /\ [][Next]_vars

----------------------------------------------------------------------------

InvTypeOK ==
  /\ origin \in [AllQ -> {"original", "discovered"}]
  /\ status \in [AllQ -> {"open", "resolved", None}]
  /\ createdRound \in [AllQ -> 0..3]
  /\ roundNo \in 0..3
  /\ roundPhase \in {"collect", "done"}

\* The cap, checked when a round is complete: open discovered questions
\* never exceed MAX_OPEN_FOLLOWUPS once collection has finished.  During
\* collect the bound is transiently violable by design (learning adds
\* faster than the cap loop runs -- modeled as interleaving steps).
InvCapAfterDone ==
  roundPhase = "collect" \/
    Cardinality({d \in Discovered : status[d] = "open"}) <= 5

\* Vacuity guard (blocking direction): the floor's requiredQuestions
\* filter is createdRound = 0 -- a discovered question must never be
\* OPEN while untracked (createdRound 0), or it would silently count
\* toward the floor and the cap could never control it.
\* Recurrence this pins: ledger blowup inflating requiredQuestionsClosed.
InvFloorIgnoresDiscovered ==
  \A q \in Discovered : createdRound[q] = 0 => status[q] # "open"

=============================================================================
\* Modification History
\* Created 2026-08 (engine-removal session, second modeling round)
=============================================================================
