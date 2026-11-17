# Sound-on models and story flow (design)

Owner decisions, 2026-11-17: "only use models in my software that has sound on"; four quality options (Google Gemini Omni, Seedance, Kling 3.0 named); "wherever needs to be character consistent, have it be consistent and have the story be flowing"; "Yes, build it" to the lineup and to steps 1 to 3 below.

## Intent
Every video clip is made with the model's own sound. A finished video reads as one story: same people, same places, same voices, each scene following the one before.

## Goals
1. Four quality levels, all sound on (kie.ai list prices read 2026-11-17, untested live):

| key (unchanged) | card name | model (kie id) | picture | cost USD/s | credits/s |
|---|---|---|---|---|---|
| economy | Budget | Seedance 2 Mini (`bytedance/seedance-2-mini`) | 720p | 0.041 | 7 |
| standard | Standard (recommended) | Gemini Omni 1.2 Flash (`google/gemini-omni-flash-1-2`) | 1080p | 0.05 | 8 |
| pro_narrated | Pro | Kling 3.0 std, sound on | 720p | 0.1135 | 16 |
| pro_talking | Pro Max | Kling 3.0 pro, sound on | 1080p | 0.151 | 21 |

   Credits per second are the lowest whole numbers that keep the 70% rule of tests/pricing.test.js; if 8 fails for standard, use the lowest that passes and say so in the report. Project fee unchanged.
2. Voice. `mode` no longer follows quality. `mode` is the script's storytelling style and is chosen by the script writer (customer can change it in chat): `narrated` = a narrator tells it, characters do not speak; `talking` = characters speak their lines, a narrator is optional. In both modes clips are made with sound.
   - Narrator lines, in either mode, are read by ONE narration voice (Fish Audio) laid over the whole video. They are never put in a clip prompt.
   - Character lines (talking mode) are spoken inside the clip. The clip prompt names the speaker and carries that character's `voice_note`; a shot keeps its speaker.
   - Narrated clips are prompted for ambience and sound effects only, with no speech. Render keeps the clip sound, ducked under the narrator and the music, in both modes.
3. Story flow. Each scene stores one setting line (place, time of day, lighting, what the characters wear and carry). It goes into every still and clip prompt of that scene together with one line of what the previous shot showed. Re-planning a scene sends the whole script and neighbouring shots as context.
4. Consistency fixes: cast ids re-matched when a shot description is edited; server enforces one quality per project (no per-shot quality that differs); a style change marks stills, sheets and clips stale; up to 6 character references per still; a character left out of references or Kling elements is recorded as a warning on the shot, never silent.

## Non-goals
Crossfades or end-frame chaining between clips. Voice ids or voice cloning inside video models. New plan prices. Renaming the quality keys (no migration for keys).

## Anti-goals
Charging for sound and then muting it. A narrator whose voice changes mid-video. A character line with no named speaker. Any live provider call or spend in tests.

## Constraints
Money rules unchanged (hold, settle, release; price shown = price charged). No push, deploy, hosted migration or live provider call. Mock mode (`STORY_MOCK=1`) must work for the new model. New migrations are additive files after 20261116000910. Customer copy: plain words, no model ids except the card's model name.

## Left to the builder
Exact prompt wording; ducking levels; how the Gemini Omni request body is shaped (read https://kie.ai/gemini-omni-1-2-flash and the kie docs; unverified against the live API, add to docs/go-live.md).
