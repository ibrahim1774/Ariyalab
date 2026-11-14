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
