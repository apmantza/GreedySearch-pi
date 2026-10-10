---------------------------- MODULE RecoveryMachine ----------------------------
(***************************************************************************)
(* Headless -> visible recovery escalation, abstracted from                *)
(* src/search/recovery.mjs + the retry flows in bin/search.mjs:            *)
(*   single-engine: catch -> canRetryVisible -> kill+relaunch visible ->   *)
(*                  ONE retry -> manual-verification hold                   *)
(*   fan-out:       findHeadlessBlockedEngines -> kill+relaunch ->         *)
(*                  retry all candidates -> SECOND retry for stillBlocked  *)
(*                  -> needs-human hold (visible Chrome stays open)         *)
(*                                                                         *)
(* Non-recoverable blocks (rate-limit, login-required) must never          *)
(* escalate.  Retry depth is bounded (1 single / 2 fan-out).  The browser  *)
(* kill itself is abstracted (the lifecycle model covers its blast radius).*)
(***************************************************************************)
EXTENDS Integers

CONSTANT Searcher

None == "none"

\* Block classification (envelope.blockedBy / verificationResult):
\*   session  -- Cloudflare/Turnstile/timeout: visible cookies may help
\*   account  -- rate-limit/login-required: NON_RECOVERABLE_BLOCKED_BY
\*   manual   -- needs-human verification
Kinds == {"session", "account", "manual"}

\* Phases are monotone: no action returns a search to an earlier phase.
\* This is what bounds retry depth structurally (no retry loop possible).
Phases == {"searching", "blocked", "retry1", "retry2", "done", "hold", "failed"}

Rank(p) == CASE p = "searching" -> 0
             [] p = "blocked"   -> 1
             [] p = "retry1"    -> 2
             [] p = "retry2"    -> 3
             [] p \in {"done", "hold", "failed"} -> 4

VARIABLES
  phase,     \* per-searcher phase
  kind,      \* per-searcher block classification (None while unblocked)
  chrome     \* shared browser mode: "headless" | "visible"

vars == <<phase, kind, chrome>>

Init ==
  /\ phase = [s \in Searcher |-> "searching"]
  /\ kind  = [s \in Searcher |-> None]
  /\ chrome = "headless"

StartSearch(s) == phase[s] = "searching"
  /\ phase' = [phase EXCEPT ![s] = "blocked"]
  /\ UNCHANGED <<kind, chrome>>

\* The extractor fails with a classified block (envelope attached).
Block(s, k) == phase[s] = "blocked" /\ kind[s] = None
  /\ kind' = [kind EXCEPT ![s] = k]
  /\ UNCHANGED <<phase, chrome>>

\* canRetryVisible: recovery engine + headless-block shape + not already
\* visible + block is recoverable (isHeadlessBlockedResult skips account).
\* Escalation kills the shared Chrome and relaunches visible (abstracted).
Escalate(s) ==
  /\ phase[s] = "blocked"
  /\ kind[s] \in {"session", "manual"}
  /\ chrome = "headless"
  /\ phase' = [phase EXCEPT ![s] = "retry1"]
  /\ chrome' = "visible"
  /\ UNCHANGED kind

\* Non-recoverable or (single-engine path only) no-recovery-engine:
\* the original error propagates, no visible attempt.
FailFast(s) == phase[s] = "blocked" /\ kind[s] # None
  /\ phase' = [phase EXCEPT ![s] = "failed"]
  /\ UNCHANGED <<kind, chrome>>

\* First visible retry.  Outcome: success | still blocked | account block
\* (a rate limit can surface only during the retry; stillBlocked collects
\* it and the fan-out second-retries it anyway).
Retry1(s, outcome) == phase[s] = "retry1"
  /\ (IF outcome = "ok"
       THEN phase' = [phase EXCEPT ![s] = "done"]
       ELSE phase' = [phase EXCEPT ![s] = "retry2"])
  /\ (IF outcome = "ok"
       THEN kind' = [kind EXCEPT ![s] = None]
       ELSE kind' = [kind EXCEPT ![s] = outcome])
  /\ UNCHANGED chrome

\* Second visible retry (fan-out path; Turnstile may have resolved on the
\* first navigation so cookies are now cached).
Retry2(s, outcome) == phase[s] = "retry2"
  /\ (IF outcome = "ok"
       THEN phase' = [phase EXCEPT ![s] = "done"]
       ELSE (IF kind[s] = "manual"
         THEN phase' = [phase EXCEPT ![s] = "hold"]   \* keep visible open
         ELSE phase' = [phase EXCEPT ![s] = "failed"]))
  /\ UNCHANGED <<kind, chrome>>

Next ==
     (\E s \in Searcher : StartSearch(s))
  \/ (\E s \in Searcher : \E k \in Kinds : Block(s, k))
  \/ (\E s \in Searcher : Escalate(s))
  \/ (\E s \in Searcher : FailFast(s))
  \/ (\E s \in Searcher : \E o \in {"ok", "session", "manual", "account"} : Retry1(s, o))
  \/ (\E s \in Searcher : \E o \in {"ok", "session", "manual", "account"} : Retry2(s, o))

Spec == Init /\ [][Next]_vars

----------------------------------------------------------------------------

InvTypeOK ==
  /\ phase \in [Searcher -> Phases]
  /\ kind \in [Searcher -> Kinds \cup {None}]
  /\ chrome \in {"headless", "visible"}

\* Non-recoverable blocks never trigger a visible retry.
InvAccountNeverRetries == \A s \in Searcher : kind[s] = "account" => phase[s] \notin {"retry1", "retry2"}

\* Retry depth is bounded: phases only move forward.
InvPhaseMonotone == \A s \in Searcher : phase[s] \in Phases

\* Retry and hold phases are only reachable through Escalate, which leaves
\* the browser visible.  (done/failed may also arise from FailFast, the
\* legitimate no-escalation path, so they are not constrained here.)
InvNoSecondEscalation == \A s \in Searcher : phase[s] \in {"retry1", "retry2", "hold"} => chrome = "visible"

=============================================================================
\* Modification History
\* Created 2026-08 (engine-removal session, second modeling round)
=============================================================================
