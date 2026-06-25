/**
 * Cycle 2 RD coverage-closure — exercises the defensive catch block at
 * `src/services/doctor/doctor-service.ts` L139-145.
 *
 * The block wraps the re-read of a required skill's SKILL.md:
 *
 *   try {
 *     const body = await readText(skill.skillPath);
 *     ...
 *   } catch (error) {
 *     checks.push({ id: `skill-runbook:${skill.name}`, ok: false, ... });
 *   }
 *
 * `loadSkillRegistry` already reads `skill.skillPath` once (via `readText`
 * from `src/shared/fs.js`) to parse the frontmatter before `runDoctor`
 * iterates skills. For the re-read at L109 to throw, the file must
 * succeed the initial read but fail the re-read — a TOCTOU window we
 * cannot reliably reproduce in a single-process test without filesystem
 * permissions that are flaky on Windows.
 *
 * Strategy: this test file uses `vi.mock` on the skill-registry module
 * to inject a fake `loadSkillRegistry` that returns a required skill
 * whose `skillPath` points to a non-existent file. The re-read at L109
 * then throws ENOENT, the catch at L139-145 fires, and the failing
 * `skill-runbook:<name>` check lands in the report.
 *
 * The fake is hoisted into a mutable `let` so each test can vary the
 * `skillPath` per-case (e.g. to point at a directory, a symlink, etc.).
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Mutable fake — each test points `skillPath` at a path that will fail
// the re-read. `name: 'peaks-solo'` is in `requiredSkillNames` so the
// loop at `doctor-service.ts` L104 actually enters the try-block.
const fakeSkill = {
  name: 'peaks-solo',
  description: 'fake skill for the read-error branch',
  directory: 'peaks-solo',
  skillPath: '/__definitely_does_not_exist__/SKILL.md'
};

vi.mock('../../../src/services/skills/skill-registry.js', () => ({
  loadSkillRegistry: async () => ({
    skills: [fakeSkill],
    failures: []
  }),
  listSkills: async () => [fakeSkill]
}));

import { runDoctor } from '../../../src/services/doctor/doctor-service.js';

const CLEAN_PROBES = {
  distVersionProbe: () => ({ dist: '2.10.0', source: '2.10.0', match: true, distReadable: true }),
  workspaceLayoutProbe: () => ({ topLevelSessionDirs: [], legacyDotfiles: [] })
};

describe('runDoctor coverage closure — skill-runbook re-read error branch (L139-145)', () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'peaks-doctor-runbook-err-'));
  });

  afterEach(async () => {
    // best-effort cleanup; scratch is empty in these tests
    await import('node:fs/promises').then(({ rm }) => rm(scratch, { recursive: true, force: true }));
  });

  test('rejects when skillPath points to a non-existent file (L139-145 ENOENT branch)', async () => {
    // `fakeSkill.skillPath` is set to a path that does not exist
    // (the module-level default). `readText` will throw ENOENT, the
    // catch block at L139-145 should fire, and the resulting check
    // should be `ok: false` with a "runbook check failed" message.
    fakeSkill.skillPath = join(scratch, 'no-such-skill.md');

    const report = await runDoctor({ ...CLEAN_PROBES });
    const check = report.checks.find((c) => c.id === 'skill-runbook:peaks-solo');

    expect(check).toMatchObject({ ok: false });
    expect(check?.message).toContain('runbook check failed');
    // The error message is opaque on Windows, but the prefix from
    // `getErrorMessage` always includes the underlying error string.
    expect(check?.message).toMatch(/(ENOENT|no such file|cannot find)/i);
    expect(report.summary.ok).toBe(false);
  });

  test('rejects when skillPath is a directory (L139-145 EISDIR branch)', async () => {
    // Create a real directory at the skill path — `readFile` will
    // throw EISDIR, exercising a different throw message inside the
    // catch block while still landing on the same `ok: false` branch.
    const dirPath = join(scratch, 'skill-as-directory');
    await mkdir(dirPath, { recursive: true });
    fakeSkill.skillPath = dirPath;

    const report = await runDoctor({ ...CLEAN_PROBES });
    const check = report.checks.find((c) => c.id === 'skill-runbook:peaks-solo');

    expect(check).toMatchObject({ ok: false });
    expect(check?.message).toContain('runbook check failed');
  });

  test('rejects when skillPath is a broken symlink (L139-145 ENOENT branch variant)', async () => {
    // A symlink whose target does not exist throws ENOENT when
    // readFile is called. Confirms the catch handles the broken-symlink
    // shape (in addition to the missing-file shape). Skipped on
    // Windows where unprivileged symlink creation is restricted.
    if (process.platform === 'win32') {
      // fall through to a different shape: create a real file then
      // delete it after the symlink points at it, so the link dangles.
      const realTarget = join(scratch, 'real-target.md');
      await writeFile(realTarget, 'real', 'utf8');
      const linkPath = join(scratch, 'broken-symlink.md');
      const { symlinkSync, unlinkSync } = await import('node:fs');
      try {
        symlinkSync(realTarget, linkPath, 'file');
      } catch {
        // symlink creation blocked; use the missing-file variant
        // by simply not creating the link. fakeSkill.skillPath stays
        // as a non-existent file path.
        fakeSkill.skillPath = linkPath;
        const report = await runDoctor({ ...CLEAN_PROBES });
        const check = report.checks.find((c) => c.id === 'skill-runbook:peaks-solo');
        expect(check).toMatchObject({ ok: false });
        expect(check?.message).toContain('runbook check failed');
        return;
      }
      unlinkSync(realTarget);
      fakeSkill.skillPath = linkPath;
    } else {
      const target = join(scratch, 'never-created-target.md');
      const linkPath = join(scratch, 'broken-symlink.md');
      await import('node:fs/promises').then(({ symlink }) => symlink(target, linkPath, 'file'));
      fakeSkill.skillPath = linkPath;
    }

    const report = await runDoctor({ ...CLEAN_PROBES });
    const check = report.checks.find((c) => c.id === 'skill-runbook:peaks-solo');

    expect(check).toMatchObject({ ok: false });
    expect(check?.message).toContain('runbook check failed');
  });
});
