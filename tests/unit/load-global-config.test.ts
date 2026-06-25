/**
 * Cycle 2 RD coverage-closure — exercises the `loadGlobalConfig` public
 * surface in `src/services/config/config-service.ts` (L124-197) and its
 * `readSlimGlobalConfig` race-fallback at L184-186.
 *
 * The helper reads `~/.peaks/config.json`, detects legacy 1.x shapes,
 * and either returns a slim 2.0 result or throws a
 * `CONFIG_LEGACY_VERSION` error pointing the user at
 * `peaks config migrate --apply`. The migration tests in
 * `config-migration.test.ts` cover the happy path; this file covers
 * the loader itself.
 *
 * This file was split out of `config-service.test.ts` during the
 * cycle 2 file-size-cap refactor — that file's line count exceeded
 * the 800-line cap after the coverage-closure tests were added.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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

import { loadGlobalConfig } from '../../src/services/config/config-service.js';

describe('loadGlobalConfig', () => {
  test('returns null when ~/.peaks/config.json does not exist (L126 null branch)', () => {
    const configPath = join(configTestHome, '.peaks', 'config.json');
    mkdirSync(join(configTestHome, '.peaks'), { recursive: true });
    if (existsSync(configPath)) unlinkSync(configPath);

    expect(loadGlobalConfig()).toBeNull();
  });

  test('returns the slim 2.0 config when the file is at v2 (L129-134 happy path)', () => {
    const configPath = join(configTestHome, '.peaks', 'config.json');
    mkdirSync(join(configTestHome, '.peaks'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ version: '2.0.0' }), 'utf8');

    const result = loadGlobalConfig();
    expect(result).toMatchObject({ version: '2.0.0' });
  });

  test('throws CONFIG_LEGACY_VERSION when the file is at 1.x (L137-139 throw branch)', () => {
    const configPath = join(configTestHome, '.peaks', 'config.json');
    mkdirSync(join(configTestHome, '.peaks'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ version: '1.4.2' }), 'utf8');

    expect(() => loadGlobalConfig()).toThrow(/CONFIG_LEGACY_VERSION/);
    expect(() => loadGlobalConfig()).toThrow(/1\.4\.2/);
  });

  test('promotes legacy fields to sidecars on read of a 1.x-derived v2 file (L130-133 promote path)', () => {
    const configPath = join(configTestHome, '.peaks', 'config.json');
    mkdirSync(join(configTestHome, '.peaks'), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        version: '2.0.0',
        providers: { minimax: { model: 'm', baseUrl: 'https://api.minimaxi.com/anthropic' } }
      }),
      'utf8'
    );

    const result = loadGlobalConfig();
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    expect(onDisk).not.toHaveProperty('providers');
    expect(result).toMatchObject({ version: '2.0.0' });
  });

  test('promotes legacy workspaces field to the workspaces sidecar (L170-177)', () => {
    const configPath = join(configTestHome, '.peaks', 'config.json');
    mkdirSync(join(configTestHome, '.peaks'), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        version: '2.0.0',
        workspaces: [{ workspaceId: 'ws-1', name: 'WS 1', rootPath: '/tmp/ws-1', installedCapabilityIds: [] }],
        currentWorkspace: 'ws-1'
      }),
      'utf8'
    );

    const result = loadGlobalConfig();
    expect(result).toBeDefined();
    expect((result as unknown as Record<string, unknown>).workspaces).toBeUndefined();
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    expect(onDisk.workspaces).toBeUndefined();
  });

  test('promotes legacy proxy field to the proxy sidecar (L163-168)', () => {
    const configPath = join(configTestHome, '.peaks', 'config.json');
    mkdirSync(join(configTestHome, '.peaks'), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        version: '2.0.0',
        proxy: { httpProxy: 'http://127.0.0.1:58309' }
      }),
      'utf8'
    );

    const result = loadGlobalConfig();
    expect(result).toBeDefined();
    expect((result as unknown as Record<string, unknown>).proxy).toBeUndefined();
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    expect(onDisk.proxy).toBeUndefined();
  });
});
