import Head from 'next/head';

const SUPPORT_EMAIL = 'support@davoxa.com';

/** Plain text page for the privacy policy and terms (marketing chrome comes from _app). */
export default function LegalPage({ title, updated, sections }) {
  return (
    <>
      <Head>
        <title>{`${title} | Sonallo`}</title>
      </Head>
      <main style={{ maxWidth: 760, margin: '0 auto', padding: '120px 20px 80px', lineHeight: 1.65 }}>
        <h1 style={{ fontSize: 'clamp(30px, 5vw, 42px)', lineHeight: 1.15, margin: '0 0 8px' }}>{title}</h1>
        <p style={{ opacity: 0.6, margin: '0 0 32px' }}>Last updated {updated}</p>
        {sections.map((s) => (
          <section key={s.heading} style={{ marginBottom: 28 }}>
            <h2 style={{ fontSize: 20, margin: '0 0 8px' }}>{s.heading}</h2>
            {s.body.map((p) => (
              <p key={p.slice(0, 40)} style={{ margin: '0 0 10px' }}>{p}</p>
            ))}
          </section>
        ))}
        <p>
          Questions? Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
        </p>
      </main>
    </>
  );
}
