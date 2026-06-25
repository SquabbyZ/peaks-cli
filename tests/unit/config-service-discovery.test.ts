/**
 * Cycle 2 RD coverage-closure — split out of `config-service.test.ts`
 * to bring that file back under the 800-line file-size cap. Contains
 * the `project config discovery`, `config types`, `CLI integration`,
 * and `Bug 1 — 2.0.1 slim config defaults` describe blocks.
 *
 * The new tests added in cycle 2 for the coverage-closure work also
 * live in `config-service.test.ts` itself (in the `secret config
 * handling` block) and in `load-global-config.test.ts`.
 */
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

const configTestHome = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const { join } = require('node:path') as typeof import('node:path');
  return mkdtempSync(join(tmpdir(), 'peaks-config-home-'));
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => configTestHome };
});

import {
  bootstrapProjectLanguageConfig,
  readConfig,
  setConfig
} from '../../src/services/config/config-service.js';
import { getConfig } from '../../src/services/config/config-service.js';
import { resolveProjectRootForConfig } from '../../src/services/config/config-service.js';

describe('project config discovery', () => {
  test('prefers project .peaks config over global .peaks config', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'peaks-config-root-'));
    mkdirSync(join(projectRoot, '.peaks'), { recursive: true });
    mkdirSync(join(configTestHome, '.peaks'), { recursive: true });
    writeFileSync(join(configTestHome, '.peaks', 'config.json'), JSON.stringify({ language: 'en', currentWorkspace: 'global' }), 'utf8');
    writeFileSync(join(projectRoot, '.peaks', 'config.json'), JSON.stringify({ language: 'zh', currentWorkspace: 'project' }), 'utf8');

    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectRoot);
    try {
      expect(readConfig()).toMatchObject({ language: 'zh' });
      expect(getConfig()).toMatchObject({ language: 'zh', currentWorkspace: 'project' });
    } finally {
      cwdSpy.mockRestore();
    }
  });

  test('falls back to global .peaks config when project config is absent', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'peaks-config-root-'));
    mkdirSync(join(configTestHome, '.peaks'), { recursive: true });
    writeFileSync(join(configTestHome, '.peaks', 'config.json'), JSON.stringify({ language: 'zh', model: 'minimax' }), 'utf8');

    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectRoot);
    try {
      expect(readConfig()).toMatchObject({ language: 'zh' });
      expect(getConfig()).toMatchObject({ language: 'zh' });
    } finally {
      cwdSpy.mockRestore();
    }
  });

  test('does not treat the user home .peaks config as a project config through a symlinked home path', () => {
    const realHomeRoot = mkdtempSync(join(tmpdir(), 'peaks-real-home-'));
    const linkedHomeRoot = join(tmpdir(), `peaks-linked-home-${Date.now()}`);
    symlinkSync(realHomeRoot, linkedHomeRoot, 'junction');
    mkdirSync(join(realHomeRoot, '.peaks'), { recursive: true });
    writeFileSync(join(realHomeRoot, '.peaks', 'config.json'), JSON.stringify({ language: 'zh-CN' }), 'utf8');

    const originalHome = process.env.HOME;
    process.env.HOME = linkedHomeRoot;
    try {
      expect(resolveProjectRootForConfig(join(realHomeRoot, 'nested'))).toBe(join(realHomeRoot, 'nested'));
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  test('bootstraps project language config from natural-language first use', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'peaks-config-root-'));
    const configPath = join(projectRoot, '.peaks', 'config.json');

    expect(() => readFileSync(configPath, 'utf8')).toThrow();

    bootstrapProjectLanguageConfig(projectRoot, '请使用 peaks-solo 帮我重构这个项目');

    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({ language: 'zh-CN' });
    expect(readConfig(projectRoot).language).toBe('zh-CN');
  });

  test('bootstraps English project language from natural-language first use', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'peaks-config-root-'));

    bootstrapProjectLanguageConfig(projectRoot, 'Please use peaks-solo to refactor this project');

    expect(JSON.parse(readFileSync(join(projectRoot, '.peaks', 'config.json'), 'utf8'))).toEqual({ language: 'en' });
  });

  test('keeps existing project language when bootstrap runs again (L507-509 early-return branch)', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'peaks-config-keep-lang-'));
    mkdirSync(join(projectRoot, '.peaks'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.peaks', 'config.json'),
      JSON.stringify({ language: 'zh-CN', economyMode: false }),
      'utf8'
    );

    bootstrapProjectLanguageConfig(projectRoot, 'en');

    expect(JSON.parse(readFileSync(join(projectRoot, '.peaks', 'config.json'), 'utf8'))).toEqual({
      language: 'zh-CN',
      economyMode: false
    });
  });

  test('setConfig rejects legacy per-project keys (L590-595 legacy-key guard)', () => {
    // The 2.0.1 slim-config contract: per-project fields (language,
    // model, economyMode, swarmMode) are stored in
    // <project>/.peaks/preferences.json, not ~/.peaks/config.json.
    // setConfig rejects writes to those keys with a pointer to
    // `peaks preferences set --key ...`.
    const legacyKeys = ['language', 'model', 'economyMode', 'swarmMode'];
    for (const key of legacyKeys) {
      expect(() => setConfig({ key, value: 'zh-CN' as never }), `setConfig should reject legacy key "${key}"`).toThrow(
        /preferences\.json/
      );
    }
  });

  test('getConfig returns the raw non-object value when user config file contains a JSON array (L576 isRecord-false branch)', () => {
    // L576: `const config = isRecord(source) ? { ...source, ... } : source;`
    // When `options.layer === 'user'` and the user config file parses to a
    // non-object (e.g. a JSON array), `readUserJsonFile() ?? {}` returns the
    // array (truthy), `source = [1,2,3]`, and `isRecord([1,2,3]) === false`
    // (config-nested.ts:62 — `!Array.isArray(value)`) so the false-branch
    // fires and `config` is the raw array (no `tokens` normalization, no
    // spread). Asserts: getConfig does not throw and the user layer
    // returns the raw array.
    mkdirSync(join(configTestHome, '.peaks'), { recursive: true });
    writeFileSync(join(configTestHome, '.peaks', 'config.json'), JSON.stringify([1, 2, 3]), 'utf8');

    const projectRoot = mkdtempSync(join(tmpdir(), 'peaks-config-nonobj-'));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectRoot);
    try {
      const userResult = getConfig({ layer: 'user' });
      expect(Array.isArray(userResult)).toBe(true);
      expect(userResult).toEqual([1, 2, 3]);
    } finally {
      cwdSpy.mockRestore();
    }
  });

  test('does not overwrite malformed project config during language bootstrap (L202-206 catch branch)', () => {
    // `readExistingJsonFile` at L199-207 reads the project config and
    // re-throws on JSON parse errors. The catch at L204-206 fires when
    // the file is present but contains invalid JSON. We write a
    // malformed file and confirm the bootstrap throws AND the file
    // is left untouched.
    const projectRoot = mkdtempSync(join(tmpdir(), 'peaks-config-malformed-'));
    const configPath = join(projectRoot, '.peaks', 'config.json');
    mkdirSync(join(projectRoot, '.peaks'), { recursive: true });
    writeFileSync(configPath, '{bad', 'utf8');

    expect(() => bootstrapProjectLanguageConfig(projectRoot, 'zh-CN')).toThrow('Project config must contain valid JSON');
    expect(readFileSync(configPath, 'utf8')).toBe('{bad');
  });
});
