import { useCallback, useEffect, useRef, useState } from 'react';
import Head from 'next/head';

import Button from '../../components/ui/Button';
import Card from '../../components/ui/Card';
import { AssetThumb } from '../../components/maker/AssetPicker';
import ErrorNotice from '../../components/maker/ErrorNotice';
import { Icon, Skeleton } from '../../components/maker/Tiles';
import { deleteAsset, getAssets, getBrand, saveBrand, uploadMedia } from '../../lib/story/client';
import { BRAND_LIMITS, cleanColor } from '../../lib/story/assetRules';
import styles from '../../styles/Brand.module.css';

const SECTIONS = [
  { kind: 'logo', title: 'Logo', hint: 'Your logo, on its own.', empty: 'No logo yet', icon: 'image', accept: 'image' },
  { kind: 'product', title: 'Product pictures', hint: 'New videos draw on these, so your product looks like your product.', empty: 'No product pictures yet', icon: 'image', accept: 'image' },
  { kind: 'mascot', title: 'Mascots and characters', hint: 'A character picture you can use for a person in a video.', empty: 'No mascots yet', icon: 'user', accept: 'image' },
  { kind: 'recording', title: 'Screen recordings', hint: 'Your own app or screen, to use as a shot or a picture-in-picture.', empty: 'No recordings yet', icon: 'film', accept: 'video' },
  { kind: 'clip', title: 'Your clips', hint: 'Footage you filmed, to use as a shot or a picture-in-picture.', empty: 'No clips yet', icon: 'film', accept: 'video' },
];
const ACCEPT = { image: '.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp', video: '.mp4,.mov,.mov,video/mp4,video/quicktime' };
const LIMIT_TEXT = { image: 'PNG, JPG or WebP, up to 5 MB', video: 'MP4 or MOV, up to 200 MB and 5 minutes' };

/** The words a refused delete shows: the videos that still use the file. */
function InUse({ error }) {
  const projects = error?.body?.projects || [];
  const voices = error?.body?.voices || [];
  return (
    <div className={styles.inUse} role="alert" data-code="asset_in_use">
      <strong>This file is in use</strong>
      <span>{error.serverMessage}</span>
      {(projects.length > 0 || voices.length > 0) && (
        <ul>
          {projects.map((p) => <li key={p.id}><a href={`/app/p/${p.id}`}>{p.title || 'Untitled video'}</a></li>)}
          {voices.map((v) => <li key={v.id}>Voice: {v.name}</li>)}
        </ul>
      )}
    </div>
  );
}

function AssetItem({ asset, isLogo, busy, confirming, onUseLogo, onAskDelete, onKeep, onDelete }) {
  return (
    <li className={styles.item} data-asset={asset.id}>
      <AssetThumb asset={asset} className={styles.thumbBox} />
      <span className={styles.itemName} title={asset.name}>{asset.name}</span>
      {confirming ? (
        <span className={styles.confirm} role="group" aria-label={`Delete ${asset.name}`}>
          <button type="button" className={styles.danger} onClick={onDelete} disabled={busy}>Delete it</button>
          <button type="button" className={styles.link} onClick={onKeep}>Keep it</button>
        </span>
      ) : (
        <span className={styles.itemActions}>
          {asset.kind === 'logo' && (
            <button type="button" className={styles.link} onClick={onUseLogo} aria-pressed={isLogo} disabled={busy || isLogo}>{isLogo ? 'Your logo' : 'Use as my logo'}</button>
          )}
          <button type="button" className={styles.link} onClick={onAskDelete} aria-label={`Delete ${asset.name}`} disabled={busy}>Delete</button>
        </span>
      )}
    </li>
  );
}

function Section({ section, assets, logoId, progress, busyId, confirmId, onFile, onUseLogo, onAskDelete, onKeep, onDelete }) {
  const input = useRef(null);
  const mine = assets.filter((a) => a.kind === section.kind);
  const uploading = progress[section.kind] != null;
  return (
    <section className={styles.section} aria-label={section.title} data-section={section.kind}>
      <div className={styles.sectionHead}>
        <h3>{section.title}</h3>
        <input ref={input} type="file" accept={ACCEPT[section.accept]} className={styles.file} tabIndex={-1} aria-hidden="true" onChange={(e) => onFile(e, section.kind)} />
        <Button variant="ghost" size="sm" arrow={false} onClick={() => input.current?.click()} disabled={uploading}>
          {uploading ? `Uploading ${progress[section.kind]}%` : 'Upload'}
        </Button>
      </div>
      {mine.length === 0 ? (
        <div className={styles.emptyRow} data-empty={section.kind}>
          <span className={styles.emptyIcon} aria-hidden="true"><Icon name={section.icon} size={18} /></span>
          <span className={styles.emptyText}>
            <strong>{section.empty}</strong>
            <small>{section.hint} {LIMIT_TEXT[section.accept]}.</small>
          </span>
          <Button variant="ghost" size="sm" arrow={false} onClick={() => input.current?.click()} disabled={uploading}>Upload one</Button>
        </div>
      ) : (
        <ul className={styles.grid}>
          {mine.map((a) => (
            <AssetItem
              key={a.id}
              asset={a}
              isLogo={a.id === logoId}
              busy={busyId === a.id}
              confirming={confirmId === a.id}
              onUseLogo={() => onUseLogo(a)}
              onAskDelete={() => onAskDelete(a.id)}
              onKeep={onKeep}
              onDelete={() => onDelete(a)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** One colour: a picker and its hex text. */
function ColorRow({ value, onChange, onRemove, index }) {
  return (
    <li className={styles.color}>
      <input type="color" value={cleanColor(value) || '#000000'} aria-label={`Colour ${index + 1}`} onChange={(e) => onChange(e.target.value)} />
      <code>{cleanColor(value) || value}</code>
      <button type="button" className={styles.link} onClick={onRemove} aria-label={`Remove colour ${index + 1}`}>Remove</button>
    </li>
  );
}

export default function BrandPage() {
  const [brand, setBrand] = useState(null);
  const [assets, setAssets] = useState(null);
  const [form, setForm] = useState({ offer: '', audience: '', tone: '', avoid: '', colors: [] });
  const [dirty, setDirty] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [progress, setProgress] = useState({});
  const [busyId, setBusyId] = useState('');
  const [confirmId, setConfirmId] = useState('');
  const alive = useRef(true);

  const fill = (b) => setForm({ offer: b.offer || '', audience: b.audience || '', tone: b.tone || '', avoid: (b.avoid || []).join('\n'), colors: b.colors || [] });

  const load = useCallback(async () => {
    try {
      const [b, list] = await Promise.all([getBrand(), getAssets({ brand: true })]);
      if (!alive.current) return;
      setBrand(b);
      setAssets(list);
      setLoadError(null);
      return b;
    } catch (err) {
      if (alive.current) setLoadError(err);
    }
    return null;
  }, []);

  useEffect(() => {
    alive.current = true;
    load().then((b) => { if (b && alive.current) fill(b); });
    return () => { alive.current = false; };
  }, [load]);

  const set = (key) => (e) => { setForm((f) => ({ ...f, [key]: e.target.value })); setDirty(true); setSaved(false); };

  async function onSave(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const next = await saveBrand({
        offer: form.offer.trim() || null,
        audience: form.audience.trim() || null,
        tone: form.tone.trim() || null,
        avoid: form.avoid,
        colors: form.colors.map((c) => cleanColor(c)).filter(Boolean),
      });
      if (!alive.current) return;
      setBrand(next);
      fill(next);
      setDirty(false);
      setSaved(true);
    } catch (err) {
      if (alive.current) setError(err);
    } finally {
      if (alive.current) setSaving(false);
    }
  }

  async function onFile(e, kind) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    setProgress((p) => ({ ...p, [kind]: 0 }));
    try {
      const made = await uploadMedia(file, kind, { inBrandKit: true, onProgress: (n) => alive.current && setProgress((p) => ({ ...p, [kind]: n })) });
      if (!alive.current) return;
      setAssets((list) => [made, ...(list || [])]);
      // The first logo is the brand's logo.
      if (kind === 'logo' && !brand?.logo) setBrand(await saveBrand({ logoAssetId: made.id }));
    } catch (err) {
      if (alive.current) setError(err);
    } finally {
      if (alive.current) setProgress((p) => ({ ...p, [kind]: null }));
    }
  }

  async function onUseLogo(asset) {
    setBusyId(asset.id);
    setError(null);
    try {
      setBrand(await saveBrand({ logoAssetId: asset.id }));
    } catch (err) {
      setError(err);
    } finally {
      setBusyId('');
    }
  }

  async function onDelete(asset) {
    setBusyId(asset.id);
    setError(null);
    try {
      await deleteAsset(asset.id);
      setConfirmId('');
      await load();
    } catch (err) {
      setConfirmId('');
      setError(err);
      if (err?.status === 404) await load();
    } finally {
      setBusyId('');
    }
  }

  const colors = form.colors;
  const wide = assets && assets.length > 0;

  return (
    <>
      <Head><title>Brand kit | Ariya Lab</title></Head>
      <div className={styles.page}>
        <div className={styles.header}>
          <div>
            <h1 className={styles.title}>Your <span className="accent-word">brand kit</span></h1>
            <p className={styles.sub}>Tell us once what you offer and how you sound. New videos start with it, and your pictures and clips are ready to use in any of them.</p>
          </div>
        </div>

        {error?.code === 'asset_in_use' ? <InUse error={error} /> : <ErrorNotice error={loadError || error} returnTo="/app/brand" onRefresh={load} />}
        {loadError && <div className={styles.actions}><Button variant="ghost" arrow={false} onClick={load}>Refresh</Button></div>}
        {!brand && !loadError && <div className={styles.wait}><Skeleton status="Loading your brand kit" ratio="16 / 5" /></div>}

        {brand && (
          <div className={styles.layout}>
            <Card className={styles.card} data-card="brand-text">
              <h2 className={styles.h2}><span className={styles.icon}><Icon name="text" size={18} /></span>About your brand</h2>
              <form className={styles.form} onSubmit={onSave}>
                <label className={styles.field}>
                  What you offer
                  <textarea rows={3} maxLength={BRAND_LIMITS.offer} value={form.offer} onChange={set('offer')} placeholder="Haircuts that last, booked in two taps." />
                </label>
                <label className={styles.field}>
                  Who it is for
                  <input type="text" maxLength={BRAND_LIMITS.audience} value={form.audience} onChange={set('audience')} placeholder="Busy dads who hate waiting." />
                </label>
                <label className={styles.field}>
                  How you sound
                  <input type="text" maxLength={BRAND_LIMITS.tone} value={form.tone} onChange={set('tone')} placeholder="Warm, plain, a little funny." />
                </label>
                <label className={styles.field}>
                  Words to avoid
                  <textarea rows={2} value={form.avoid} onChange={set('avoid')} placeholder={'One per line, or separated by commas.\nhustle, cheap'} aria-describedby="avoid-hint" />
                  <small id="avoid-hint" className={styles.hint}>Scripts are checked against this list, and any line that uses one is flagged. Up to {BRAND_LIMITS.avoidWords} words or short phrases.</small>
                </label>
                <fieldset className={styles.colors}>
                  <legend>Brand colours</legend>
                  {colors.length === 0 && <p className={styles.hint}>No colours yet. Add up to {BRAND_LIMITS.colors}.</p>}
                  <ul>
                    {colors.map((c, i) => (
                      <ColorRow key={i} index={i} value={c}
                        onChange={(v) => { setForm((f) => ({ ...f, colors: f.colors.map((x, j) => (j === i ? v : x)) })); setDirty(true); setSaved(false); }}
                        onRemove={() => { setForm((f) => ({ ...f, colors: f.colors.filter((_, j) => j !== i) })); setDirty(true); setSaved(false); }} />
                    ))}
                  </ul>
                  <Button variant="ghost" size="sm" arrow={false} disabled={colors.length >= BRAND_LIMITS.colors}
                    onClick={() => { setForm((f) => ({ ...f, colors: [...f.colors, '#7c5cff'] })); setDirty(true); setSaved(false); }}>Add a colour</Button>
                </fieldset>
                <div className={styles.actions}>
                  <Button type="submit" arrow={false} disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save my brand'}</Button>
                  {saved && !dirty && <span className={styles.saved} role="status">Saved. New videos start with this.</span>}
                </div>
              </form>
            </Card>

            <div className={styles.files}>
              <h2 className={styles.h2}><span className={styles.icon}><Icon name="image" size={18} /></span>Pictures and clips</h2>
              {assets === null && <div className={styles.wait}><Skeleton status="Loading your files" ratio="16 / 5" /></div>}
              {assets && (
                <div className={`${styles.sections} ${wide ? '' : styles.sectionsEmpty}`}>
                  {SECTIONS.map((s) => (
                    <Section
                      key={s.kind}
                      section={s}
                      assets={assets}
                      logoId={brand.logo?.id}
                      progress={progress}
                      busyId={busyId}
                      confirmId={confirmId}
                      onFile={onFile}
                      onUseLogo={onUseLogo}
                      onAskDelete={setConfirmId}
                      onKeep={() => setConfirmId('')}
                      onDelete={onDelete}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
