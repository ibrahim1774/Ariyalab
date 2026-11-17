# Simple maker: design (approved by the owner in chat, 2026-11-16)

## Why
The 12-step maker asks a beginner too many questions. The owner wants making a video to be as easy as possible: few choices, sensible defaults, and changing things by talking to the chat, the way he works with Claude.

## Goals
- A first-time customer gets from an idea to a finished video through 4 screens and at most 3 decisions (length, "looks good", "make it").
- Every price is shown before it is charged; the money rules of the existing maker are unchanged.
- Everything the 12-step maker can do stays reachable ("detailed editor"), nothing is deleted.
Non-goals: new video models (a cheaper Google model is checked separately), changing credit rates per second.
Anti-goals: a settings screen; any quality level without a voice; a second place where prices are computed.

## The 4 screens (default view of /app/p/[id] and /app/new)
1. **Describe it.** One box (idea, or a link/upload of a video to follow). Under it three prefilled choices with "change":
   - Length: chips 7 s, 10 s, 30 s (default), 60 s, 2 min, each showing its credits at the chosen quality. Starter-sized balances see "needs more credits" on chips they cannot afford.
   - Style: picked from the idea or the example video.
   - Quality: cards Budget, Standard (recommended, default), Pro, Pro talking. Each says: voice (narrator voiceover, or characters speak), picture (720p/1080p), "music and captions included", the model name in a small details line, the output file ("MP4, 9:16, about 30 seconds") and credits.
   Purpose is detected from the text; no step. Button: "Write my script".
2. **Check the script.** Script fitted to the length; chat beside it. Button: "Looks good, design my video (N credits)" where N = project fee + storyboard pictures, quoted by the server.
3. **Check the plan.** Characters (first option picked automatically), storyboard pictures, voice and music (picked automatically; included tries). Click anything or use chat to change. Buttons: "Make my video (N credits)" and smaller "Try scene 1 first (N credits)".
4. **Watch and fix.** Scene strip (done / making / next). After a scene: "Make the next scene (N)" or "Make the rest (N)". Each finished scene: "Change this scene" (chat, or remake a shot). When every clip is ready the final video is made automatically (first render included) and can be downloaded.
A "Detailed editor" link opens the existing 12 steps on the same project.

## Rules
- Lengths: exactly 7, 10, 30, 60, 120 seconds in the simple flow; the server accepts 7 to 120.
- Short-video fee: pricing key `projectFeeShort` (default 45) applies when seconds <= 10; otherwise `projectFee` (90). One helper decides; every quote and charge uses it.
- Script fitting: scene count and word budget follow the length (7 s: one scene, one line; 120 s: many scenes). Changing the length rewrites the script (counts as a revise).
- Characters: `consistent_cast` on the project, default true; set false by the script/analysis step when the idea or example calls for different people per scene; changeable in chat only. When false, shots do not reuse cast pictures as references.
- Cast: the first candidate of each character is picked automatically when its pictures finish; the customer can still change it.
- Chat can do everything the screens can: adds set_quality, pick_character, set_consistent_cast, make_scene (priced actions return a confirm card, never spend).
- Scene by scene uses the existing startGeneration with one scene's shot ids; the total cost equals the all-at-once cost.
- 2-minute videos must render inside the render worker's limit; if they cannot, render in parts.

## Approaches considered
- A. Rework the 12 steps in place (fewer steps): breaks the tested step model and its tests.
- B. Chat only (no screens): beginners still need to see pictures and prices; hard to make money-safe.
- C (chosen). A thin 4-screen view over the same services, 12 steps kept as the detailed editor: least risk to money code, fastest, nothing thrown away.

## Left to the builder
Layout details, exact copy (plain words, no dashes as punctuation), how screens resume after a reload (derive from server state; every start is idempotent).
