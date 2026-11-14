import Head from 'next/head';

import Hero from '../components/marketing/Hero';
import VideoRail from '../components/marketing/VideoRail';
import HowItWorks from '../components/marketing/HowItWorks';
import PricingSection from '../components/marketing/PricingSection';
import Faq from '../components/marketing/Faq';
import ClosingCta from '../components/marketing/ClosingCta';

export default function Home() {
  return (
    <>
      <Head>
        <title>Ariya Lab | Animated story videos</title>
        <meta
          name="description"
          content="Describe your story or start from a video you like. Get a finished, captioned animated video in minutes."
        />
      </Head>
      <main style={{ overflowX: 'clip' }}>
        <Hero />
        <VideoRail />
        <HowItWorks />
        <PricingSection />
        <Faq />
        <ClosingCta />
      </main>
    </>
  );
}
