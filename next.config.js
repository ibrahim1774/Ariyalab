// The old Ariya Lab tools and funnels still ship in this codebase, but sonallo.com is the story video
// maker: these pages belong on www.ariyalab.online, which serves them from its own (classic) branch.
// Not redirected on purpose, because the Sonallo app still uses them:
//   /dashboard         Stripe success_url / cancel_url; it finalizes the paid session, then goes to /app.
//   /ugc-2/claim, /ugc-2/welcome   the pay-first claim pages the checkout API still builds URLs for.
//   /sign-up, /sign-in, /pricing, /privacy, /terms, /support, /app/*, /tracking, /admin/*, /oauth/*.
// Exact sources only (no :path*), so the kept sub-pages above are never caught. permanent: false so the
// move can be undone without browsers remembering it.
const CLASSIC_HOST = 'https://www.ariyalab.online';
const CLASSIC_PATHS = [
  '/ugc',
  '/ugc-2',
  '/ugc-3',
  '/local-business',
  '/local-business/pricing-plan',
  '/real-estate',
  '/real-estate/pricing-plan',
  '/interior-design',
  '/image-to-video',
  '/history',
  '/topup',
  '/video/editing',
  '/face-swap',
  '/glow-up',
];
const classicRedirects = [
  ...CLASSIC_PATHS.map((source) => ({ source, destination: `${CLASSIC_HOST}${source}`, permanent: false })),
  { source: '/legacy-home', destination: `${CLASSIC_HOST}/`, permanent: false },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    // Re-export VITE_* vars (inherited from a sibling project's Vercel
    // config) as NEXT_PUBLIC_* so Next.js inlines them into the
    // client bundle. Saves the user from adding duplicate keys.
    NEXT_PUBLIC_SUPABASE_URL:
      process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      process.env.VITE_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_GOOGLE_CLIENT_ID:
      process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ||
      process.env.VITE_GOOGLE_CLIENT_ID,
  },
  // The render worker (lib/story/render.js) reads the caption font from public/fonts at run time and runs
  // the platform ffmpeg binary, which is loaded by a dynamic import that file tracing cannot follow. The other
  // routes that run ffmpeg (reference analysis, audio jobs and audio actions, asset and voice sample checks) load it
  // the same way. Keys are picomatch globs matched anywhere in the route ([action] escaped: a literal segment name).
  experimental: {
    outputFileTracingIncludes: {
      '/api/story/render-worker': ['./public/fonts/**/*', './node_modules/@ffmpeg-installer/linux-x64/**/*'],
      '/api/story/worker/analyze': ['./node_modules/@ffmpeg-installer/linux-x64/**/*'],
      '/api/story/worker/audio': ['./node_modules/@ffmpeg-installer/linux-x64/**/*'],
      '/api/story/assets': ['./node_modules/@ffmpeg-installer/linux-x64/**/*'],
      '/api/story/voices': ['./node_modules/@ffmpeg-installer/linux-x64/**/*'],
      '/api/story/projects/*/analyze': ['./node_modules/@ffmpeg-installer/linux-x64/**/*'],
      '/api/story/projects/*/\\[action\\]': ['./node_modules/@ffmpeg-installer/linux-x64/**/*'],
    },
  },
  async redirects() {
    return classicRedirects;
  },
  // OAuth discovery for the MCP connector (lib/mcp/oauth.js). Clients try
  // the bare well-known paths and the path-suffixed forms (RFC 8414 3.1,
  // RFC 9728 3.1: /.well-known/oauth-protected-resource/api/mcp).
  async rewrites() {
    return [
      { source: '/.well-known/oauth-authorization-server', destination: '/api/oauth/metadata' },
      { source: '/.well-known/oauth-authorization-server/:path*', destination: '/api/oauth/metadata' },
      { source: '/.well-known/oauth-protected-resource', destination: '/api/oauth/protected-resource' },
      // Only the MCP endpoint's own path-suffixed form; other suffixes 404.
      { source: '/.well-known/oauth-protected-resource/api/mcp', destination: '/api/oauth/protected-resource' },
    ];
  },
  // Sign-in, sign-up and the OAuth consent page must never be framed
  // (clickjacking); sign-in reaches the consent page by client-side
  // navigation, so it needs the headers too.
  async headers() {
    const noFraming = [
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
    ];
    return [
      { source: '/oauth/:path*', headers: noFraming },
      { source: '/sign-in', headers: noFraming },
      { source: '/sign-in/:path*', headers: noFraming },
      { source: '/sign-up', headers: noFraming },
      { source: '/sign-up/:path*', headers: noFraming },
    ];
  },
};

module.exports = nextConfig;
