/**
 * Cycle 2 RD coverage-closure — exercises the L168 false branch in
 * `src/services/doctor/doctor-service.ts`:
 *
 *   message: hasUserConfig ? 'User config exists at ...' : 'Optional user config not found at ...'
 *
 * To force `hasUserConfig` to be false, we need to make
 * `existsSync(join(homedir(), '.peaks', 'config.json'))` return false.
 * The cleanest way is to point `homedir()` at a fresh tmpdir that has
 * no `.peaks/config.json`.
 *
 * Because `doctor-service.ts` imports `homedir` at module load, a
 * post-hoc `vi.spyOn` is too late — the module already cached the
 * reference. We use a `vi.mock('node:os', ...)` module-level override
 * keyed on a hoisted mutable `homePath` variable. This file is the only
 * one in the suite that needs this mock, so it lives in its own file
 * to keep the side effect isolated.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const homePath = vi.hoisted(() => ({ current: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => homePath.current
  };
});

// Import AFTER the mock so the doctor-service module picks up the
// patched `homedir` reference (the module top-level evaluates
// `import { homedir } from 'node:os'` at load time).
import { runDoctor } from '../../../src/services/doctor/doctor-service.js';

const CLEAN_PROBES = {
  distVersionProbe: () => ({ dist: '2.10.0', source: '2.10.0', match: true, distReadable: true }),
  workspaceLayoutProbe: () => ({ topLevelSessionDirs: [], legacyDotfiles: [] })
};

describe('runDoctor config:user check — L168 false branch', () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'peaks-doctor-no-user-config-'));
    homePath.current = scratch;
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test('emits "Optional user config not found" when ~/.peaks/config.json is absent', async () => {
    const report = await runDoctor({ ...CLEAN_PROBES });
    const check = report.checks.find((c) => c.id === 'config:user');

    expect(check).toMatchObject({ ok: true });
    expect(check?.message).toContain('Optional user config not found');
  });

  test('emits "User config exists" when ~/.peaks/config.json IS present (true branch regression)', async () => {
    await mkdir(join(scratch, '.peaks'), { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(scratch, '.peaks', 'config.json'), '{}', 'utf8');

    const report = await runDoctor({ ...CLEAN_PROBES });
    const check = report.checks.find((c) => c.id === 'config:user');

    expect(check).toMatchObject({ ok: true });
    expect(check?.message).toContain('User config exists at');
  });
});
