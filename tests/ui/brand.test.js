// @vitest-environment jsdom
// Task 23: the brand kit page, the asset picker, footage and picture-in-picture controls on a shot, and the character's own picture.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

vi.mock('../../lib/story/client', async (importOriginal) => {
  const actual = await importOriginal();
  const mocked = {};
  for (const [key, value] of Object.entries(actual)) {
    mocked[key] = typeof value === 'function' && key !== 'StoryApiError' && key !== 'normalizeError' && key !== 'checkMedia' ? vi.fn() : value;
  }
  return mocked;
});
vi.mock('next/router', () => ({ useRouter: () => ({ replace: vi.fn(), isReady: true, query: {}, asPath: '/app/brand', pathname: '/app/brand' }) }));
vi.mock('next/head', () => ({ default: ({ children }) => <>{children}</> }));

const client = await import('../../lib/story/client');
const { StoryApiError } = client;
const { default: BrandPage } = await import('../../pages/app/brand');
const { default: AssetPicker } = await import('../../components/maker/AssetPicker');
const { default: ShotCard } = await import('../../components/maker/ShotCard');
const { default: StepCast } = await import('../../components/maker/StepCast');
const { PricingProvider } = await import('../../components/maker/PricingContext').then((m) => ({ PricingProvider: m.default || m.PricingProvider }));

const asset = (over = {}) => ({ id: 'a1', kind: 'logo', name: 'logo', url: '/api/mock/storage/story-brand/u/logo.png', seconds: null, bytes: 1000, width: 96, height: 64, inBrandKit: true, ...over });
const emptyBrand = { offer: null, audience: null, tone: null, avoid: [], colors: [], logo: null };
const file = (name = 'logo.png', type = 'image/png', size = 1000) => new File([new Uint8Array(size)], name, { type });

beforeEach(() => {
  for (const fn of Object.values(client)) if (typeof fn?.mockReset === 'function') fn.mockReset();
});
afterEach(() => cleanup());

async function openBrand({ brand = emptyBrand, assets = [] } = {}) {
  client.getBrand.mockResolvedValue(brand);
  client.getAssets.mockResolvedValue(assets);
  const utils = render(<BrandPage />);
  await screen.findByRole('heading', { name: /brand kit/i, level: 1 });
  await waitFor(() => expect(screen.queryByText('Loading your brand kit')).not.toBeInTheDocument());
  return utils;
}

describe('the brand kit page', () => {
  it('shows a designed empty state for every kind of file, and an empty form', async () => {
    await openBrand();
    for (const text of ['No logo yet', 'No product pictures yet', 'No mascots yet', 'No recordings yet', 'No clips yet']) expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getByLabelText('What you offer')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Save my brand' })).toBeDisabled();
    expect(client.getAssets).toHaveBeenCalledWith({ brand: true });
  });

  it('saves the text fields, the avoid words and the colours', async () => {
    client.saveBrand.mockImplementation(async (p) => ({ ...emptyBrand, ...p, avoid: String(p.avoid).split(/[\n,]/).map((w) => w.trim()).filter(Boolean) }));
    await openBrand({ brand: { ...emptyBrand, offer: 'Haircuts', avoid: ['cheap'] } });
    expect(screen.getByLabelText('What you offer')).toHaveValue('Haircuts');
    expect(screen.getByLabelText(/Words to avoid/)).toHaveValue('cheap');
    fireEvent.change(screen.getByLabelText('How you sound'), { target: { value: 'Warm and plain' } });
    fireEvent.change(screen.getByLabelText(/Words to avoid/), { target: { value: 'cheap, hustle' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add a colour' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save my brand' }));
    await waitFor(() => expect(client.saveBrand).toHaveBeenCalledWith({ offer: 'Haircuts', audience: null, tone: 'Warm and plain', avoid: 'cheap, hustle', colors: ['#7c5cff'] }));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved');
    expect(screen.getByLabelText(/Words to avoid/)).toHaveValue('cheap\nhustle');
  });

  it("shows the server's own words when a save is refused", async () => {
    client.saveBrand.mockRejectedValue(new StoryApiError({ status: 422, code: 'validation_failed', message: 'Use up to 6 colours, each as a hex value like #1a2b3c.', field: 'colors' }));
    await openBrand();
    fireEvent.change(screen.getByLabelText('Who it is for'), { target: { value: 'dads' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save my brand' }));
    expect(await screen.findByText(/Use up to 6 colours/)).toBeInTheDocument();
  });

  it('uploads a logo, which becomes the brand logo when it is the first', async () => {
    const made = asset({ id: 'n1', name: 'mark' });
    client.uploadMedia.mockResolvedValue(made);
    client.saveBrand.mockResolvedValue({ ...emptyBrand, logo: made });
    await openBrand();
    const section = document.querySelector('[data-section="logo"]');
    const input = section.querySelector('input[type="file"]');
    await act(async () => { fireEvent.change(input, { target: { files: [file('mark.png')] } }); });
    await waitFor(() => expect(client.uploadMedia).toHaveBeenCalledWith(expect.any(File), 'logo', expect.objectContaining({ inBrandKit: true })));
    await waitFor(() => expect(client.saveBrand).toHaveBeenCalledWith({ logoAssetId: 'n1' }));
    expect(await within(section).findByText('mark')).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Your logo' })).toBeDisabled();
  });

  it('says why an upload was refused and keeps the page as it was', async () => {
    client.uploadMedia.mockRejectedValue(new StoryApiError({ status: 422, code: 'validation_failed', message: 'We could not read that file as a picture. Upload a PNG, JPG or WebP file.' }));
    await openBrand();
    const input = document.querySelector('[data-section="product"] input[type="file"]');
    await act(async () => { fireEvent.change(input, { target: { files: [file('x.png')] } }); });
    expect(await screen.findByText(/could not read that file as a picture/)).toBeInTheDocument();
    expect(screen.getByText('No product pictures yet')).toBeInTheDocument();
  });

  it('asks before deleting, and a file in use lists the videos that use it, with a link to each', async () => {
    client.deleteAsset.mockRejectedValue(new StoryApiError({
      status: 409, code: 'asset_in_use', message: 'This file is used in "Barber ad". Take it out of that video first, then delete it.',
      body: { projects: [{ id: 'p9', title: 'Barber ad' }], voices: [] },
    }));
    await openBrand({ assets: [asset({ id: 'c1', kind: 'clip', name: 'shopfront', seconds: 12 })] });
    fireEvent.click(screen.getByRole('button', { name: 'Delete shopfront' }));
    const group = screen.getByRole('group', { name: 'Delete shopfront' });
    fireEvent.click(within(group).getByRole('button', { name: 'Delete it' }));
    await waitFor(() => expect(client.deleteAsset).toHaveBeenCalledWith('c1'));
    const note = await screen.findByText('This file is in use');
    expect(note.closest('[data-code="asset_in_use"]')).toHaveTextContent('Barber ad');
    expect(screen.getByRole('link', { name: 'Barber ad' })).toHaveAttribute('href', '/app/p/p9');
  });

  it('deletes an unused file and reloads the list', async () => {
    client.deleteAsset.mockResolvedValue({ id: 'a1' });
    await openBrand({ assets: [asset({ kind: 'product', name: 'bottle' })] });
    fireEvent.click(screen.getByRole('button', { name: 'Delete bottle' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Delete bottle' })).getByRole('button', { name: 'Delete it' }));
    await waitFor(() => expect(client.deleteAsset).toHaveBeenCalledWith('a1'));
    await waitFor(() => expect(client.getAssets).toHaveBeenCalledTimes(2));
  });

  it('keeps a failed load recoverable', async () => {
    client.getBrand.mockRejectedValue(new StoryApiError({ status: 0, code: 'network' }));
    client.getAssets.mockRejectedValue(new StoryApiError({ status: 0, code: 'network' }));
    render(<BrandPage />);
    expect(await screen.findByText('No connection')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });
});

describe('the asset picker', () => {
  const open = async (props = {}) => {
    render(<AssetPicker kinds={['clip', 'recording']} uploadKind="clip" label="Use my footage" {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use my footage' }));
    return screen.findByRole('dialog');
  };

  it('is designed when empty, and uploads into the kind it was given', async () => {
    client.getAssets.mockResolvedValue([]);
    const made = asset({ id: 'n2', kind: 'clip', name: 'take', seconds: 9 });
    client.uploadMedia.mockResolvedValue(made);
    const dialog = await open();
    expect(await within(dialog).findByText('No clip or screen recording yet')).toBeInTheDocument();
    expect(client.getAssets).toHaveBeenCalledWith({ kinds: ['clip', 'recording'] });
    const input = dialog.querySelector('input[type="file"]');
    await act(async () => { fireEvent.change(input, { target: { files: [file('take.mp4', 'video/mp4')] } }); });
    await waitFor(() => expect(client.uploadMedia).toHaveBeenCalledWith(expect.any(File), 'clip', expect.objectContaining({ inBrandKit: false })));
    expect(await within(dialog).findByRole('button', { name: 'Use take' })).toBeInTheDocument();
  });

  it('an upload from the picker stays out of the brand kit; only the brand page puts a file in it', async () => {
    client.getAssets.mockResolvedValue([]);
    client.uploadMedia.mockResolvedValue(asset({ id: 'n3', kind: 'image', name: 'inset' }));
    render(<AssetPicker kinds={['image', 'product']} uploadKind="image" label="Add a picture-in-picture" />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a picture-in-picture' }));
    const dialog = await screen.findByRole('dialog');
    await act(async () => { fireEvent.change(dialog.querySelector('input[type="file"]'), { target: { files: [file('inset.png')] } }); });
    await waitFor(() => expect(client.uploadMedia).toHaveBeenCalledWith(expect.any(File), 'image', expect.objectContaining({ inBrandKit: false })));
  });

  it('refuses a wrong file type before anything is uploaded, in the server words', async () => {
    client.getAssets.mockResolvedValue([]);
    const dialog = await open();
    const input = dialog.querySelector('input[type="file"]');
    await act(async () => { fireEvent.change(input, { target: { files: [file('notes.pdf', 'application/pdf')] } }); });
    expect(await within(dialog).findByText('Only MP4 and MOV clips can be used.')).toBeInTheDocument();
    expect(client.uploadMedia).not.toHaveBeenCalled();
  });

  it('picks a file, calls onPick with it and closes; an error stays in the chooser', async () => {
    client.getAssets.mockResolvedValue([asset({ id: 'c1', kind: 'clip', name: 'shopfront', seconds: 12 }), asset({ id: 'c2', kind: 'recording', name: 'app', seconds: 30 })]);
    const onPick = vi.fn().mockRejectedValueOnce(new StoryApiError({ status: 404, code: 'not_found', message: 'That file was not found.' })).mockResolvedValue();
    const dialog = await open({ onPick, selectedId: 'c2' });
    expect(within(dialog).getByRole('button', { name: 'In use: app' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Use shopfront' }));
    expect(await within(dialog).findByText('That file was not found.')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use shopfront' }));
    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(2));
    expect(onPick.mock.calls[1][0]).toMatchObject({ id: 'c1' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

const shot = (over = {}) => ({
  id: 's1', ord: 0, scene_id: 'sc1', description: 'Maya sweeps the shop.', line: 'Nobody believed.', seconds: 5, quality: 'standard', source: 'generated', status: 'still_ready',
  still_url: '/still/0.png', stale: false, retry_credits: null, still_credits: 0, footage_asset_id: null, footage: null, inset_asset_id: null, inset: null, footage_url: null, inset_url: null, ...over,
});
const project = { id: 'p1', mode: 'narrated', quality: 'standard' };
const renderShot = (s, extra = {}) => render(
  <PricingProvider value={{ stillReroll: 2, castRegen: 5, included: { castRegenPerCharacter: 2 } }}>
    <ShotCard shot={s} project={project} onChanged={vi.fn()} returnTo="/" {...extra} />
  </PricingProvider>
);

describe('footage and picture-in-picture on a shot', () => {
  it('offers footage and a picture-in-picture, and sets a clip as the shot\'s source', async () => {
    client.updateShot.mockResolvedValue({});
    client.getAssets.mockResolvedValue([asset({ id: 'c1', kind: 'clip', name: 'shopfront', seconds: 12 })]);
    renderShot(shot());
    fireEvent.click(screen.getByRole('button', { name: 'Use my footage' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Use shopfront' }));
    await waitFor(() => expect(client.updateShot).toHaveBeenCalledWith('p1', 's1', { source: 'footage', footage_asset_id: 'c1' }));
  });

  it('a footage shot shows its clip, its trim and fit, and goes back to generated', async () => {
    client.updateShot.mockResolvedValue({});
    renderShot(shot({ source: 'footage', footage_asset_id: 'c1', footage_url: '/api/mock/storage/story-brand/u/c.mp4', footage: { trimStart: 1.5, fit: 'contain' }, status: 'draft', still_url: null, still_credits: null }));
    expect(screen.getByText('Your footage')).toBeInTheDocument();
    expect(screen.getByLabelText('Your footage for shot 1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Make it again/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Quality')).not.toBeInTheDocument();
    const trim = screen.getByLabelText('Start at (seconds)');
    expect(trim).toHaveValue(1.5);
    fireEvent.change(trim, { target: { value: '2' } });
    fireEvent.blur(trim);
    await waitFor(() => expect(client.updateShot).toHaveBeenCalledWith('p1', 's1', { footage: { trimStart: 2 } }));
    fireEvent.change(screen.getByLabelText('Fit'), { target: { value: 'cover' } });
    await waitFor(() => expect(client.updateShot).toHaveBeenCalledWith('p1', 's1', { footage: { fit: 'cover' } }));
    fireEvent.click(screen.getByRole('button', { name: 'Use a generated shot instead' }));
    await waitFor(() => expect(client.updateShot).toHaveBeenCalledWith('p1', 's1', { source: 'generated' }));
  });

  it('a clip that is gone says so instead of a blank card', () => {
    renderShot(shot({ source: 'footage', footage_asset_id: null, footage_url: null, status: 'draft', still_url: null }));
    expect(screen.getByText('Pick a clip')).toBeInTheDocument();
  });

  it('a picture-in-picture shows a preview, sliders in percent, and is removed with one button', async () => {
    client.updateShot.mockResolvedValue({});
    renderShot(shot({ inset_asset_id: 'i1', inset_url: '/api/mock/storage/story-brand/u/p.png', inset_is_image: true, inset: { x: 0.5, y: 0.3, w: 0.45 } }));
    const preview = screen.getByTestId('inset-preview');
    expect(preview).toHaveStyle({ left: '50%', top: '30%', width: '45%' });
    const across = screen.getByLabelText('Picture-in-picture across');
    expect(across).toHaveValue('50');
    fireEvent.change(across, { target: { value: '70' } });
    fireEvent.blur(across);
    await waitFor(() => expect(client.updateShot).toHaveBeenCalledWith('p1', 's1', { inset: { x: 70, y: 30, w: 45 } }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove the picture-in-picture' }));
    await waitFor(() => expect(client.updateShot).toHaveBeenCalledWith('p1', 's1', { inset_asset_id: null }));
  });

  it('shows no editing controls on the read-only review card', () => {
    renderShot(shot({ source: 'footage', footage_asset_id: 'c1', footage_url: '/c.mp4', footage: { trimStart: 0, fit: 'contain' } }), { editable: false });
    expect(screen.getByLabelText('Your footage for shot 1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change my footage' })).not.toBeInTheDocument();
  });
});

describe('a character with the customer\'s own picture', () => {
  const cast = (over = {}) => ({
    id: 'c1', name: 'Maya', description: 'Friendly.', status: 'ready', candidates: [{ url: '/pick/1.png', key: 'k1' }], chosen_index: 0, image_url: '/pick/1.png', asset_id: null,
    regens_used: 0, retry_credits: 0, regen_credits: 0, ...over,
  });
  const stepCast = (c) => render(
    <PricingProvider value={{ stillReroll: 2, castRegen: 5, projectFee: 10, included: { castRegenPerCharacter: 2 } }}>
      <StepCast project={{ id: 'p1', step: 'cast', fee_charged: true }} cast={[c]} jobs={[]} refresh={vi.fn()} onNext={vi.fn()} returnTo="/" />
    </PricingProvider>
  );

  it('uses one of the customer\'s pictures, through setCastImage', async () => {
    client.getAssets.mockResolvedValue([asset({ id: 'm1', kind: 'mascot', name: 'my mascot' })]);
    client.setCastImage.mockResolvedValue({});
    stepCast(cast());
    fireEvent.click(screen.getByRole('button', { name: 'Use my own image' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Use my mascot' }));
    await waitFor(() => expect(client.setCastImage).toHaveBeenCalledWith('p1', 'c1', 'm1'));
    expect(client.getAssets).toHaveBeenCalledWith({ kinds: ['image', 'mascot', 'product', 'logo'] });
  });

  it('shows the picture in use, and lets the character continue', () => {
    stepCast(cast({ chosen_index: null, asset_id: 'm1', image_url: '/api/mock/storage/story-brand/u/m.png' }));
    expect(screen.getByAltText('Maya, your own picture')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continue to the storyboard/ })).toBeEnabled();
  });
});
