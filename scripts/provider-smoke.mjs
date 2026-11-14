#!/usr/bin/env node
/*
 * Live smoke test: ONE minimal real call to one provider, using the keys in
 * .env.local. Costs real money (a few cents at most). Never run in CI.
 *
 *   node scripts/provider-smoke.mjs <provider> [arg]
 *
 *   llm                  completeJSON on the fast tier, then the smart tier
 *   chat                 chatWithTools with one trivial tool
 *   image                Nano Banana still (polls until done)
 *   video <imageUrl>     economy 4 s clip from a public image (polls until done)
 *   tts [voiceId]        narration line; writes /tmp/smoke-tts.mp3
 *   clone <sampleUrl>    creates a private Fish voice from a public audio URL
 *   music                Lyria 30 s clip; writes /tmp/smoke-music.mp3
 *   stt                  transcribes tests/fixtures/voice.mp3 (Groq, else Replicate)
 *   fetch <postUrl>      downloads a public Instagram/TikTok/Facebook video
 *   storage              putObject + deleteObject of a tiny text file
 *
 * A missing key prints the ProviderError 'config' message naming the variable.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.env.local');
try {
  process.loadEnvFile(envFile);
} catch {
  // no .env.local: rely on the shell environment
}
delete process.env.STORY_MOCK;
process.chdir(root);

const lib = (name) => import(path.join(root, 'lib', 'providers', `${name}.js`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(get, task, { everyMs = 5000, timeoutMs = 10 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await get(task);
    console.log('  poll:', r.status);
    if (r.status !== 'pending') return r;
    await sleep(everyMs);
  }
  throw new Error('timed out');
}

const RUNNERS = {
  async llm() {
    const { completeJSON } = await lib('llm');
    const schema = {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    };
    for (const tier of ['fast', 'smart']) {
      const out = await completeJSON({
        tier,
        name: 'smoke_title',
        system: 'Reply with a short title.',
        schema,
        maxTokens: 2000,
        messages: [{ role: 'user', content: 'A story about a small bakery that bakes bread at dawn.' }],
      });
      console.log(tier, out);
    }
  },
  async chat() {
    const { chatWithTools } = await lib('llm');
    const { messages } = await chatWithTools({
      system: 'Use the tool to look up the time, then answer in one sentence.',
      messages: [{ role: 'user', content: 'What time is it?' }],
      tools: [{ name: 'get_time', description: 'Returns the current time', input_schema: { type: 'object', properties: {} } }],
      onToolCall: async () => ({ time: new Date().toISOString() }),
    });
    console.log(JSON.stringify(messages.at(-1), null, 2));
  },
  async image() {
    const { submitImage, getImage } = await lib('image');
    const task = await submitImage({ prompt: 'A warm, softly lit small bakery counter with fresh bread, 3D animated family film style', size: '1K' });
    console.log('task', task);
    console.log(await poll(getImage, task));
  },
  async video(imageUrl) {
    if (!imageUrl) throw new Error('usage: video <public image url>');
    const { submitClip, getClip } = await lib('video');
    const task = await submitClip({ quality: 'economy', imageUrl, prompt: 'The camera slowly pushes in; steam rises gently.', seconds: 4 });
    console.log('task', task);
    console.log(await poll(getClip, task, { everyMs: 10000 }));
  },
  async tts(voiceId) {
    const { listVoices, synthesize } = await lib('tts');
    const id = voiceId || listVoices()[0].id;
    const { buffer, mime } = await synthesize({ voiceId: id, text: 'Every morning, before the town wakes up, the ovens are already warm.' });
    await writeFile('/tmp/smoke-tts.mp3', buffer);
    console.log(mime, buffer.length, 'bytes -> /tmp/smoke-tts.mp3');
  },
  async clone(sampleUrl) {
    if (!sampleUrl) throw new Error('usage: clone <public audio url>');
    const { cloneVoice } = await lib('tts');
    console.log(await cloneVoice({ sampleUrl, name: 'Smoke test voice' }));
  },
  async music() {
    const { generateMusic } = await lib('music');
    const { buffer, mime } = await generateMusic({ prompt: 'Gentle warm acoustic guitar, hopeful', seconds: 30 });
    await writeFile('/tmp/smoke-music.mp3', buffer);
    console.log(mime, buffer.length, 'bytes -> /tmp/smoke-music.mp3');
  },
  async stt() {
    const { transcribe } = await lib('stt');
    console.log(await transcribe({ filePath: path.join(root, 'tests', 'fixtures', 'voice.mp3') }));
  },
  async fetch(url) {
    if (!url) throw new Error('usage: fetch <instagram|tiktok|facebook post url>');
    const { fetchReference } = await lib('fetchVideo');
    console.log(await fetchReference(url));
  },
  async storage() {
    const { putObject, deleteObject, storageBackend } = await lib('storage');
    const key = `smoke/${Date.now()}.txt`;
    console.log('backend', storageBackend());
    const put = await putObject({ key, body: 'smoke test', contentType: 'text/plain' });
    console.log('put', put);
    console.log('deleted', await deleteObject({ key: put.key }));
  },
};

const [name, arg] = process.argv.slice(2);
if (!name || !RUNNERS[name]) {
  console.log(`usage: node scripts/provider-smoke.mjs <${Object.keys(RUNNERS).join('|')}> [arg]`);
  process.exit(name ? 1 : 0);
}

try {
  await RUNNERS[name](arg);
} catch (err) {
  console.error(`[${err.code || 'error'}] ${err.message}`);
  if (err.cause) console.error('cause:', err.cause?.message || err.cause);
  process.exit(1);
}
