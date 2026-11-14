import { NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'ibrahim3709@gmail.com')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// Gated "feature tab" page routes — hidden + blocked for non-admins when
// the feature-tabs flag is off. NOTE: /ugc-2 and /ugc-3 are deliberately
// excluded — they are direct ad-funnel landing pages and must stay
// reachable regardless of the toggle.
const GATED_PAGE_PREFIXES = [
  '/face-swap',
  '/ugc',
  '/glow-up',
  '/interior-design',
  '/video/editing',
  '/history',
];

/*
 * Middleware that:
 *   1. Refreshes the Supabase session cookie on every request.
 *   2. Gates protected API routes on authentication.
 *
 * Public routes: /, /sign-in, /sign-up, /api/auth/*, static assets.
 * Everything else that starts with /api/ requires a Supabase session.
 */
export async function middleware(req) {
  const res = NextResponse.next();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return res;

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      get: (name) => req.cookies.get(name)?.value,
      set: (name, value, options) => {
        res.cookies.set({ name, value, ...options });
      },
      remove: (name, options) => {
        res.cookies.set({ name, value: '', ...options, maxAge: 0 });
      },
    },
  });

  // Touches the session so it auto-refreshes if near expiry.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = req.nextUrl;

  // Provider webhooks (/api/webhooks/kie) carry no session; each route
  // checks its own token. Public even if a broader /api prefix is gated.
  if (pathname.startsWith('/api/webhooks/')) return res;

  // Gate the private API routes. Note:
  //   - /api/checkout is not here — subscription path supports
  //     anonymous users (pay first, sign up after).
  //   - /api/upload-token is not here — signed-out visitors on the
  //     pre-paywall pages (/, /ugc-2, /ugc-3, /local-business,
  //     /real-estate) upload a photo before sign-up. The route itself
  //     requires a session except for its 25 MB image-only
  //     'anon-image' tokens, and Vercel's upload callbacks carry no
  //     cookie.
  const privateApiPrefixes = [
    '/api/character-frame',
    '/api/swap',
    '/api/status',
    '/api/moderate-image',
    '/api/entitlement',
    '/api/extract-frame',
    '/api/image-to-video',
    '/api/ugc-image',
    '/api/ugc-animate',
    '/api/signup-ip',
    '/api/video',
    '/api/history',
    '/api/admin',
    '/api/story',
  ];
  // /api/story/pricing is public: the marketing pricing section reads it.
  const isPublicStoryApi = pathname === '/api/story/pricing';
  if (!isPublicStoryApi && privateApiPrefixes.some((p) => pathname.startsWith(p))) {
    if (!user) {
      return new NextResponse(
        JSON.stringify({ error: 'Authentication required.' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  // Protected pages \u2014 redirect anonymous users to sign-in.
  // /ugc is intentionally NOT here: it's a marketing landing for
  // anonymous visitors and the creator for authed users, gated inline
  // in pages/ugc.js (mirrors how / works for face-swap).
  const protectedPages = ['/dashboard', '/image-to-video', '/video/editing', '/history', '/admin', '/topup'];
  const isAppPage = pathname === '/app' || pathname.startsWith('/app/');
  if ((isAppPage || protectedPages.some((p) => pathname.startsWith(p))) && !user) {
    const redirect = req.nextUrl.clone();
    redirect.pathname = '/sign-in';
    // Send them back to where they were going once signed in.
    redirect.search = `?returnTo=${encodeURIComponent(pathname + req.nextUrl.search)}`;
    return NextResponse.redirect(redirect);
  }

  // Feature-tabs gate: when the flag is off, non-admins can't reach the
  // gated tab routes (they land on /app/tools). Admins always pass.
  // Exact-or-subpath match so '/ugc' does NOT catch '/ugc-2' or '/ugc-3'.
  const isGated = GATED_PAGE_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + '/')
  );
  if (isGated) {
    const email = (user?.email || '').toLowerCase();
    const isAdmin = ADMIN_EMAILS.includes(email);
    if (!isAdmin) {
      let enabled = true;
      try {
        const { data } = await supabase
          .from('app_settings')
          .select('feature_tabs_enabled')
          .eq('id', 'global')
          .single();
        enabled = Boolean(data?.feature_tabs_enabled);
      } catch {
        enabled = false; // fail closed
      }
      if (!enabled) {
        const redirect = req.nextUrl.clone();
        // Signed-out visitors go to the homepage; signed-in non-admins to the tools list.
        redirect.pathname = user ? '/app/tools' : '/';
        redirect.search = '';
        return NextResponse.redirect(redirect);
      }
    }
  }

  return res;
}

// Not matched on purpose (they do their own auth, with no Supabase session):
// /api/oauth/* and /.well-known/oauth-* (MCP connector OAuth server, which
// authenticates clients by PKCE and tokens), /oauth/consent (redirects to
// sign-in itself, keeping the authorization request), and /api/mcp (Bearer
// tokens; Task 26). Keep them out of the matcher and of privateApiPrefixes.
export const config = {
  matcher: [
    '/dashboard/:path*',
    '/image-to-video/:path*',
    '/video/editing/:path*',
    '/face-swap/:path*',
    '/ugc',
    '/glow-up/:path*',
    '/interior-design/:path*',
    '/api/character-frame/:path*',
    '/api/swap/:path*',
    '/api/status/:path*',
    '/api/moderate-image/:path*',
    '/api/entitlement/:path*',
    '/api/extract-frame/:path*',
    '/api/image-to-video/:path*',
    '/api/ugc-image/:path*',
    '/api/ugc-animate/:path*',
    '/api/signup-ip/:path*',
    '/api/video/:path*',
    '/api/history/:path*',
    '/history/:path*',
    '/api/admin/:path*',
    '/admin/:path*',
    '/topup',
    '/app',
    '/app/:path*',
    '/api/story/:path*',
  ],
};
