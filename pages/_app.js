import { useEffect } from 'react';
import Script from 'next/script';
import { useRouter } from 'next/router';

import '../styles/theme.css';
import '../styles/globals.css';
import AppHead from '../components/AppHead';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import MetaPixel from '../components/MetaPixel';
import TikTokPixel from '../components/TikTokPixel';
import TikTokRouteEvents from '../components/TikTokRouteEvents';
import ClarityTracker from '../components/ClarityTracker';
import MarketingNav from '../components/marketing/MarketingNav';
import MarketingFooter from '../components/marketing/MarketingFooter';
import AppShell from '../components/app/AppShell';

const MARKETING_ROUTES = new Set(['/', '/pricing', '/privacy', '/terms']);

// Chrome by route: marketing pages, the signed-in app, or the legacy tools.
function chromeFor(pathname) {
  if (MARKETING_ROUTES.has(pathname)) return 'marketing';
  if (pathname === '/app' || pathname.startsWith('/app/')) return 'app';
  return 'legacy';
}

export default function App({ Component, pageProps }) {
  const { pathname } = useRouter();
  const chrome = chromeFor(pathname);
  // Capture ad-click params (utm_* / fbclid / …) from the landing URL so
  // checkout can stamp them into Stripe metadata for /tracking.
  useEffect(() => {
    import('../lib/adAttribution')
      .then((m) => m.captureAdParamsOnLoad())
      .catch(() => {});
  }, []);

  return (
    <>
      <AppHead />
      <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" />
      <MetaPixel />
      <TikTokPixel />
      <TikTokRouteEvents />
      <ClarityTracker />
      {chrome === 'app' ? (
        <AppShell>
          <Component {...pageProps} />
        </AppShell>
      ) : chrome === 'marketing' ? (
        <>
          <MarketingNav />
          <Component {...pageProps} />
          <MarketingFooter />
        </>
      ) : (
        <>
          <Navbar />
          <Component {...pageProps} />
          <Footer />
        </>
      )}
    </>
  );
}
