/*
 * The style presets a customer picks in step 3 (spec 7.3). Keys match
 * STYLES in lib/story/projects.js (the story_projects.style check).
 *
 *   label           shown to the customer
 *   promptFragment  appended to still and clip prompts; describes the look in
 *                   plain words (never a studio, film, character or person)
 *   sampleImage     public path of the preset's sample image
 *
 * 'custom' uses the project's style_custom text as the fragment.
 */

export const STYLES = Object.freeze({
  '3d_family': {
    label: '3D animated family film',
    promptFragment:
      'Polished 3D animated family film look. Soft rounded characters with big expressive eyes, warm cinematic lighting, gentle depth of field, rich saturated colour, detailed but tidy sets.',
    sampleImage: '/styles/3d_family.jpg',
  },
  '2d_cartoon': {
    label: '2D cartoon',
    promptFragment:
      'Bright 2D cartoon look. Clean bold outlines, flat colour with simple shading, exaggerated poses and faces, simple readable backgrounds.',
    sampleImage: '/styles/2d_cartoon.jpg',
  },
  anime: {
    label: 'Anime',
    promptFragment:
      'Japanese anime look. Crisp line art, cel shading, expressive eyes, painted backgrounds with soft light, dramatic framing.',
    sampleImage: '/styles/anime.jpg',
  },
  clay: {
    label: 'Clay',
    promptFragment:
      'Stop motion clay look. Handmade plasticine characters with visible fingerprints and texture, miniature sets, soft studio lighting, slightly imperfect shapes.',
    sampleImage: '/styles/clay.jpg',
  },
  comic: {
    label: 'Comic book',
    promptFragment:
      'Comic book look. Heavy ink outlines, halftone dot shading, bold primary colours, dynamic angles, panel style framing.',
    sampleImage: '/styles/comic.jpg',
  },
  flat_motion: {
    label: 'Flat motion graphic',
    promptFragment:
      'Flat motion graphic look. Simple geometric shapes, flat vector colour, no outlines, minimal shading, clean modern palette, smooth simple motion.',
    sampleImage: '/styles/flat_motion.jpg',
  },
  watercolor: {
    label: 'Watercolor storybook',
    promptFragment:
      "Watercolor storybook look. Soft painted washes, visible paper texture, loose ink lines, gentle muted colours, cosy children's book feel.",
    sampleImage: '/styles/watercolor.jpg',
  },
  custom: {
    label: 'Your own style',
    promptFragment: '',
    sampleImage: '/styles/custom.jpg',
  },
});

/** The look description for a project: the preset's fragment, or the customer's own text for 'custom'. */
export function styleFragment({ style, style_custom: custom } = {}) {
  if (style === 'custom') return (custom || '').trim();
  return STYLES[style]?.promptFragment || '';
}
