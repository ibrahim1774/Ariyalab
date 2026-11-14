// The older single-purpose tools, shown on /app/tools. Gated tools follow the
// same rule as components/Navbar.js: visible to admins, or to everyone when
// the feature-tabs flag (/api/feature-tabs) is on.
export const LEGACY_TOOLS = [
  { href: '/legacy-home', label: 'Image to Video', blurb: 'Turn one photo into a short moving clip.', gated: false },
  { href: '/face-swap', label: 'Face Swap', blurb: 'Put a new face into any video.', gated: true },
  { href: '/ugc', label: 'UGC Creator', blurb: 'Talking-to-camera clips from a single image.', gated: true },
  { href: '/glow-up', label: 'Glow Up', blurb: 'Polish a portrait in one step.', gated: true },
  { href: '/interior-design', label: 'Interior Design', blurb: 'Restyle a room from a photo.', gated: true },
  { href: '/video/editing', label: 'Video Editor', blurb: 'Cut, caption and combine clips.', gated: true },
  { href: '/history', label: 'History', blurb: 'Everything you have made with these tools.', gated: true },
];

export function visibleTools({ tabsEnabled, isAdmin }) {
  const showGated = Boolean(tabsEnabled) || Boolean(isAdmin);
  return LEGACY_TOOLS.filter((t) => !t.gated || showGated);
}
