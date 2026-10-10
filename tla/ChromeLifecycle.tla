---------------------------- MODULE ChromeLifecycle ----------------------------
(***************************************************************************)
(* Models the GreedySearch shared-Chrome lifecycle on port 9222:            *)
(*   - bin/launch.mjs: cleanupGhostChrome (read pid/port, compare, kill),   *)
(*     spawn (writes PID_FILE + MODE_FILE), port bind, ready timeout,       *)
(*     mode-flip kill (visible requested while headless runs)               *)
(*   - bin/search.mjs visible recovery: kill the shared Chrome to           *)
(*     relaunch visible                                                     *)
(*                                                                         *)
(* Process identity is abstracted to the launcher invocation that spawned   *)
(* the Chrome process.  Every kill path is modelled as a two-step           *)
(* decide/execute pair (pendingKill) so interleavings inside the TOCTOU    *)
(* window are explored.                                                     *)
(*                                                                         *)
(* Live incidents motivating the model: issue #67 (recovery kill severed    *)
(* concurrent in-flight searches).                                         *)
(***************************************************************************)
EXTENDS Integers, FiniteSets

CONSTANT
  Launcher,   \* launch/visible invocations
  Searcher    \* concurrent search.mjs runs

None == "none"
Modes == {"headless", "visible"}
Phases == {"idle", "checked", "spawned"}

VARIABLES
  procs,        \* live Chrome processes (identity = spawning launcher)
  procMode,     \* actual mode of each live process
  port,         \* launcher whose Chrome listens on 9222 (None = nothing bound)
  pidFile,      \* PID_FILE record (None = absent)
  modeFile,     \* MODE_FILE content (None = absent)
  attached,     \* searchers with a live CDP session on the serving Chrome
  pendingKill,  \* kill decided but not yet executed (TOCTOU window)
  lstate        \* per-launcher phase

vars == <<procs, procMode, port, pidFile, modeFile, attached, pendingKill, lstate>>

ModeOf(p) == (CHOOSE m \in Modes : <<p, m>> \in procMode)

----------------------------------------------------------------------------

Init ==
  /\ procs = {}
  /\ procMode = {}
  /\ port = None
  /\ pidFile = None
  /\ modeFile = None
  /\ attached = {}
  /\ pendingKill = None
  /\ lstate = [l \in Launcher |-> "idle"]

\* launch.mjs main(): after cleanup, a fresh launch only happens when
\* PID_FILE is absent or its pid is stale (process gone).
CheckLaunch(l) ==
  /\ lstate[l] = "idle"
  /\ (pidFile = None \/ pidFile \notin procs)
  /\ lstate' = [lstate EXCEPT ![l] = "checked"]
  /\ UNCHANGED <<procs, procMode, port, pidFile, modeFile, attached, pendingKill>>

\* spawn: process starts, PID_FILE and MODE_FILE are written immediately;
\* the port is NOT bound yet (writePortFile polls up to 15s).
Spawn(l, m) ==
  /\ lstate[l] = "checked"
  /\ l \notin procs          \* a fresh invocation spawns a fresh process
  /\ procs' = procs \cup {l}
  /\ procMode' = procMode \cup {<<l, m>>}
  /\ pidFile' = l
  /\ modeFile' = m
  /\ lstate' = [lstate EXCEPT ![l] = "spawned"]
  /\ UNCHANGED <<port, attached, pendingKill>>

\* writePortFile succeeded: this spawn now owns 9222.
\* (The process must still be alive: a real launch killed mid-startup
\* times out and exits without binding.)
Ready(l) ==
  /\ lstate[l] = "spawned"
  /\ l \in procs
  /\ port = None
  /\ port' = l
  /\ lstate' = [lstate EXCEPT ![l] = "idle"]
  /\ UNCHANGED <<procs, procMode, pidFile, modeFile, attached, pendingKill>>

\* ready timeout (15s): the process stays alive and detached (ghost).
FailBusy(l) ==
  /\ lstate[l] = "spawned"
  /\ port # None
  /\ lstate' = [lstate EXCEPT ![l] = "idle"]
  /\ UNCHANGED <<procs, procMode, port, pidFile, modeFile, attached, pendingKill>>

\* launch.mjs mode check: caller wants visible, tracked Chrome is headless
\* -> kill tracked process, fall through to fresh launch.
ModeFlipKillP(p) ==
  /\ pidFile = p
  /\ p \in procs
  /\ <<p, "headless">> \in procMode
  /\ pendingKill = None
  /\ pendingKill' = p
  /\ UNCHANGED <<procs, procMode, port, pidFile, modeFile, attached, lstate>>

\* launch.mjs cleanupGhostChrome: listener pid vs tracked pid, decide-only.
CleanupPass(l) ==
  /\ port # None
  /\ (pidFile = None \/ pidFile # port)
  /\ pendingKill = None
  /\ pendingKill' = port
  /\ UNCHANGED <<procs, procMode, port, pidFile, modeFile, attached, lstate>>

\* search.mjs visible recovery: the blocked searcher kills the shared
\* Chrome to relaunch visible.
RecoveryKill(s) ==
  /\ s \in attached
  /\ port # None
  /\ pendingKill = None
  /\ pendingKill' = port
  /\ UNCHANGED <<procs, procMode, port, pidFile, modeFile, attached, lstate>>

\* execute the decided kill (SIGTERM / taskkill).
ExecKill ==
  /\ pendingKill # None
  /\ pendingKill \in procs
  /\ LET p == pendingKill IN
     /\ procs' = procs \ {p}
     /\ procMode' = procMode \ {<<p, ModeOf(p)>>}
     /\ (IF port = p THEN port' = None ELSE port' = port)
     /\ (IF pidFile = p THEN pidFile' = None ELSE pidFile' = pidFile)
     /\ UNCHANGED <<modeFile, attached, lstate>>
  /\ pendingKill' = None

\* killProcess returns false: the target died between decide and execute.
\* launch.mjs ignores the failure and still unlinks PID/ACTIVE_PORT/MODE files.
DiscardKill ==
  /\ pendingKill # None
  /\ pendingKill \notin procs
  /\ pendingKill' = None
  /\ pidFile' = None
  /\ modeFile' = None
  /\ UNCHANGED <<procs, procMode, port, attached, lstate>>

\* Chrome dies on its own (OOM, crash): PID_FILE is left stale.
Crash(p) ==
  /\ p \in procs
  /\ procs' = procs \ {p}
  /\ procMode' = procMode \ {<<p, ModeOf(p)>>}
  /\ (IF port = p THEN port' = None ELSE port' = port)
  /\ UNCHANGED <<pidFile, modeFile, attached, pendingKill, lstate>>

\* a search attaches a CDP session (extractor tab) to the serving Chrome
Attach(s) ==
  /\ port # None
  /\ s \notin attached
  /\ attached' = attached \cup {s}
  /\ UNCHANGED <<procs, procMode, port, pidFile, modeFile, pendingKill, lstate>>

\* search finishes (success or its own error path) and releases the session
Done(s) ==
  /\ s \in attached
  /\ attached' = attached \ {s}
  /\ UNCHANGED <<procs, procMode, port, pidFile, modeFile, pendingKill, lstate>>

----------------------------------------------------------------------------

Next ==
     (\E l \in Launcher : CheckLaunch(l))
  \/ (\E l \in Launcher : \E m \in Modes : Spawn(l, m))
  \/ (\E l \in Launcher : Ready(l))
  \/ (\E l \in Launcher : FailBusy(l))
  \/ (\E p \in Launcher : ModeFlipKillP(p))
  \/ (\E l \in Launcher : CleanupPass(l))
  \/ (\E s \in Searcher : RecoveryKill(s))
  \/ ExecKill
  \/ DiscardKill
  \/ (\E p \in Launcher : Crash(p))
  \/ (\E s \in Searcher : Attach(s))
  \/ (\E s \in Searcher : Done(s))

Spec == Init /\ [][Next]_vars

----------------------------------------------------------------------------

InvTypeOK ==
  /\ procs \subseteq Launcher
  /\ procMode \subseteq procs \times Modes
  /\ \A p \in procs : Cardinality({m \in Modes : <<p, m>> \in procMode}) = 1
  /\ port \in Launcher \cup {None}
  /\ pidFile \in Launcher \cup {None}
  /\ modeFile \in Modes \cup {None}
  /\ attached \subseteq Searcher
  /\ pendingKill \in Launcher \cup {None}
  /\ lstate \in [Launcher -> Phases]

\* A search that believes it holds a live CDP session must never find the
\* serving Chrome gone.  (Issue #67: recovery kill severed concurrent runs.)
InvNoSeveredSessions == port # None \/ attached = {}

\* PID_FILE must identify the serving Chrome whenever one is bound; if it
\* does not, cleanupGhostChrome kills the *serving* process as a ghost.
InvPidFileTracksServer == port # None => pidFile = port

\* The bound port always belongs to a live process.
InvPortOwnerLive == port # None => port \in procs

\* The mode marker must agree with the running Chrome's actual mode.
InvModeAgrees == port # None => modeFile = ModeOf(port)

\* A decided kill always targets a process that still exists.
InvKillTargetLive == pendingKill # None => pendingKill \in procs

=============================================================================
\* Modification History
\* Created 2026-08 by the engine-removal session
=============================================================================
