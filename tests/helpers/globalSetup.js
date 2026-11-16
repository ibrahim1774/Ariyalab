// Vitest global setup: every test run gets its own temp folder, removed when the run ends.
// os.tmpdir() reads TMPDIR, and the test workers start after this runs and inherit it, so the mock
// storage (lib/providers/storage.js MOCK_STORAGE_DIR, os.tmpdir()/story-mock-storage), the
// render-fixture-* folders and every other temp file a test or the code under test makes land here.
// Production storage is untouched: this only changes the environment of the test process.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export default function setup() {
  const previous = process.env.TMPDIR;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ariya-vitest-'));
  process.env.TMPDIR = dir;
  return () => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    rmSync(dir, { recursive: true, force: true });
  };
}
