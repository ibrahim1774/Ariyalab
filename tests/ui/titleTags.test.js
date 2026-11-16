// Final review M1: a <title> with text next to a JSX expression renders two children, and React's SSR puts a
// `<!-- -->` comment between them, so the tab reads "Sign up<!-- --> — Ariya Lab". One expression (a template
// string) or plain text only.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(js|jsx)$/.test(name) ? [p] : [];
  });
}

describe('<title> tags', () => {
  it('have a single child: plain text or one expression', () => {
    const bad = [];
    for (const file of [...files('pages'), ...files('components')]) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/<title>([\s\S]*?)<\/title>/g)) {
        const inner = m[1].trim();
        const hasExpr = inner.includes('{');
        const single = /^\{[\s\S]*\}$/.test(inner) && !/\}[^{}]*\{/.test(inner.slice(1, -1).replace(/`[^`]*`/g, '``'));
        if (hasExpr && !single) bad.push(`${file}: ${inner}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
