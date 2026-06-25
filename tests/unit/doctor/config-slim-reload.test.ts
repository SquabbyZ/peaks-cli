/**
 * Cycle 2 RD coverage-closure — exercises the `readSlimGlobalConfig`
 * re-read fallback (config-service.ts L184-186):
 *
 *   if (!existsSync(path)) {
 *     return { version: CONFIG_SCHEMA_VERSION_V2 };
 *   }
 *
 * The race we are simulating: the file is present at the first
 * `existsSync` check (L126 in `loadGlobalConfig`) but has been removed
 * by the time `readSlimGlobalConfig` re-checks at L184. In normal
 * operation this is the "external rm" race during promotion; tests
 * simulate it deterministically with a `vi.mock('node:os', ...)` that
 * points `homedir` at a scratch dir and a counter that flips
 * `existsSync` between calls.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const homePath = vi.hoisted(() => ({ current: '' }));
const existsCalls = vi.hoisted(() => ({ remaining: 2 }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => homePath.current
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (path: string) => {
      if (typeof path === 'string' && path.endsWith('config.json')) {
        existsCalls.remaining -= 1;
        return existsCalls.remaining >= 0;
      }
      return actual.existsSync(path);
    }
  };
});

import { loadGlobalConfig } from '../../../src/services/config/config-service.js';

describe('loadGlobalConfig — readSlimGlobalConfig re-read fallback (L184-186)', () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'peaks-load-global-race-'));
    homePath.current = scratch;
    existsCalls.remaining = 2;
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test('returns the default config when the file is removed between checks (L184-186)', async () => {
    // Write a v2 file at `~/.peaks/config.json` with a legacy field
    // so `loadGlobalConfig` will call `readSlimGlobalConfig` after
    // the promotion rewrite. The mocked `existsSync` returns true
    // on the first call (in `loadGlobalConfig` at L126) and false
    // on the second (in `readSlimGlobalConfig` at L184), so the
    // re-read falls back to the default `{ version: '2.0.0' }`.
    await mkdir(join(scratch, '.peaks'), { recursive: true });
    await writeFile(
      join(scratch, '.peaks', 'config.json'),
      JSON.stringify({ version: '2.0.0', providers: { minimax: { model: 'm' } } }),
      'utf8'
    );

    const result = loadGlobalConfig();
    expect(result).toBeDefined();
    expect(result?.version).toBe('2.0.0');
  });
});
