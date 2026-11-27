import Head from 'next/head';

export const SITE_URL = 'https://sonallo.com';
export const OG_DEFAULTS = {
  title: 'Sonallo | Animated story videos',
  description: 'Describe your story or start from a video you like. Get a finished, captioned animated video in minutes.',
  url: SITE_URL,
  image: `${SITE_URL}/og-image.jpg`,
};

/** Open Graph + Twitter link-preview tags. Keyed so a page's own copy replaces the layout default. */
export default function OgTags({ title = OG_DEFAULTS.title, description = OG_DEFAULTS.description, url = OG_DEFAULTS.url, image = OG_DEFAULTS.image }) {
  return (
    <Head>
      <meta key="og:type" property="og:type" content="website" />
      <meta key="og:site_name" property="og:site_name" content="Sonallo" />
      <meta key="og:title" property="og:title" content={title} />
      <meta key="og:description" property="og:description" content={description} />
      <meta key="og:url" property="og:url" content={url} />
      <meta key="og:image" property="og:image" content={image} />
      <meta key="og:image:width" property="og:image:width" content="1200" />
      <meta key="og:image:height" property="og:image:height" content="630" />
      <meta key="twitter:card" name="twitter:card" content="summary_large_image" />
      <meta key="twitter:title" name="twitter:title" content={title} />
      <meta key="twitter:description" name="twitter:description" content={description} />
      <meta key="twitter:image" name="twitter:image" content={image} />
    </Head>
  );
}
