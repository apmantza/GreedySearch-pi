----------------------------- MODULE ExtractorWaits -----------------------------
(***************************************************************************)
(* Wait discipline of an engine extractor against a rich-text editor that  *)
(* renders late and settles (animates) after appearing in the DOM:         *)
(*                                                                         *)
(*   waitForSelector  -- polls until the element EXISTS                    *)
(*   geometry gate    -- getBoundingClientRect width/height check before   *)
(*                       click/type                                        *)
(*                                                                         *)
(* Observed live (2026-08 session): the Logically extractor's single-shot  *)
(* geometry gate failed with "visible input not found" while the tiptap/   *)
(* MUI editor was mid-settle; probing the settled page showed the same     *)
(* selector with box 731x20 (issue #69 smoke transcript).                  *)
(*                                                                         *)
(* CheckMode == "single" models the one-shot gate (fail once, no retry);   *)
(* CheckMode == "poll" models the polling discipline every other wait in   *)
(* the codebase uses.  The safety property must hold under "poll" and      *)
(* fails under "single" -- the counterexample is the shipped defect.        *)
(***************************************************************************)
EXTENDS Integers

CONSTANT CheckMode   \* "single" | "poll"

None == "none"

\* Page-side editor phases:
\*   absent   -- selector not in the DOM yet (waits keep polling)
\*   settling -- in the DOM (EXISTS) but bounding box still ~0 (animation/layout)
\*   settled  -- in the DOM with usable geometry
EditorStates == {"absent", "settling", "settled"}

\* Extractor-side wait phases:
\*   wait-exists -- inside waitForSelector polling loop
\*   check       -- at the geometry gate
\*   typing      -- gate passed, click/type in progress
\*   done        -- input delivered
\*   failed-geom -- geometry gate threw (the defect shape under test)
\*   failed-timeout -- waitForSelector timed out (structural block; legitimate)
WaitStates == {"wait-exists", "check", "typing", "done", "failed-geom", "failed-timeout"}

VARIABLES
  editor,   \* editor phase in the page
  waits     \* extractor wait phase

vars == <<editor, waits>>

Init ==
  /\ editor = "absent"
  /\ waits = "wait-exists"

\* The page renders the editor into the DOM (still animating in).
Render == editor = "absent"
  /\ editor' = "settling"
  /\ UNCHANGED waits

\* The editor finishes settling: bounding box becomes usable.
Settle == editor = "settling"
  /\ editor' = "settled"
  /\ UNCHANGED waits

\* waitForSelector: element exists in "settling" already.
ExistsPass == waits = "wait-exists"
  /\ editor \in {"settling", "settled"}
  /\ waits' = "check"
  /\ UNCHANGED editor

\* waitForSelector deadline (structural block, e.g. login wall).
ExistsTimeout == waits = "wait-exists"
  /\ waits' = "failed-timeout"
  /\ UNCHANGED editor

\* The geometry gate.  Under "single": one check, fail if not settled.
\* Under "poll": keep checking until settled (env may settle in between).
Check == waits = "check"
  /\ (IF editor = "settled"
       THEN waits' = "typing"
       ELSE IF CheckMode = "single"
         THEN waits' = "failed-geom"
         ELSE waits' = "check")
  /\ UNCHANGED editor

\* Click + type succeeded on a usable editor.
Type == waits = "typing"
  /\ editor = "settled"
  /\ waits' = "done"
  /\ UNCHANGED editor

Next ==
  \/ Render
  \/ Settle
  \/ ExistsPass
  \/ ExistsTimeout
  \/ Check
  \/ Type

Spec == Init /\ [][Next]_vars

----------------------------------------------------------------------------

InvTypeOK == editor \in EditorStates /\ waits \in WaitStates

\* The extractor must never fail at the geometry gate: whenever the editor
\* is (or will be) usable, the wait discipline must deliver the input.
\* Recurrence: Logically's single-shot getBoundingClientRect gate vs the
\* settling tiptap/MUI editor (issue #69 smoke, "visible input not found").
InvNoGeomFail == waits # "failed-geom"

=============================================================================
\* Modification History
\* Created 2026-08 by the engine-removal session
=============================================================================
