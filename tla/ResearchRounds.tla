---------------------------- MODULE ResearchRounds ----------------------------
(***************************************************************************)
(* Iterative round control, abstracted from src/search/research.mjs:       *)
(*   - per round r: roundBreadth = max(1, ceil(B / 2^r))                   *)
(*   - round 0: the original query is unshifted into the plan              *)
(*   - plan path: parseActionPlan caps VALIDATED actions at roundBreadth;  *)
(*     invalid planner output is dropped (under-plan possible)             *)
(*   - exception path: normalizeResearchQueries(null, q, roundBreadth,     *)
(*     {includeOriginal: r = 0, exclude: usedQueries}) -- later rounds get *)
(*     only the 4 fixed expansion angles minus already-used queries       *)
(*   - novelty gate drops anything already in usedQueries; the round runs  *)
(*     slice(0, roundBreadth)                                              *)
(*   - leftovers carry forward only if they meet next round's breadth      *)
(*     (activeActions = nextBreadth-met ? carry : null)                    *)
(*                                                                         *)
(* Checked: can a round execute ZERO actions (fallback starvation via      *)
(* dedupe exhaustion), and does carry-forward ever skip a needed re-plan?  *)
(***************************************************************************)
EXTENDS Integers, FiniteSets

CONSTANT
  Breadth,    \* user breadth for the model scope
  Iters       \* user iterations for the model scope

None == "none"

\* Query universe: O = original; F1..F4 = the 4 fixed expansion angles;
\* P1..P2 = planner-only queries (never in the fallback pool).
QU == {"O", "F1", "F2", "F3", "F4", "P1", "P2"}
FallbackAngles == {"F1", "F2", "F3", "F4"}

RoundBreadth(r) == IF 2^r >= Breadth THEN 1 ELSE (Breadth + 2^r - 1) \div 2^r

VARIABLES
  round,      \* current round index (0-based); Iters = past the last round
  used,       \* executed search queries (the usedQueries set)
  active,     \* carried/replanned action pool for this round
  havePlan,   \* planner output arrived this round (vs exception path)
  planned,    \* validated planned queries (subset incl. empty)
  executed,   \* queries actually executed this round
  roundsRun,  \* completed rounds (the floor's roundsRun counter)
  emptyCount, \* completed rounds that executed zero actions
  attempted,  \* planning was attempted this round (excludes skipping work)
  ran         \* the round body ran (plan consumed + execution attempted)

vars == <<round, used, active, havePlan, planned, executed, roundsRun, emptyCount, attempted, ran>>

Init ==
  /\ round = 0
  /\ used = {}
  /\ active = {}
  /\ havePlan = FALSE
  /\ planned = {}
  /\ executed = {}
  /\ roundsRun = 0
  /\ emptyCount = 0
  /\ attempted = FALSE
  /\ ran = FALSE

\* Planner returns (any subset: Gemini may under-plan, even empty).
PlanArrives(S) ==
  /\ round < Iters /\ ~havePlan
  /\ planned' = S
  /\ havePlan' = TRUE
  /\ attempted' = TRUE
  /\ UNCHANGED <<round, used, active, executed, roundsRun, emptyCount, ran>>

\* Planner throws: the fallback pool becomes the plan.  Round 0 includes
\* the original query (includeOriginal); later rounds get only the fixed
\* expansion angles.  Dedupe against usedQueries happens at execute time.
PlanFails ==
  /\ round < Iters /\ ~havePlan
  /\ havePlan' = TRUE
  /\ planned' = (IF round = 0 THEN FallbackAngles \cup {"O"} ELSE FallbackAngles)
  /\ attempted' = TRUE
  /\ UNCHANGED <<round, used, active, executed, roundsRun, emptyCount, ran>>

\* Round 0: original query unshifted into the plan path pool.
\* (Fallback path already includes it via includeOriginal.)
UsePlan ==
  /\ round < Iters /\ havePlan
  /\ active' = (IF round = 0 THEN planned \cup {"O"} ELSE planned)
  /\ havePlan' = FALSE
  /\ UNCHANGED <<round, used, planned, executed, roundsRun, emptyCount, attempted, ran>>

\* Execute: novelty gate drops used queries, slice to roundBreadth.
\* Workers execute a non-empty pool (a non-empty roundActions always
\* spawns workers); the empty-pool case is the separate ExecuteEmpty.
Execute(S) ==
  /\ round < Iters
  /\ attempted /\ ~havePlan /\ ~ran
  /\ S \subseteq (active \ used)
  /\ S # {}
  /\ Cardinality(S) <= RoundBreadth(round)
  /\ executed' = S
  /\ used' = used \cup S
  /\ ran' = TRUE
  /\ UNCHANGED <<round, active, havePlan, planned, roundsRun, emptyCount, attempted>>

\* Genuine starvation: the novel pool is empty (fallback dedupe
\* exhaustion or an empty/used-only plan through the novelty gate).
ExecuteEmpty ==
  /\ round < Iters
  /\ attempted /\ ~havePlan /\ ~ran
  /\ active \ used = {}
  /\ executed' = {}
  /\ ran' = TRUE
  /\ UNCHANGED <<round, used, active, havePlan, planned, roundsRun, emptyCount, attempted>>

\* Round completes (planning was attempted -- rounds cannot be skipped).
FinishRound ==
  /\ round < Iters
  /\ attempted /\ ran
  /\ roundsRun' = roundsRun + 1
  /\ emptyCount' = emptyCount + (IF executed = {} THEN 1 ELSE 0)
  /\ round' = round + 1
  /\ active' = {}
  /\ executed' = {}
  /\ attempted' = FALSE
  /\ ran' = FALSE
  /\ UNCHANGED <<used, havePlan, planned>>

Next ==
     (\E S \in SUBSET (QU) : PlanArrives(S))
  \/ PlanFails
  \/ UsePlan
  \/ (\E S \in SUBSET (QU) : Execute(S))
  \/ ExecuteEmpty
  \/ FinishRound

Spec == Init /\ [][Next]_vars

----------------------------------------------------------------------------

InvTypeOK ==
  /\ round \in 0..Iters
  /\ used \subseteq QU
  /\ active \subseteq QU
  /\ planned \subseteq QU
  /\ executed \subseteq QU
  /\ roundsRun \in 0..Iters
  /\ emptyCount \in 0..Iters
  /\ attempted \in BOOLEAN
  /\ ran \in BOOLEAN

\* Every executed round runs at least one action.  Fallback starvation:
\* after enough rounds all fixed angles are used, and a later planning
\* exception yields an empty pool -- the round still counts toward the
\* floor's roundsRun.  (parseActionPlan path included: an empty/used-only
\* plan plus the novelty gate can also empty a round.)
InvRoundsNonEmpty == emptyCount = 0

=============================================================================
\* Modification History
\* Created 2026-08 (engine-removal session, third modeling round)
=============================================================================
