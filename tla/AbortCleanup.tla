---------------------------- MODULE AbortCleanup ----------------------------
(***************************************************************************)
(* runSearch child-process lifecycle, abstracted from                      *)
(* src/tools/shared.ts: spawn -> stderr capture -> watchdog timer          *)
(* (timer.unref) -> AbortSignal listener -> settle (resolve/reject) once.  *)
(*                                                                         *)
(* The finished flag guards every settle site (timer, abort, child exit).  *)
(* The stderr 'data' handler has NO such guard: progress parsing runs on   *)
(* every chunk, even chunks that arrive after the promise already settled  *)
(* (SIGTERM is async; buffered output can land between kill and 'close').  *)
(*                                                                         *)
(* Guard = "guarded"   models the shipped code (finished checks present).  *)
(* Guard = "unguarded" models the same code with the finished checks       *)
(*           removed -- a model-level mutation proving the guards are      *)
(*           load-bearing: InvNoDoubleSettle must hold under "guarded"     *)
(*           and fail under "unguarded", while InvNoProgressAfterSettle    *)
(*           fails under BOTH (the real defect shape).                     *)
(***************************************************************************)
EXTENDS Integers

CONSTANT Guard   \* "guarded" | "unguarded"

VARIABLES
  child,       \* "none" | "alive" | "dying" | "exited"
  finished,    \* the settled flag: once TRUE, settle sites must not refire
  settle,      \* "none" | "resolved" | "rejected"
  settleCount, \* number of settle transitions (must be <= 1)
  timer,       \* "armed" | "cleared"
  postSettle   \* progress callback observed after settle

vars == <<child, finished, settle, settleCount, timer, postSettle>>

Init ==
  /\ child = "alive"
  /\ finished = FALSE
  /\ settle = "none"
  /\ settleCount = 0
  /\ timer = "armed"
  /\ postSettle = FALSE

\* Watchdog timer fires (child exceeded GREEDY_SEARCH_TIMEOUT_MS).
TimerFire ==
  /\ timer = "armed"
  /\ (IF finished
       THEN /\ finished' = finished
            /\ settle' = settle
            /\ settleCount' = settleCount
            /\ timer' = "cleared"
            /\ child' = child
       ELSE /\ finished' = TRUE
            /\ settle' = "rejected"
            /\ settleCount' = settleCount + 1
            /\ timer' = "cleared"
            /\ child' = "dying")
  /\ UNCHANGED postSettle

\* AbortSignal fires while the child runs (pi cancels the tool call).
OnAbort ==
  /\ child \in {"alive", "dying"}
  /\ (IF finished /\ Guard = "guarded"
       THEN /\ finished' = finished
            /\ settle' = settle
            /\ settleCount' = settleCount
            /\ timer' = timer
            /\ child' = child
       ELSE /\ finished' = TRUE
            /\ settle' = "rejected"
            /\ settleCount' = settleCount + 1
            /\ timer' = "cleared"
            /\ child' = "dying")
  /\ UNCHANGED postSettle

\* Child process exits on its own (success, failure, or death after kill).
ChildExit ==
  /\ child \in {"alive", "dying"}
  /\ child' = "exited"
  /\ timer' = "cleared"
  /\ (IF finished /\ Guard = "guarded"
       THEN /\ finished' = finished
            /\ settle' = settle
            /\ settleCount' = settleCount
       ELSE /\ finished' = TRUE
            /\ settle' = "resolved"
            /\ settleCount' = settleCount + 1)
  /\ UNCHANGED postSettle

\* A stderr chunk arrives (progress parsing).  The shipped handler has no
\* finished check, so chunks landing after settle still invoke onProgress.
StderrData ==
  /\ child \in {"alive", "dying"}
  /\ (IF finished
       THEN postSettle' = TRUE
       ELSE postSettle' = FALSE)
  /\ UNCHANGED <<child, finished, settle, settleCount, timer>>

Next ==
  \/ TimerFire
  \/ OnAbort
  \/ ChildExit
  \/ StderrData

Spec == Init /\ [][Next]_vars

----------------------------------------------------------------------------

InvTypeOK ==
  /\ child \in {"none", "alive", "dying", "exited"}
  /\ finished \in BOOLEAN
  /\ settle \in {"none", "resolved", "rejected"}
  /\ settleCount \in 0..3
  /\ timer \in {"armed", "cleared"}
  /\ postSettle \in BOOLEAN

\* The promise settles at most once.
InvNoDoubleSettle == settleCount <= 1

\* Progress callbacks must not fire after the call already settled.
InvNoProgressAfterSettle == postSettle = FALSE

=============================================================================
\* Modification History
\* Created 2026-08 (engine-removal session, second modeling round)
=============================================================================
