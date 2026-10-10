---------------------------- MODULE TabOwnership ----------------------------
(***************************************************************************)
(* Foreground-slot ownership in all-mode parallel extraction.              *)
(* Abstracted from extractors/chatgpt.mjs + extractors/gemini.mjs:         *)
(*   - each brings its tab to the front (Page.bringToFront) when its       *)
(*     stream wait starts (required at start, then a capped keepalive      *)
(*     loop: at most 8 foreground attempts per stream wait)                *)
(*   - the foreground is a GLOBAL browser slot: exactly one tab holds it   *)
(*   - a stream wait makes progress only while its tab is foregrounded     *)
(*     (background tabs get throttled and can stall -- the shipped         *)
(*     "citation/header stub" incident class from AGENTS.md)               *)
(*                                                                         *)
(* Checked property: with two foreground-requiring extractors in one       *)
(* fan-out, can mutual foreground-stealing exhaust both keepalive          *)
(* budgets and stall an extractor?  TLC says yes.                          *)
(***************************************************************************)
EXTENDS Integers

CONSTANT Extractor

None == "none"
MaxAttempts == 8

VARIABLES
  fg,       \* which extractor's tab is foregrounded (None = nobody)
  phase,    \* per-extractor: "nav" | "stream" | "extract" | "done"
  budget,   \* per-extractor remaining foreground keepalive attempts
  stalled   \* extractors whose stream wait gave up

vars == <<fg, phase, budget, stalled>>

Init ==
  /\ fg = None
  /\ phase = [e \in Extractor |-> "nav"]
  /\ budget = [e \in Extractor |-> MaxAttempts]
  /\ stalled = {}

\* Stream wait starts: tab brought to front (required at start).
StartStream(e) ==
  /\ phase[e] = "nav"
  /\ phase' = [phase EXCEPT ![e] = "stream"]
  /\ fg' = e
  /\ UNCHANGED <<budget, stalled>>

\* Foreground keepalive: skipped if already front (real code also skips
\* when one is in flight); capped at MaxAttempts.
KeepAlive(e) ==
  /\ phase[e] = "stream"
  /\ fg # e
  /\ budget[e] > 0
  /\ budget' = [budget EXCEPT ![e] = budget[e] - 1]
  /\ fg' = e
  /\ UNCHANGED <<phase, stalled>>

\* The stream completes while this tab is foregrounded.
Progress(e) ==
  /\ phase[e] = "stream"
  /\ fg = e
  /\ phase' = [phase EXCEPT ![e] = "extract"]
  /\ UNCHANGED <<fg, budget, stalled>>

\* Done extracting (releases no token explicitly -- real code has no
\* release call; the foreground is simply stolen by the next waiter).
Finish(e) ==
  /\ phase[e] = "extract"
  /\ phase' = [phase EXCEPT ![e] = "done"]
  /\ UNCHANGED <<fg, budget, stalled>>

\* The stream wait times out on a throttled background tab after the
\* keepalive budget is exhausted -- the "stub" failure shape.
Stall(e) ==
  /\ phase[e] = "stream"
  /\ fg # e
  /\ budget[e] = 0
  /\ stalled' = stalled \cup {e}
  /\ phase' = [phase EXCEPT ![e] = "done"]
  /\ UNCHANGED <<fg, budget>>

Next ==
     (\E e \in Extractor : StartStream(e))
  \/ (\E e \in Extractor : KeepAlive(e))
  \/ (\E e \in Extractor : Progress(e))
  \/ (\E e \in Extractor : Finish(e))
  \/ (\E e \in Extractor : Stall(e))

Spec == Init /\ [][Next]_vars

----------------------------------------------------------------------------

InvTypeOK ==
  /\ fg \in Extractor \cup {None}
  /\ phase \in [Extractor -> {"nav", "stream", "extract", "done"}]
  /\ budget \in [Extractor -> 0..MaxAttempts]
  /\ stalled \subseteq Extractor

\* The foreground slot is exclusive by construction -- a single variable.
\* (Present so the peeled-clean run validates the plumbing, not the code.)
InvSingleForeground == fg \in Extractor \cup {None}

\* No extractor's stream wait may stall while the discipline (foreground
\* + capped keepalive) is supposed to protect it.
InvNoStall == stalled = {}

=============================================================================
\* Modification History
\* Created 2026-08 (engine-removal session, second modeling round)
=============================================================================
