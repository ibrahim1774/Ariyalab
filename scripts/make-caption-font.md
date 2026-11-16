# Caption font

The finished video's burned-in captions (lib/story/captions.js, lib/story/render.js) use one bundled font:

- **DM Serif Display Regular**, file `public/fonts/DMSerifDisplay-Regular.ttf`, internal family name `DM Serif Display` (the name the ASS style uses).
- Licence: **SIL Open Font License 1.1**. The full licence text ships next to the font as `public/fonts/DMSerifDisplay-OFL.txt`. Copyright 2014-2018 Adobe (Reserved Font Name "Source"), copyright 2019 Google LLC.
- The OFL allows the font to be bundled and redistributed with software, also commercially, as long as the licence goes with it and the font is not sold on its own. A modified version may not use the reserved names. We use the file unmodified.

## Where it came from

The official open-licence source: the Google Fonts repository on GitHub.

- Font: https://github.com/google/fonts/raw/main/ofl/dmserifdisplay/DMSerifDisplay-Regular.ttf
- Licence: https://github.com/google/fonts/raw/main/ofl/dmserifdisplay/OFL.txt
- Fetched 2026-11-15. sha256 of the TTF: `8cc3643535edf039aa5d95440a8542735e9197e4f4b8d9303e980fefbf5ab616` (76 580 bytes).

To fetch it again:

```sh
curl -L -o public/fonts/DMSerifDisplay-Regular.ttf https://github.com/google/fonts/raw/main/ofl/dmserifdisplay/DMSerifDisplay-Regular.ttf
curl -L -o public/fonts/DMSerifDisplay-OFL.txt https://github.com/google/fonts/raw/main/ofl/dmserifdisplay/OFL.txt
shasum -a 256 public/fonts/DMSerifDisplay-Regular.ttf
```

## How the render uses it

- libass (the ffmpeg `ass` filter) gets the font through `fontsdir`: the render copies the TTF into its temp dir and passes `ass=capN.ass:fontsdir=fonts`. A server has no system fonts, so every caption style (serif_accent, bold_pop, clean) names this one family and differs only by size, weight, outline, case and accent colour.
- libass does not fail when a family name is not found; it falls back silently. If the font is ever replaced, check a rendered frame, and keep `CAPTION_FONT` / `CAPTION_FONT_FILE` in lib/story/captions.js in step with the new file.
- `next.config.js` (`outputFileTracingIncludes`) puts `public/fonts/**` into the render worker's function bundle.
