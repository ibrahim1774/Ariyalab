/*
 * The cast step's prompts (spec 7.3 step 7). lib/story/cast.js sends:
 *
 *   system:   buildCastSystem({ mode })
 *   messages: [{ role:'user', content: buildCastMessage({ scenes, brief }) }]
 *   schema:   CAST_SCHEMA            -> { characters: [{ name, description, voiceNote }] }
 *
 * and builds the image prompts with candidatePrompt (one picture of one
 * character) and sheetPrompt (the cast sheet: three views in one image).
 *
 * Never put a studio, film, character or celebrity name here
 * (tests/story/cast.test.js checks every prompt against the script rule list).
 */

export const MAX_CHARACTERS = 5;
export const CANDIDATES_PER_CHARACTER = 3;

export const MAX_NAME = 40;
export const MAX_DESCRIPTION = 400;
export const MAX_VOICE_NOTE = 200;
export const MAX_NOTE = 500;

/** Portrait pictures to choose from; the sheet is wide because it holds three views side by side. */
export const CANDIDATE_ASPECT = '3:4';
export const SHEET_ASPECT = '16:9';

export const CAST_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['characters'],
  properties: {
    characters: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description', 'voiceNote'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          voiceNote: { type: 'string' },
        },
      },
    },
  },
});

export const CAST_FAMILY_FRIENDLY =
  'Keep every name and description family friendly: nothing sexual, no nudity, no crude words, nothing a parent would mind a child seeing.';

export function buildCastSystem({ mode = 'narrated' } = {}) {
  const speaking =
    mode === 'talking'
      ? 'This is a talking video: every character who has a spoken line in the script must be on the list, under the same first name the script uses for the speaker.'
      : 'This is a narrated video: list the people the story shows. Do not list the narrator.';
  return [
    'You are the casting director for a short video. Read the script and list the characters the pictures need.',
    '',
    'Rules:',
    `- List at most ${MAX_CHARACTERS} characters. Combine background people and crowds into the nearest main character or leave them out.`,
    '- name: a first name. Use the name the script uses. If the script never names someone who matters, give them a short, friendly name.',
    '- description: what the character looks like, in 25 to 50 words. Age, build, skin tone, hair, clothes, and one thing that makes them easy to recognise. Describe the person only. No art style, no setting, no brand names, no real people, no characters from any film or show.',
    '- voiceNote: how the character sounds, in under 20 words. Age feel, pitch, pace and mood.',
    `- ${speaking}`,
    `- ${CAST_FAMILY_FRIENDLY}`,
    '- Answer with the JSON object only.',
  ].join('\n');
}

const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const tagJSON = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

/** The script as the model reads it: title, what we see and who says what, per scene. */
export function buildCastMessage({ scenes = [], brief = {} } = {}) {
  const script = {
    scenes: scenes.map((s) => ({
      title: s.title,
      visual: s.visual,
      lines: (s.lines || []).map((l) => ({ speaker: l.speaker, text: l.text })),
    })),
  };
  return [
    'List the characters for this script.',
    `<brief>\n${tagJSON({ purpose: brief.purpose ?? null, mode: brief.mode ?? null })}\n</brief>`,
    `<script>\n${tagJSON(script)}\n</script>`,
  ].join('\n\n');
}

// A different cue for each of the three options, so the customer gets a real choice.
const VARIATIONS = Object.freeze([
  'A natural, friendly everyday look.',
  'A different take: change the face shape and the hairstyle a little.',
  'Another take: different clothes and colours, same character.',
]);

const NO_TEXT = 'No text, no captions, no logos, no watermark.';

/**
 * One picture of one character: head to toe, plain background, to be picked
 * from. `style` is the project's look (prompts/styles.js styleFragment).
 */
export function candidatePrompt({ style, name, description, note, slot = 0 }) {
  return [
    `A character design picture of ${oneLine(name)}. ${oneLine(description)}`,
    note ? `Change requested by the customer: ${oneLine(note)}` : '',
    VARIATIONS[slot % VARIATIONS.length],
    'Full body, standing, facing the camera, on a plain light background, one character only.',
    oneLine(style),
    NO_TEXT,
  ].filter(Boolean).join(' ');
}

/** The cast sheet: the picked picture shown three ways in one image, so later pictures keep the same character. */
export function sheetPrompt({ style, name, description }) {
  return [
    `A character sheet of ${oneLine(name)}, the same character as the reference picture. ${oneLine(description)}`,
    'One wide image with three views side by side on a plain light background: a front view, a three quarter view and a close up of the face.',
    'Keep the face, hair, clothes and colours identical in all three views and identical to the reference.',
    oneLine(style),
    NO_TEXT,
  ].filter(Boolean).join(' ');
}
