# TLA+ models

Formal models of the two subsystems with the highest observed bug density,
built during the 2026-08 engine-removal session. Both were run with TLC
(tla2tools.jar 2.19, Temurin JRE 21) and produced counterexamples that were
filed as GitHub issues (see each model's header comment for the issue refs).

## Running

```bash
cd tla
java -jar ~/tla/tla2tools.jar -config ChromeLifecycle.cfg -deadlock ChromeLifecycle
java -jar ~/tla/tla2tools.jar -config ExtractorWaits.cfg     -deadlock ExtractorWaits   # single-shot gate: expect InvNoGeomFail violation
java -jar ~/tla/tla2tools.jar -config ExtractorWaitsPoll.cfg -deadlock ExtractorWaits   # polling discipline: expect clean
```

`-deadlock` disables TLC's deadlock check: quiescent states (no Chrome, no
in-flight search) are legitimate here, and several violation traces pass
through them.

The `ChromeLifecycle*.cfg` variants peel one invariant group at a time so each
violation class gets its own minimal counterexample (TLC stops at the first
violation). `ChromeLifecycle6.cfg` (type + port-owner invariants only) exhausts
the full state space clean — 24k+ states — which validates that the other
findings are genuine rather than model artifacts.

## ChromeLifecycle.tla

Abstracts `bin/launch.mjs` (ghost cleanup, spawn, PID/mode-marker files,
ready timeout, mode-flip kill) plus the visible-recovery kill in
`bin/search.mjs`, with process identity = spawning invocation. Every kill is a
decide/execute pair (`pendingKill`) so interleavings inside the TOCTOU window
are explored.

Violations found (all confirmed against the real code before filing):

| Invariant | Defect | Issue |
|---|---|---|
| `InvNoSeveredSessions` | any kill path can sever concurrent in-flight CDP sessions | #67 |
| `InvPidFileTracksServer` | concurrent-launch TOCTOU: PID_FILE overwritten, healthy serving Chrome later killed as a "ghost" | #70 |
| `InvKillTargetLive` | kill decided on a pid that dies before execution | #71 |
| `InvModeAgrees` | MODE_FILE divergence + unconditional file unlinks after a failed kill | #71 |

## ExtractorWaits.tla

Models the extractor wait discipline against an editor that renders late and
settles (animates): `waitForSelector` (exists-poll) followed by a geometry
gate before click/type. `CheckMode = "single"` is the shipped Logically bug
(one `getBoundingClientRect` check, no retry); `"poll"` is the discipline the
rest of the codebase uses. The `single` config violates `InvNoGeomFail` with a
3-step counterexample; `poll` exhausts clean. Issue #72.

A sweep of the remaining extractors after the engine removal found no other
member of the single-shot shape (Perplexity's rect filter lives inside a
retry loop) — the model now guards the discipline for future engines.
