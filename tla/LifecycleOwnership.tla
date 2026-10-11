------------------------ MODULE LifecycleOwnership ------------------------
(***************************************************************************)
(* Fix-design model for the #67 / #70 / #71 / #74 family: what happens if  *)
(* every lifecycle transition goes through an ownership discipline?        *)
(*                                                                         *)
(* Shared state: one browser process on 9222, PID/mode marker files, the   *)
(* foreground slot is out of scope (see TabOwnership).  Two searches share *)
(* the browser; each may hit a headless block and escalate to visible      *)
(* recovery (kill + relaunch).                                             *)
(*                                                                         *)
(* Design under test -- a lifecycle lock with stale-holder recovery:       *)
(*   - CheckLaunch / Spawn / Kill / Attach / Detach need the lock held     *)
(*     across check+act (one atomic model step = one correct critical      *)
(*     section; the TOCTOU of the shipped code is what this removes)       *)
(*   - recovery escalation with co-attached consumers waits (bounded       *)
(*     budget), then either gives up (Arb="budget") or yields by a         *)
(*     deterministic priority order (Arb="yield": s2 yields to s1)         *)
(*   - a search process may die while holding the lock (outer timeout,     *)
(*     user kill); Breaker="ttl" lets another actor break a stale lock,    *)
(*     Breaker="none" models no stale-lock recovery.                       *)
(*                                                                         *)
(* Expected results: severance and PID-overwrite vanish under the          *)
(* discipline in every config (the fix works); Arb="budget" still allows   *)
(* mutual abandonment (arbitration needs a total order, not just a bound); *)
(* Breaker="none" deadlocks on holder death (stale locks need a TTL).      *)
(***************************************************************************)
EXTENDS Integers, FiniteSets

CONSTANT
  Searcher,   \* {s1, s2}
  Arb,        \* "budget" | "yield"
  Breaker     \* "none" | "ttl"

None == "none"
Modes == {"headless", "visible"}

VARIABLES
  procs,      \* live browser processes (identity = spawner)
  procMode,   \* actual mode per live process
  port,       \* who listens on 9222
  pidFile,    \* PID_FILE record
  modeFile,   \* MODE_FILE content
  attached,   \* searches with a live CDP session on the server
  lock,       \* lifecycle lock: None (free) | holder | stale holder
  checked,    \* per-search: passed the fresh-launch gate inside the lock
  escalating, \* searches currently in recovery escalation
  abandoned,  \* searches that gave up an escalation (arbitration loss)
  budget,     \* per-search remaining futile-escalation waits
  phase,      \* per-search: "idle"|"searching"|"done"|"failed"|"dead"
  alive       \* per-search: process still running

vars == <<procs, procMode, port, pidFile, modeFile, attached,
          lock, checked, escalating, abandoned, budget, phase, alive>>

ModeOf(p) == (CHOOSE m \in Modes : <<p, m>> \in procMode)

Init ==
  /\ procs = {"p0"}
  /\ procMode = {<<"p0", "headless">>}
  /\ port = "p0"
  /\ pidFile = "p0"
  /\ modeFile = "headless"
  /\ attached = {}
  /\ lock = None
  /\ checked = [s \in Searcher |-> FALSE]
  /\ escalating = {}
  /\ abandoned = {}
  /\ budget = [s \in Searcher |-> 2]
  /\ phase = [s \in Searcher |-> "idle"]
  /\ alive = [s \in Searcher |-> TRUE]

\* --- lock primitives ----------------------------------------------------

Acquire(s) ==
  /\ alive[s] /\ phase[s] \notin {"done", "failed", "dead"}
  /\ lock = None
  /\ lock' = s
  /\ UNCHANGED <<procs, procMode, port, pidFile, modeFile, attached,
                 checked, escalating, abandoned, budget, phase, alive>>

Release(s) ==
  /\ lock = s /\ alive[s]
  /\ lock' = None
  /\ checked' = [checked EXCEPT ![s] = FALSE]
  /\ UNCHANGED <<procs, procMode, port, pidFile, modeFile, attached,
                 escalating, abandoned, budget, phase, alive>>

\* A search process dies while holding (or not holding) the lock:
\* outer timeout, user kill.  The lock stays with the corpse.
SearchDeath(s) ==
  /\ alive[s]
  /\ alive' = [alive EXCEPT ![s] = FALSE]
  /\ phase' = [phase EXCEPT ![s] = "dead"]
  /\ escalating' = escalating \ {s}
  /\ UNCHANGED <<procs, procMode, port, pidFile, modeFile, attached,
                 lock, checked, abandoned, budget>>

\* Stale-lock breaker (TTL expiry): only in the Breaker="ttl" design.
BreakStale(t, s) ==
  /\ Breaker = "ttl"
  /\ alive[t] /\ lock = s /\ ~alive[s]
  /\ lock' = None
  /\ UNCHANGED <<procs, procMode, port, pidFile, modeFile, attached,
                 checked, escalating, abandoned, budget, phase, alive>>

\* --- consumer registration (serialized: no attach between check+kill) ---

Attach(s) ==
  /\ alive[s] /\ lock = s /\ phase[s] = "idle"
  /\ port # None
  /\ attached' = attached \cup {s}
  /\ phase' = [phase EXCEPT ![s] = "searching"]
  /\ UNCHANGED <<procs, procMode, port, pidFile, modeFile,
                 lock, checked, escalating, abandoned, budget, alive>>

Detach(s) ==
  /\ alive[s] /\ lock = s /\ s \in attached
  /\ attached' = attached \ {s}
  /\ phase' = [phase EXCEPT ![s] = "done"]
  /\ UNCHANGED <<procs, procMode, port, pidFile, modeFile,
                 lock, checked, escalating, abandoned, budget, phase, alive>>

\* --- fresh launch inside the lock (the #70 TOCTOU, closed) ---------------

CheckSpawn(s) ==
  /\ alive[s] /\ lock = s
  /\ (pidFile = None \/ pidFile \notin procs)
  /\ checked' = [checked EXCEPT ![s] = TRUE]
  /\ UNCHANGED <<procs, procMode, port, pidFile, modeFile, attached,
                 lock, escalating, abandoned, budget, phase, alive>>

LockedSpawn(s, m) ==
  /\ alive[s] /\ lock = s /\ checked[s] /\ s \notin procs
  /\ procs' = procs \cup {s}
  /\ procMode' = procMode \cup {<<s, m>>}
  /\ pidFile' = s
  /\ modeFile' = m
  /\ port' = s
  /\ UNCHANGED <<attached, lock, checked, escalating, abandoned,
                 budget, phase, alive>>

\* --- recovery escalation --------------------------------------------------

\* Sole consumer (or nobody attached): atomic check-and-kill under the lock.
EscalateAlone(s) ==
  /\ alive[s] /\ lock = s /\ s \in attached
  /\ attached \ {s} = {}
  /\ port # None
  /\ LET p == port IN
     procs' = (procs \ {p, s}) \cup {s}
  /\ procMode' = {x \in procMode : x[1] \notin {port, s}} \cup {<<s, "visible">>}
  /\ port' = s
  /\ pidFile' = s
  /\ modeFile' = "visible"
  /\ escalating' = escalating \ {s}
  /\ UNCHANGED <<attached, lock, checked, abandoned, budget, phase, alive>>

BeginEscalation(s) ==
  /\ alive[s] /\ phase[s] = "searching" /\ s \in attached
  /\ s \notin escalating
  /\ escalating' = escalating \cup {s}
  /\ UNCHANGED <<procs, procMode, port, pidFile, modeFile, attached,
                 lock, checked, abandoned, budget, phase, alive>>

\* Co-attached consumers: wait OUTSIDE the critical section (release,
\* sleep, re-acquire) -- holding the lock while waiting would block the
\* rival's normal completion.  Burns budget.
EscalateWait(s) ==
  /\ alive[s] /\ lock = s /\ s \in escalating
  /\ attached \ {s} # {}
  /\ budget[s] > 0
  /\ budget' = [budget EXCEPT ![s] = budget[s] - 1]
  /\ lock' = None
  /\ UNCHANGED <<procs, procMode, port, pidFile, modeFile, attached,
                 checked, escalating, abandoned, phase, alive>>

\* Budget exhausted: give up the escalation (detach, fail the search).
\* Only meaningful while still blocked behind a live rival -- a waiter
\* that finds itself alone proceeds via EscalateAlone instead.
GiveUp(s) ==
  /\ alive[s] /\ lock = s /\ s \in escalating
  /\ budget[s] = 0
  /\ attached \ {s} # {}
  /\ attached' = attached \ {s}
  /\ escalating' = escalating \ {s}
  /\ abandoned' = abandoned \cup {s}
  /\ phase' = [phase EXCEPT ![s] = "failed"]
  /\ UNCHANGED <<procs, procMode, port, pidFile, modeFile,
                 lock, checked, budget, alive>>

\* Deterministic arbitration (Arb="yield" only): s2 yields to s1, freeing
\* s1's escalation immediately instead of burning both budgets.
Yield(s) ==
  /\ Arb = "yield"
  /\ alive[s] /\ lock = s /\ s \in escalating
  /\ \E t \in escalating : t # s /\ s = "s2" /\ t = "s1"
  /\ attached' = attached \ {s}
  /\ escalating' = escalating \ {s}
  /\ abandoned' = abandoned \cup {s}
  /\ phase' = [phase EXCEPT ![s] = "failed"]
  /\ UNCHANGED <<procs, procMode, port, pidFile, modeFile,
                 lock, checked, budget, alive>>

Next ==
     (\E s \in Searcher : Acquire(s))
  \/ (\E s \in Searcher : Release(s))
  \/ (\E s \in Searcher : SearchDeath(s))
  \/ (\E t \in Searcher : \E s \in Searcher : BreakStale(t, s))
  \/ (\E s \in Searcher : Attach(s))
  \/ (\E s \in Searcher : Detach(s))
  \/ (\E s \in Searcher : CheckSpawn(s))
  \/ (\E s \in Searcher : \E m \in Modes : LockedSpawn(s, m))
  \/ (\E s \in Searcher : EscalateAlone(s))
  \/ (\E s \in Searcher : BeginEscalation(s))
  \/ (\E s \in Searcher : EscalateWait(s))
  \/ (\E s \in Searcher : GiveUp(s))
  \/ (\E s \in Searcher : Yield(s))

Spec == Init /\ [][Next]_vars

----------------------------------------------------------------------------

InvTypeOK ==
  /\ procs \subseteq {"p0"} \cup Searcher
  /\ procMode \subseteq procs \times Modes
  /\ \A p \in procs : Cardinality({m \in Modes : <<p, m>> \in procMode}) = 1
  /\ port \in {"p0"} \cup Searcher \cup {None}
  /\ pidFile \in {"p0"} \cup Searcher \cup {None}
  /\ modeFile \in Modes \cup {None}
  /\ attached \subseteq Searcher
  /\ lock \in Searcher \cup {None}
  /\ checked \in [Searcher -> BOOLEAN]
  /\ escalating \subseteq Searcher
  /\ abandoned \subseteq Searcher
  /\ budget \in [Searcher -> 0..2]
  /\ phase \in [Searcher -> {"idle", "searching", "done", "failed", "dead"}]
  /\ alive \in [Searcher -> BOOLEAN]
  /\ port # None => port \in procs

\* The fix's goal: under the discipline, no actor-initiated transition
\* ever severs an attached session.
InvNoSeveredSessions == port # None \/ attached = {}

\* PID_FILE always names the serving Chrome (the #70 shape, closed by
\* holding the lock across check+spawn).
InvPidFileTracksServer == port # None => pidFile = port

\* Arbitration without a total order can strand BOTH escalators.
InvNoMutualAbandon == ~(Cardinality(abandoned) = 2)

\* A lock held by a dead process with live searches still needing
\* lifecycle transitions is a stranded lock (needs the TTL breaker).
InvNoStrandedLock ==
  (Breaker = "ttl") \/
  ((lock # None /\ ~alive[lock]) =>
    (\A s \in Searcher : ~alive[s] \/ phase[s] \in {"done", "failed", "dead"}))

=============================================================================
\* Modification History
\* Created 2026-08 (engine-removal session, third modeling round)
=============================================================================
