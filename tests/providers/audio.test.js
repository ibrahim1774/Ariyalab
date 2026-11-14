import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rep = vi.hoisted(() => ({ runs: [], output: null, error: null }));

vi.mock('replicate', () => ({
  default: class Replicate {
    constructor(opts) { this.opts = opts; }
    async run(model, { input }) {
      rep.runs.push({ model, input, auth: this.opts.auth });
      if (rep.error) throw rep.error;
      return rep.output;
    }
  },
}));

import { transcribe } from '../../lib/providers/stt.js';
import { cloneVoice, listVoices, synthesize } from '../../lib/providers/tts.js';
import { generateMusic } from '../../lib/providers/music.js';
import { MODEL_IDS } from '../../lib/providers/config.js';

const VOICE = 'tests/fixtures/voice.mp3';

beforeEach(() => {
  rep.runs.length = 0;
  rep.output = null;
  rep.error = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('mock mode (no network)', () => {
  it('transcribe, synthesize, cloneVoice, listVoices and generateMusic return fixtures', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const t = await transcribe({ filePath: VOICE });
    expect(t.text).toBeTruthy();
    expect(t.words.length).toBeGreaterThan(2);
    for (const w of t.words) {
      expect(typeof w.w).toBe('string');
      expect(w.end).toBeGreaterThan(w.start);
    }

    const s = await synthesize({ voiceId: 'v1', text: 'Hello there' });
    expect(s.mime).toBe('audio/mpeg');
    expect(s.buffer.equals(readFileSync(VOICE))).toBe(true);

    expect(await cloneVoice({ sampleUrl: '/mock/voice.mp3', name: 'Me' })).toEqual({ voiceId: expect.stringMatching(/^mock-voice-/) });

    const voices = listVoices();
    expect(voices.length).toBeGreaterThanOrEqual(3);
    for (const v of voices) expect(Object.keys(v).sort()).toEqual(['gender', 'id', 'name', 'sampleUrl']);

    const m = await generateMusic({ prompt: 'warm acoustic', seconds: 30 });
    expect(m.mime).toBe('audio/mpeg');
    expect(m.buffer.equals(readFileSync('tests/fixtures/music.mp3'))).toBe(true);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(rep.runs).toHaveLength(0);
  });
});

describe('transcribe (real mode)', () => {
  beforeEach(() => vi.stubEnv('STORY_MOCK', '0'));

  it('uses Groq with word timestamps when GROQ_API_KEY is set', async () => {
    vi.stubEnv('GROQ_API_KEY', 'gsk');
    vi.stubEnv('REPLICATE_API_TOKEN', 'r8');
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        text: ' Hello world ',
        words: [{ word: 'Hello', start: 0, end: 0.4 }, { word: 'world', start: 0.5, end: 0.9 }],
      }));
    }));
    expect(await transcribe({ filePath: VOICE })).toEqual({
      text: 'Hello world',
      words: [{ w: 'Hello', start: 0, end: 0.4 }, { w: 'world', start: 0.5, end: 0.9 }],
    });
    expect(calls[0].url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect(calls[0].init.headers.Authorization).toBe('Bearer gsk');
    const form = calls[0].init.body;
    expect(form.get('model')).toBe('whisper-large-v3-turbo');
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.getAll('timestamp_granularities[]')).toEqual(['word']);
    expect(rep.runs).toHaveLength(0);
  });

  it('falls back to Replicate when Groq is rate limited', async () => {
    vi.stubEnv('GROQ_API_KEY', 'gsk');
    vi.stubEnv('REPLICATE_API_TOKEN', 'r8');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('busy', { status: 429 })));
    rep.output = {
      detected_language: 'en',
      segments: [{ start: 0, end: 1, text: ' Hi there', words: [{ word: 'Hi', start: 0, end: 0.3 }, { word: 'there' }] }],
    };
    expect(await transcribe({ filePath: VOICE })).toEqual({
      text: 'Hi there',
      words: [{ w: 'Hi', start: 0, end: 0.3 }, { w: 'there', start: 0.3, end: 1 }],
    });
    expect(rep.runs[0].model).toBe(MODEL_IDS.stt.replicate);
    expect(rep.runs[0].input.align_output).toBe(true);
    expect(Buffer.isBuffer(rep.runs[0].input.audio_file)).toBe(true);
  });

  it('uses Replicate when GROQ_API_KEY is not set', async () => {
    vi.stubEnv('GROQ_API_KEY', '');
    vi.stubEnv('REPLICATE_API_TOKEN', 'r8');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    rep.output = { segments: [] };
    expect(await transcribe({ filePath: VOICE })).toEqual({ text: '', words: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws config naming GROQ_API_KEY when neither transcriber is configured', async () => {
    vi.stubEnv('GROQ_API_KEY', '');
    vi.stubEnv('REPLICATE_API_TOKEN', '');
    await expect(transcribe({ filePath: VOICE })).rejects.toMatchObject({
      code: 'config', message: expect.stringContaining('GROQ_API_KEY'),
    });
  });
});

describe('tts / music (real mode)', () => {
  beforeEach(() => vi.stubEnv('STORY_MOCK', '0'));

  it('synthesize posts to Fish Audio and returns mp3 bytes', async () => {
    vi.stubEnv('FISH_API_KEY', 'fish');
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      calls.push({ url, init });
      return new Response(Buffer.from('MP3'), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    }));
    const out = await synthesize({ voiceId: 'abc', text: 'Once upon a time' });
    expect(out).toEqual({ buffer: Buffer.from('MP3'), mime: 'audio/mpeg' });
    expect(calls[0].url).toBe('https://api.fish.audio/v1/tts');
    expect(calls[0].init.headers).toMatchObject({ Authorization: 'Bearer fish', model: MODEL_IDS.tts });
    expect(JSON.parse(calls[0].init.body)).toMatchObject({ text: 'Once upon a time', reference_id: 'abc', format: 'mp3' });
  });

  it('synthesize throws config naming FISH_API_KEY when missing', async () => {
    vi.stubEnv('FISH_API_KEY', '');
    await expect(synthesize({ voiceId: 'a', text: 'b' })).rejects.toMatchObject({ code: 'config', message: expect.stringContaining('FISH_API_KEY') });
  });

  it('generateMusic decodes the Lyria audio block', async () => {
    vi.stubEnv('GOOGLE_AI_API_KEY', 'g');
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        steps: [{ type: 'model_output', content: [{ type: 'audio', data: Buffer.from('SONG').toString('base64') }] }],
      }));
    }));
    const out = await generateMusic({ prompt: 'calm piano', seconds: 20 });
    expect(out).toEqual({ buffer: Buffer.from('SONG'), mime: 'audio/mpeg' });
    expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(calls[0].init.headers['x-goog-api-key']).toBe('g');
    expect(JSON.parse(calls[0].init.body).model).toBe(MODEL_IDS.music.clip);
  });
});
