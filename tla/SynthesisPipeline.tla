------------------------ MODULE SynthesisPipeline ------------------------
(***************************************************************************)
(* Synthesis attempt pipeline, abstracted from                            *)
(* src/search/synthesis-runner.mjs synthesizeResults + runSynthesisPrompt:*)
(*   build prompt -> spawn child (180s timer, visible-flag env hygiene:  *)
(*   stale GREEDY_SEARCH_VISIBLE is stripped unless visible=true is       *)
(*   passed explicitly) -> parse output -> echo detection: if the         *)
(*   structured payload has engine-summary keys but NO synthesis fields,  *)
(*   the synthesizer echoed the input and the result is discarded.        *)
(*                                                                         *)
(* Single attempt, no fallback to the other synthesizer: any terminal     *)
(* outcome except a clean synthesis is a reported failure.                *)
(***************************************************************************)
EXTENDS Integers

VARIABLES
  phase,     \* "build"|"spawned"|"waiting"|"parsed"|"returned"|"failed"
  childEnv,  \* visible flag the child sees: "set" | "unset"
  requested, \* whether the caller explicitly asked for visible synthesis
  outcome,   \* child result: None | "ok" | "echo" | "badjson" | "timeout" | "crash"
  hasFields, \* parsed payload carries synthesis fields
  hasEngines \* parsed payload carries engine-summary keys (echo shape)

vars == <<phase, childEnv, requested, outcome, hasFields, hasEngines>>

Init ==
  /\ phase = "build"
  /\ childEnv = "unset"
  /\ requested = FALSE
  /\ outcome = "none"
  /\ hasFields = FALSE
  /\ hasEngines = FALSE

\* Spawn with explicit-visible flag Visible \in {TRUE, FALSE}: the child
\* env carries GREEDY_SEARCH_VISIBLE iff explicitly requested.
Spawn(Visible) ==
  /\ phase = "build"
  /\ phase' = "spawned"
  /\ requested' = Visible
  /\ childEnv' = (IF Visible THEN "set" ELSE "unset")
  /\ UNCHANGED <<outcome, hasFields, hasEngines>>

\* Child runs; exactly one terminal outcome arrives (timeout kills first).
ChildResult(o) ==
  /\ phase = "spawned"
  /\ phase' = "waiting"
  /\ outcome' = o
  /\ UNCHANGED <<childEnv, requested, hasFields, hasEngines>>

\* Parse the output.  echo => engine keys without synthesis fields;
\* ok => synthesis fields (possibly alongside engine keys -- mixed).
Parse ==
  /\ phase = "waiting" /\ outcome # "none"
  /\ phase' = "parsed"
  /\ (IF outcome = "echo"
       THEN /\ hasFields' = FALSE
            /\ hasEngines' = TRUE
       ELSE IF outcome = "ok"
         THEN /\ hasFields' = TRUE
              /\ hasEngines' = (outcome = "ok")
         ELSE /\ hasFields' = FALSE
              /\ hasEngines' = FALSE)
  /\ UNCHANGED <<childEnv, requested, outcome>>

\* Echo detection: engine keys WITHOUT synthesis fields => discard.
Finish ==
  /\ phase = "parsed"
  /\ (IF hasEngines /\ ~hasFields
       THEN phase' = "failed"
       ELSE IF outcome \in {"ok"} /\ hasFields
         THEN phase' = "returned"
         ELSE phase' = "failed")
  /\ UNCHANGED <<childEnv, requested, outcome, hasFields, hasEngines>>

\* Terminal sink: reaching returned/failed ends the attempt (explicit so
\* TLC deadlock detection checks for genuine hangs, not clean exits).
Terminated ==
  /\ phase \in {"returned", "failed"}
  /\ UNCHANGED vars

Next ==
     (\E v \in {TRUE, FALSE} : Spawn(v))
  \/ (\E o \in {"ok", "echo", "badjson", "timeout", "crash"} : ChildResult(o))
  \/ Parse
  \/ Finish
  \/ Terminated

Spec == Init /\ [][Next]_vars

----------------------------------------------------------------------------

InvTypeOK ==
  /\ phase \in {"build", "spawned", "waiting", "parsed", "returned", "failed"}
  /\ childEnv \in {"set", "unset"}
  /\ requested \in BOOLEAN
  /\ outcome \in {"none", "ok", "echo", "badjson", "timeout", "crash"}
  /\ hasFields \in BOOLEAN
  /\ hasEngines \in BOOLEAN

\* An echoed input is never returned as a synthesis.
InvEchoNeverReturned == phase = "returned" => ~(hasEngines /\ ~hasFields)

\* The child never inherits a stale visible flag: after spawn, the flag
\* the child sees agrees exactly with the caller's explicit request.
InvEnvHygiene ==
  phase # "build" => (childEnv = "set" <=> requested)

\* Termination is structural (the phase graph is a DAG: every phase has an
\* enabled successor until returned/failed), so it is checked with TLC's
\* deadlock detection ON rather than a state invariant: any non-terminal
\* state with no successor would be a genuine hang.

=============================================================================
\* Modification History
\* Created 2026-08 (engine-removal session, third modeling round)
=============================================================================
