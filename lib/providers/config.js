/*
 * Every outside model id, endpoint and per-provider limit used by the story
 * pipeline lives here, so a model or price change is a one-file edit.
 * Internal identifiers only: never show these strings to customers.
 *
 * Prices and credit rates are NOT here; they live in lib/pricing.js.
 */

export const MODEL_IDS = {
  // Claude tiers (verified with the claude-api skill, cached 2026-11-03).
  llm: { fast: 'claude-haiku-5-5', smart: 'claude-sonnet-5-5' },
  // kie.ai Nano Banana Pro (same id pages/api/glow-up.js uses).
  image: 'nano-banana-pro',
  video: { kling: 'kling-3.0/video', seedance: 'bytedance/seedance-2-mini' },
  stt: {
    groq: 'whisper-large-v3-turbo',
    // victor-upmeet/whisperx pinned to its latest version on 2026-11-14.
    replicate: 'victor-upmeet/whisperx:655845d6190ef70573c669245f245892cd039df4b880a1e3a65852c09252f5cc',
  },
  // Fish Audio TTS model, sent in the `model` header.
  tts: 's2.1-pro',
  // Google Lyria via the Gemini API: the clip model always returns 30 s.
  music: { clip: 'lyria-3-clip-preview', song: 'lyria-3.5' },
};

/*
 * Story quality level -> video model settings. Kling resolution follows the
 * mode (std = 720p, pro = 1080p); Seedance takes an explicit resolution.
 */
export const QUALITY_MAP = {
  economy: { family: 'seedance', model: MODEL_IDS.video.seedance, resolution: '720p', sound: false },
  standard: { family: 'kling', model: MODEL_IDS.video.kling, mode: 'std', resolution: '720p', sound: false },
  pro_narrated: { family: 'kling', model: MODEL_IDS.video.kling, mode: 'pro', resolution: '1080p', sound: false },
  pro_talking: { family: 'kling', model: MODEL_IDS.video.kling, mode: 'pro', resolution: '1080p', sound: true },
};

export const PROVIDER_CONFIG = {
  // The story pipeline's kie calls (lib/providers/kieTasks.js) read these.
  // lib/kie.js keeps its own copies of the base URL and Kling model id for
  // the legacy tools (image-to-video, ugc-animate); keep the two in step.
  kie: {
    baseUrl: 'https://api.kie.ai/api/v1',
    createPath: '/jobs/createTask',
    recordPath: '/jobs/recordInfo',
    env: 'KIE_API_KEY',
    timeoutMs: 30 * 1000,
  },
  http: {
    // Default timeout for JSON calls to provider APIs.
    timeoutMs: 120 * 1000,
    // Media downloads (mirror, reference video, voice samples).
    downloadTimeoutMs: 10 * 60 * 1000,
    maxRedirects: 5,
  },
  kling: {
    minSeconds: 3,
    maxSeconds: 15,
    maxPromptChars: 2500,
    maxElements: 3,
    minElementImages: 2,
    maxElementImages: 4,
  },
  seedance: { minSeconds: 4, maxSeconds: 15 },
  image: { maxRefs: 8, defaultAspect: '9:16', defaultSize: '2K', outputFormat: 'png' },
  anthropic: {
    env: 'ANTHROPIC_API_KEY',
    defaultMaxTokens: 16000,
    effort: { fast: 'low', smart: 'medium' },
    // Server-side refusal fallback (beta). Haiku has no server-side fallback.
    fallback: { smart: { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } },
    maxToolTurns: 8,
  },
  groq: {
    env: 'GROQ_API_KEY',
    url: 'https://api.groq.com/openai/v1/audio/transcriptions',
    maxBytes: 25 * 1024 * 1024,
  },
  replicate: { env: 'REPLICATE_API_TOKEN', maxBytes: 25 * 1024 * 1024 },
  fish: {
    env: 'FISH_API_KEY',
    ttsUrl: 'https://api.fish.audio/v1/tts',
    modelUrl: 'https://api.fish.audio/model',
    mp3Bitrate: 128,
    maxSampleBytes: 20 * 1024 * 1024,
    // Curated narrator list (public Fish Audio models from the Narration
    // collection on fish.audio/discovery). sampleUrl is filled per voice once
    // a sample is mirrored; null means "no preview yet".
    voices: [
      { id: '933563129e564b19a115bedd57b7406a', name: 'Sarah', gender: 'female', sampleUrl: null },
      { id: 'bf322df2096a46f18c579d0baa36f41d', name: 'Adrian', gender: 'male', sampleUrl: null },
      { id: '536d3a5e000945adb7038665781a4aca', name: 'Ethan', gender: 'male', sampleUrl: null },
    ],
  },
  lyria: {
    env: 'GOOGLE_AI_API_KEY',
    url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
    apiRevision: '2026-05-20',
    clipSeconds: 30,
  },
  apify: {
    env: 'APIFY_TOKEN',
    baseUrl: 'https://api.apify.com/v2',
    timeoutSecs: 240,
    actors: {
      instagram: 'apify/instagram-scraper',
      tiktok: 'clockworks/tiktok-scraper',
      facebook: 'apify/facebook-reels-scraper',
    },
  },
  scrapecreators: {
    env: 'SCRAPECREATORS_API_KEY',
    baseUrl: 'https://api.scrapecreators.com',
    paths: { instagram: '/v1/instagram/post', tiktok: '/v2/tiktok/video', facebook: '/v1/facebook/post' },
  },
  reference: {
    maxBytes: 100 * 1024 * 1024,
    // Share-link hosts that redirect to a canonical post URL.
    shareHosts: ['vm.tiktok.com', 'vt.tiktok.com'],
  },
  storage: {
    mirrorMaxBytes: 200 * 1024 * 1024,
    r2Env: ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_URL'],
    blobEnv: 'BLOB_READ_WRITE_TOKEN',
    deleteBatch: 1000,
    // The only types storage will hold. The stored Content-Type comes from
    // the key's extension (never from the caller or the source), media is
    // confirmed by magic bytes, and non-media is served as an attachment.
    // Anything else (html, svg, js, no extension) is refused.
    mediaTypes: {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.mp4': 'video/mp4',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.m4a': 'audio/mp4',
    },
    attachmentTypes: {
      '.json': 'application/json',
      '.txt': 'text/plain',
      '.srt': 'application/x-subrip',
      '.vtt': 'text/vtt',
    },
  },
};
