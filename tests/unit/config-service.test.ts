import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

function canCreateFileSymlink(): boolean {
  const root = mkdtempSync(join(tmpdir(), 'peaks-symlink-check-'));
  try {
    const target = join(root, 'target.txt');
    const link = join(root, 'link.txt');
    writeFileSync(target, 'target', 'utf8');
    symlinkSync(target, link);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const fileSymlinkTest = canCreateFileSymlink() ? test : test.skip;

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

import { addWorkspace, bootstrapProjectLanguageConfig, containsSensitiveConfigValue, ensureWorkspaceConfigForPath, getConfig, getMiniMaxProviderConfig, getMiniMaxProviderStatus, getWorkspaceConfigForPath, isConfigLayer, isSensitiveConfigPath, readConfig, redactConfigSecrets, removeWorkspace, resolveProjectRootForConfig, setConfig, setCurrentWorkspace, setMiniMaxProviderConfig, writeConfig } from '../../src/services/config/config-service.js';

// Test helper path parsing logic directly
// The actual config service uses these functions internally

describe('path parsing utilities', () => {
  test('parses dot notation paths correctly', () => {
    const obj = { a: { b: { c: 1 } }, d: 2 };
    // Simulate getNestedValue logic
    const path = 'a.b.c';
    const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
    expect(parts).toEqual(['a', 'b', 'c']);
  });

  test('parses array index notation', () => {
    const path = 'workspaces[0].workspaceId';
    const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
    expect(parts).toEqual(['workspaces', '0', 'workspaceId']);
  });

  test('handles empty path parts', () => {
    const path = 'a..b';
    const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
    expect(parts).toEqual(['a', 'b']);
  });
});

describe('nested value operations', () => {
  test('getNestedValue returns deep nested value', () => {
    const obj = { a: { b: { c: 42 } } };
    const parts = 'a.b.c'.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
    let current: unknown = obj;
    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== 'object') {
        current = undefined;
        break;
      }
      current = (current as Record<string, unknown>)[part];
    }
    expect(current).toBe(42);
  });

  test('getNestedValue returns undefined for non-existent path', () => {
    const obj = { a: { b: 1 } };
    const parts = 'a.c'.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
    let current: unknown = obj;
    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== 'object') {
        current = undefined;
        break;
      }
      current = (current as Record<string, unknown>)[part];
    }
    expect(current).toBeUndefined();
  });

  test('setNestedValue sets deep nested value', () => {
    const obj: Record<string, unknown> = {};
    const parts = 'a.b.c'.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
    let current: Record<string, unknown> = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i] as string;
      if (!(part in current) || typeof current[part] !== 'object' || current[part] === null) {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }
    const last = parts[parts.length - 1] as string;
    current[last] = 42;

    expect((obj as { a: { b: { c: number } } }).a.b.c).toBe(42);
  });

  test('setNestedValue creates intermediate objects', () => {
    const obj: Record<string, unknown> = {};
    const parts = 'x.y.z'.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
    let current: Record<string, unknown> = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i] as string;
      if (!(part in current) || typeof current[part] !== 'object' || current[part] === null) {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }
    const last = parts[parts.length - 1] as string;
    current[last] = 'value';

    expect((obj as { x: { y: { z: string } } }).x.y.z).toBe('value');
  });
});

describe('secret config handling', () => {
  test('identifies config layers and sensitive config paths', () => {
    expect(isConfigLayer('user')).toBe(true);
    expect(isConfigLayer('project')).toBe(true);
    expect(isConfigLayer('other')).toBe(false);
    expect(isSensitiveConfigPath('providers.minimax.apiKey')).toBe(true);
    expect(isSensitiveConfigPath('tokens.GitHubToken')).toBe(true);
    expect(isSensitiveConfigPath('providers.minimax.baseUrl')).toBe(false);
  });

  test('detects nested sensitive config values', () => {
    expect(containsSensitiveConfigValue({ minimax: { apiKey: 'secret' } })).toBe(true);
    expect(containsSensitiveConfigValue([{ token: 'secret' }])).toBe(true);
    expect(containsSensitiveConfigValue({ minimax: { baseUrl: 'https://api.minimaxi.com/anthropic' } })).toBe(false);
  });

  test('redacts nested secret values without mutating the input', () => {
    const config = {
      providers: {
        minimax: {
          baseUrl: 'https://api.minimaxi.com/anthropic',
          apiKey: { value: 'plain-secret' },
          emptyToken: ''
        },
        customProvider: {
          baseUrl: 'https://user:pass@example.com/anthropic?token=secret#key=secret'
        }
      },
      list: [{ token: ['token-secret'] }]
    };

    const redacted = redactConfigSecrets(config);
    const redactedConfig = redacted as { providers: { minimax: { baseUrl: string; apiKey: string; emptyToken: string }; customProvider: { baseUrl: string } }; list: { token: string }[] };

    expect(redactedConfig.providers.minimax.baseUrl).toBe('https://api.minimaxi.com/anthropic');
    expect(redactedConfig.providers.minimax.apiKey).toBe('***');
    expect(redactedConfig.providers.minimax.emptyToken).toBe('***');
    expect(redactedConfig.providers.customProvider.baseUrl).toBe('https://example.com/anthropic');
    expect(redactedConfig.list[0]?.token).toBe('***');
    expect(config.providers.minimax.apiKey.value).toBe('plain-secret');
  });

  test('rejects insecure MiniMax base URLs through all config write paths', () => {
    expect(() => setConfig({ key: 'providers.minimax.baseUrl', value: 'http://api.minimaxi.com/anthropic' })).toThrow('MiniMax base URL must be the MiniMax HTTPS endpoint without embedded credentials');
    expect(() => setConfig({ key: 'providers.minimax', value: { baseUrl: 'http://api.minimaxi.com/anthropic' } })).toThrow('MiniMax base URL must be the MiniMax HTTPS endpoint without embedded credentials');
    expect(() => setConfig({ key: 'providers', value: { minimax: { baseUrl: 'http://api.minimaxi.com/anthropic' } } })).toThrow('MiniMax base URL must be the MiniMax HTTPS endpoint without embedded credentials');
    expect(() => writeConfig({ providers: { minimax: { baseUrl: 'http://api.minimaxi.com/anthropic' } } }, 'user')).toThrow('MiniMax base URL must be the MiniMax HTTPS endpoint without embedded credentials');
    expect(() => setMiniMaxProviderConfig({ baseUrl: 'http://api.minimaxi.com/anthropic' })).toThrow('MiniMax base URL must be the MiniMax HTTPS endpoint without embedded credentials');
    expect(() => setConfig({ key: 'providers.minimax.baseUrl', value: 'https://user:pass@api.minimaxi.com/anthropic' })).toThrow('MiniMax base URL must be the MiniMax HTTPS endpoint without embedded credentials');
    expect(() => setConfig({ key: 'providers.minimax.baseUrl', value: 'https://api.minimaxi.com/anthropic?apiKey=secret' })).toThrow('MiniMax base URL must be the MiniMax HTTPS endpoint without embedded credentials');
    expect(() => setConfig({ key: 'providers.minimax.baseUrl', value: 'https://api.minimaxi.com/anthropic#token=secret' })).toThrow('MiniMax base URL must be the MiniMax HTTPS endpoint without embedded credentials');
    expect(() => setConfig({ key: 'providers.minimax.baseUrl', value: 'https://example.com/anthropic' })).toThrow('MiniMax base URL must be the MiniMax HTTPS endpoint without embedded credentials');

    expect(() => setConfig({ key: 'providers.minimax.baseUrl', value: 'https://api.minimaxi.com/anthropic' })).not.toThrow();
  });

  test('rejects unsafe generic provider base URLs', () => {
    expect(() => setConfig({ key: 'providers.customProvider.baseUrl', value: 'http://example.com/anthropic' })).toThrow('Provider base URL must be HTTPS without embedded credentials, query, or fragment');
    expect(() => setConfig({ key: 'providers.customProvider.baseUrl', value: 'https://user:pass@example.com/anthropic' })).toThrow('Provider base URL must be HTTPS without embedded credentials, query, or fragment');
    expect(() => setConfig({ key: 'providers.customProvider.baseUrl', value: 'https://example.com/anthropic?apiKey=secret' })).toThrow('Provider base URL must be HTTPS without embedded credentials, query, or fragment');
    expect(() => setConfig({ key: 'providers.customProvider.baseUrl', value: 'https://example.com/anthropic#token=secret' })).toThrow('Provider base URL must be HTTPS without embedded credentials, query, or fragment');
    expect(() => setConfig({ key: 'providers.customProvider', value: { baseUrl: 'http://example.com/anthropic' } })).toThrow('Provider base URL must be HTTPS without embedded credentials, query, or fragment');
    expect(() => setConfig({ key: 'providers', value: { customProvider: { baseUrl: 'https://user:pass@example.com/anthropic' } } })).toThrow('Provider base URL must be HTTPS without embedded credentials, query, or fragment');
    expect(() => writeConfig({ providers: { customProvider: { baseUrl: 'https://example.com/anthropic?apiKey=secret' } } }, 'user')).toThrow('Provider base URL must be HTTPS without embedded credentials, query, or fragment');

    expect(() => setConfig({ key: 'providers.customProvider.baseUrl', value: 'https://example.com/anthropic' })).not.toThrow();
    expect(() => setConfig({ key: 'providers.customProvider', value: { baseUrl: 'https://example.com/anthropic' } })).not.toThrow();
    expect(() => setConfig({ key: 'providers', value: { customProvider: { baseUrl: 'https://example.com/anthropic' } } })).not.toThrow();
  });

  test('reads configurable HTTP proxy with validation and no default', () => {
    // 2.0.1 slim: proxy is not synthesised by DEFAULT_CONFIG; the
    // user-side `proxy` key may or may not be present. When absent
    // the read-side path returns `undefined` for the parent.
    expect(readConfig().proxy?.httpProxy).toBeUndefined();

    writeConfig({ proxy: { httpProxy: 'https://proxy.example:8443' } }, 'user');
    expect(readConfig().proxy?.httpProxy).toBe('https://proxy.example:8443');

    expect(() => setConfig({ key: 'proxy.httpProxy', value: '127.0.0.1:58309' })).toThrow('Proxy URL must be an HTTP or HTTPS URL without embedded credentials');
    expect(() => setConfig({ key: 'proxy.httpProxy', value: 'http://user:pass@127.0.0.1:58309' })).toThrow('Proxy URL must be an HTTP or HTTPS URL without embedded credentials');
    expect(() => setConfig({ key: 'proxy.httpProxy', value: 'https://proxy.example:8443/route?token=secret' })).toThrow('Proxy URL must be an HTTP or HTTPS URL without embedded credentials');
    expect(() => setConfig({ key: 'proxy.httpProxy', value: 'http://127.0.0.1:58309' })).not.toThrow();
  });

  test('keeps project proxy from overriding user proxy', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'peaks-config-root-'));
    mkdirSync(join(projectRoot, '.peaks'), { recursive: true });
    writeConfig({ proxy: { httpProxy: 'https://user-proxy.example:8443' } }, 'user');
    writeFileSync(join(projectRoot, '.peaks', 'config.json'), JSON.stringify({ proxy: { httpProxy: 'https://project-proxy.example:8443' } }), 'utf8');

    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectRoot);
    try {
      expect(readConfig().proxy?.httpProxy).toBe('https://user-proxy.example:8443');
      expect(getConfig()).toMatchObject({ proxy: { httpProxy: 'https://user-proxy.example:8443' } });
    } finally {
      cwdSpy.mockRestore();
    }
  });

  test('keeps project tokens from overriding user tokens', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'peaks-config-root-'));
    mkdirSync(join(projectRoot, '.peaks'), { recursive: true });
    writeConfig({ tokens: { GitHubToken: { env: 'USER_GITHUB_TOKEN' } } }, 'user');
    writeFileSync(join(projectRoot, '.peaks', 'config.json'), JSON.stringify({ tokens: { GitHubToken: { env: 'PROJECT_GITHUB_TOKEN' } } }), 'utf8');

    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectRoot);
    try {
      expect(readConfig().tokens?.GitHubToken).toEqual({ env: 'USER_GITHUB_TOKEN' });
      expect(getConfig({ key: 'tokens.GitHubToken.env' })).toBe('USER_GITHUB_TOKEN');
      expect(getConfig({ layer: 'project', key: 'tokens.GitHubToken.env' })).toBeUndefined();
    } finally {
      cwdSpy.mockRestore();
    }
  });

  test('ignores project-only proxy config', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'peaks-config-root-'));
    mkdirSync(join(projectRoot, '.peaks'), { recursive: true });
    // 2.0.1 slim: proxy is a legacy key — writeConfig rejects it; seed
    // the file directly to verify the read-side project-only filter still
    // applies.
    writeFileSync(join(configTestHome, '.peaks', 'config.json'), JSON.stringify({}), 'utf8');
    writeFileSync(join(projectRoot, '.peaks', 'config.json'), JSON.stringify({ proxy: { httpProxy: 'https://project-proxy.example:8443' } }), 'utf8');

    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectRoot);
    try {
      expect(readConfig().proxy?.httpProxy).toBeUndefined();
      expect(getConfig({ key: 'proxy.httpProxy' })).toBeUndefined();
    } finally {
      cwdSpy.mockRestore();
    }
  });

  test('rejects project-layer sensitive writes', () => {
    expect(() => setConfig({ key: 'providers.minimax.apiKey', value: 'secret', layer: 'project' })).toThrow('Sensitive config keys must be stored in the user config layer');
    expect(() => setConfig({ key: 'providers.minimax', value: { apiKey: 'secret' }, layer: 'project' })).toThrow('Sensitive config keys must be stored in the user config layer');
    expect(() => setConfig({ key: 'providers.minimax.baseUrl', value: 'https://api.minimaxi.com/anthropic', layer: 'project' })).toThrow('Sensitive config keys must be stored in the user config layer');
    expect(() => setConfig({ key: 'proxy.httpProxy', value: 'http://127.0.0.1:58309', layer: 'project' })).toThrow('Sensitive config keys must be stored in the user config layer');
    expect(() => setConfig({ key: 'safe', value: { nested: { token: 'secret' } }, layer: 'project' })).toThrow('Sensitive config keys must be stored in the user config layer');
    expect(() => writeConfig({ providers: { minimax: { baseUrl: 'https://api.minimaxi.com/anthropic' } } }, 'project')).toThrow('Sensitive config keys must be stored in the user config layer');
    expect(() => writeConfig({ proxy: { httpProxy: 'http://127.0.0.1:58309' } }, 'project')).toThrow('Sensitive config keys must be stored in the user config layer');
    expect(() => setConfig({ key: 'safe', value: 'value', layer: 'invalid' as 'project' })).toThrow('Invalid config layer');
  });

  // Cycle 2 RD coverage-closure: project-layer write happy paths
  // (config-service.ts L548-554 in `writeConfig`; L617 + L623 in `setConfig`).
  test('writeConfig writes a non-sensitive partial to the project layer (L548-554)', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'peaks-config-project-write-'));
    mkdirSync(join(projectRoot, '.peaks'), { recursive: true });
    writeFileSync(join(projectRoot, '.peaks', 'config.json'), '{}', 'utf8');

    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectRoot);
    try {
      expect(() => writeConfig({ language: 'en' }, 'project')).not.toThrow();

      const onDisk = JSON.parse(readFileSync(join(projectRoot, '.peaks', 'config.json'), 'utf8')) as { language?: string };
      expect(onDisk.language).toBe('en');
      expect(readConfig(projectRoot).language).toBe('en');
    } finally {
      cwdSpy.mockRestore();
    }
  });

  // Cycle 2 RD coverage-closure note: the `?? {}` branch at L550 of
  // `writeConfig` is unreachable through the public API: `getProjectWriteTarget`
  // requires the project marker to exist before the read at L550 is
  // reached, so `readJsonFile` always returns a non-null value here.
  // This is a defensive branch, not an exposed behavior gap; documented
  // here so future readers do not "fix" the missing test by adding a
  // fragile test that breaks once `isSafeProjectConfigMarker` tightens.

  test('writeConfig merges project-layer partial with existing project config (L548-554 merge branch)', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'peaks-config-project-merge-'));
    mkdirSync(join(projectRoot, '.peaks'), { recursive: true });
    writeFileSync(join(projectRoot, '.peaks', 'config.json'), JSON.stringify({ economyMode: false, swarmMode: true }), 'utf8');

    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectRoot);
    try {
      writeConfig({ language: 'zh-CN' }, 'project');

      const onDisk = JSON.parse(readFileSync(join(projectRoot, '.peaks', 'config.json'), 'utf8')) as Record<string, unknown>;
      expect(onDisk).toMatchObject({ economyMode: false, swarmMode: true, language: 'zh-CN' });
    } finally {
      cwdSpy.mockRestore();
    }
  });

  test('setConfig writes a non-sensitive key to the project layer (L617, L623)', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'peaks-config-project-set-'));
    mkdirSync(join(projectRoot, '.peaks'), { recursive: true });
    writeFileSync(join(projectRoot, '.peaks', 'config.json'), '{}', 'utf8');

    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectRoot);
    try {
      expect(() => setConfig({ key: 'safeFlag', value: 'enabled', layer: 'project' })).not.toThrow();

      const onDisk = JSON.parse(readFileSync(join(projectRoot, '.peaks', 'config.json'), 'utf8')) as Record<string, unknown>;
      expect(onDisk.safeFlag).toBe('enabled');
    } finally {
      cwdSpy.mockRestore();
    }
  });

  // Cycle 2 RD coverage-closure: setConfig user-target branch (L618).
  // `setConfig` defaults to layer: 'user' when no layer is specified.
  // The user-target branch of the projectTarget ternary at L616-618
  // is the most common write path; the existing tests already hit it
  // implicitly, but this test pins the contract explicitly.
  test('setConfig default layer is user (L618)', () => {
    const configPath = join(configTestHome, '.peaks', 'config.json');
    mkdirSync(join(configTestHome, '.peaks'), { recursive: true });
    if (existsSync(configPath)) unlinkSync(configPath);

    // Write to user layer without specifying `layer`. The
    // `readJsonFile` at L618 will return null (file absent), and
    // the `?? {}` fallback fires.
    setConfig({ key: 'safeFlag', value: 'enabled' });
    // Read back via getConfig to confirm the user-layer write.
    const config = getConfig({ layer: 'user' }) as Record<string, unknown>;
    expect(config.safeFlag).toBe('enabled');
  });

  // Cycle 2 RD coverage-closure: getProxyUrlCandidate `key === 'proxy'`
  // branch (L282-284). When setConfig is called with
  // `{ key: 'proxy', value: { httpProxy: 'http://...' } }`,
  // `getProxyUrlCandidate` returns `value.httpProxy`, and the
  // subsequent `validateProxyUrl` call validates it.
  test('setConfig accepts a `proxy` key with a valid httpProxy object (L282-284)', () => {
    expect(() => setConfig({ key: 'proxy', value: { httpProxy: 'http://127.0.0.1:58309' } })).not.toThrow();
    const config = getConfig({ layer: 'user' }) as { proxy?: { httpProxy?: string } };
    expect(config.proxy?.httpProxy).toBe('http://127.0.0.1:58309');
  });

  // Cycle 2 RD coverage-closure: writeConfig user-layer `?? {}` branch (L558).
  // When `~/.peaks/config.json` does not exist, `readJsonFile` returns
  // null and the `?? {}` fallback fires. We delete any pre-existing
  // file first to ensure the missing-file state.
  test('writeConfig user-layer falls back to {} when no user config exists (L558)', () => {
    const configPath = join(configTestHome, '.peaks', 'config.json');
    mkdirSync(join(configTestHome, '.peaks'), { recursive: true });
    if (existsSync(configPath)) unlinkSync(configPath);

    expect(() => writeConfig({ language: 'en' }, 'user')).not.toThrow();
    expect(existsSync(configPath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    expect(onDisk.language).toBe('en');
  });

  // Cycle 2 RD coverage-closure: getConfig `?? {}` and tokens undefined branches (L565, L576).
  test('getConfig returns an empty object shape when no user config exists (L565, L576)', () => {
    const configPath = join(configTestHome, '.peaks', 'config.json');
    mkdirSync(join(configTestHome, '.peaks'), { recursive: true });
    if (existsSync(configPath)) unlinkSync(configPath);
    // Confirm pre-condition: file is absent.
    expect(existsSync(configPath)).toBe(false);

    // `readUserJsonFile()` returns null, the `?? {}` fallback at L565
    // fires, and `source.tokens` is undefined so the `tokens`-aware
    // spread at L576 reduces to the bare `{ ...source }` (the `: {}`
    // branch of the ternary).
    const userConfig = getConfig({ layer: 'user' });
    expect(userConfig).toEqual({});
  });

  // Cycle 2 RD coverage-closure: writeConfig invalid-layer branch (L539-540).
  test('writeConfig rejects an invalid layer value (L539-540)', () => {
    expect(() => writeConfig({ language: 'en' }, 'invalid' as 'user')).toThrow('Invalid config layer');
  });

  // Cycle 2 RD coverage-closure: bootstrapProjectLanguageConfig empty-language branch (L477-478).
  test('bootstrapProjectLanguageConfig rejects an empty / whitespace-only language', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'peaks-config-empty-lang-'));
    expect(() => bootstrapProjectLanguageConfig(projectRoot, '')).toThrow('Language must be non-empty');
    expect(() => bootstrapProjectLanguageConfig(projectRoot, '   ')).toThrow('Language must be non-empty');
    expect(existsSync(join(projectRoot, '.peaks', 'config.json'))).toBe(false);
  });

  // Cycle 2 RD coverage-closure: getProjectWriteTarget throw branch (L369-370).
  // writeConfig({...}, 'project') and setConfig({..., layer: 'project'}) both
  // call getProjectWriteTarget() first; when findProjectRoot returns null
  // (no project marker visible from the cwd), the helper throws
  // "Project config not found" before any write happens.
  test('writeConfig project layer throws when no project root is discoverable (L369-370)', () => {
    // A tempdir with no .peaks/ and no .git/ and no package.json/ — the
    // "no project root" state. We also point cwd at it.
    const emptyRoot = mkdtempSync(join(tmpdir(), 'peaks-no-project-'));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(emptyRoot);
    try {
      expect(() => writeConfig({ language: 'en' }, 'project')).toThrow('Project config not found');
    } finally {
      cwdSpy.mockRestore();
    }
  });

  test('setConfig project layer throws when no project root is discoverable (L369-370)', () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'peaks-no-project-'));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(emptyRoot);
    try {
      expect(() => setConfig({ key: 'safeFlag', value: 'enabled', layer: 'project' })).toThrow('Project config not found');
    } finally {
      cwdSpy.mockRestore();
    }
  });

  // Cycle 2 RD coverage-closure: isValidLegacyMiniMaxBaseUrl catch branch (L446-447).
  // When the stored baseUrl is unparseable, the helper returns false. We
  // trigger the path via getMiniMaxProviderStatus(), which reads the
  // stored baseUrl via getMiniMaxProviderConfig() and calls
  // createLegacyMiniMaxProviderStatus (which calls isValidLegacyMiniMaxBaseUrl)
  // without going through validateMiniMaxBaseUrl first.
  test('getMiniMaxProviderStatus handles an unparseable stored baseUrl gracefully (L446-447)', () => {
    mkdirSync(join(configTestHome, '.peaks'), { recursive: true });
    // Write a baseUrl that `new URL(...)` will reject outright. We bypass
    // the writeConfig validation by writing the file directly.
    writeFileSync(
      join(configTestHome, '.peaks', 'config.json'),
      JSON.stringify({ providers: { minimax: { baseUrl: 'not a url at all', apiKey: 'secret' } } }),
      'utf8'
    );

    // getMiniMaxProviderStatus must not throw — the legacy helper
    // returns false on unparseable URLs.
    const status = getMiniMaxProviderStatus();
    expect(status.baseUrlConfigured).toBe(false);
    expect(status.apiKeyConfigured).toBe(true);
    expect(status.configured).toBe(false);
  });

  test('normalizes external config shapes before exposing provider config', () => {
    writeConfig({ providers: { minimax: { model: 'minimax-2.7', baseUrl: 'https://api.minimaxi.com/anthropic', apiKey: 123 as unknown as string } as never } }, 'user');
    const providerConfig = getMiniMaxProviderConfig();
    expect(providerConfig.model).toBe('minimax-2.7');
    expect(providerConfig.baseUrl).toBe('https://api.minimaxi.com/anthropic');
    expect(providerConfig.apiKey).toBeUndefined();
  });

  test('normalizes token refs and drops malformed token config entries', () => {
    writeConfig({
      tokens: {
        GitHubToken: { ghCli: true },
        OpenAiApiKey: { env: '  OPENAI_KEY  ' },
        AnthropicApiKey: { env: '' } as never,
        // Cycle 2 RD coverage-closure: the `keychain: 'service-account'`
        // entry below covers the `if (keychain.length > 0) return { keychain }`
        // branch at config-service.ts L333-335. The previous test
        // configuration used `keychain: ' '` which trims to empty and
        // therefore hit the same drop branch as the env: '' case.
        GitLabToken: { keychain: 'service-account' },
        ExtraToken: { env: 'SHOULD_NOT_SURVIVE' } as never
      }
    } as never, 'user');

    const config = getConfig({ layer: 'user' }) as { tokens?: Record<string, unknown> };
    expect(config.tokens).toMatchObject({
      GitHubToken: { ghCli: true },
      OpenAiApiKey: { env: 'OPENAI_KEY' },
      GitLabToken: { keychain: 'service-account' }
    });
    expect(config.tokens?.AnthropicApiKey).toBeUndefined();
    expect(config.tokens?.ExtraToken).toBeUndefined();
  });

  test('accepts local and remote artifactStorage entries for workspaces', () => {
    writeConfig({
      workspaces: [
        {
          workspaceId: 'ws-local-artifacts',
          name: 'Local Artifacts',
          rootPath: '/tmp/ws-local-artifacts',
          installedCapabilityIds: [],
          artifactStorage: { mode: 'local' }
        },
        {
          workspaceId: 'ws-remote-artifacts',
          name: 'Remote Artifacts',
          rootPath: '/tmp/ws-remote-artifacts',
          installedCapabilityIds: [],
          artifactStorage: {
            mode: 'local-with-remote-sync',
            remote: { provider: 'gitlab', owner: 'acme', name: 'peaks-artifacts' }
          }
        }
      ]
    } as never, 'user');

    const userConfig = getConfig({ layer: 'user' }) as { workspaces?: Array<{ workspaceId: string; artifactStorage?: unknown }> };
    expect(userConfig.workspaces).toMatchObject([
      { workspaceId: 'ws-local-artifacts', artifactStorage: { mode: 'local' } },
      { workspaceId: 'ws-remote-artifacts', artifactStorage: { mode: 'local-with-remote-sync', remote: { provider: 'gitlab', owner: 'acme', name: 'peaks-artifacts' } } }
    ]);
  });

  test('drops invalid artifactStorage entries while preserving valid workspace fields', () => {
    writeConfig({
      workspaces: [
        {
          workspaceId: 'ws-invalid-artifacts',
          name: 'Invalid Artifacts',
          rootPath: '/tmp/ws-invalid-artifacts',
          installedCapabilityIds: [],
          artifactStorage: { mode: 'remote', remote: { provider: 'gitea', owner: 'acme', name: 'repo' } }
        }
      ]
    } as never, 'user');

    const userConfig = getConfig({ layer: 'user' }) as { workspaces?: Array<{ workspaceId: string; name: string; artifactStorage?: unknown }> };
    const workspace = userConfig.workspaces?.find((item) => item.workspaceId === 'ws-invalid-artifacts');

    expect(workspace).toMatchObject({ workspaceId: 'ws-invalid-artifacts', name: 'Invalid Artifacts' });
    expect((workspace as { artifactStorage?: unknown } | undefined)?.artifactStorage).toBeUndefined();
  });

  test('drops workspaces with unsafe workspace ids', () => {
    writeConfig({
      workspaces: [
        { workspaceId: '../escape', name: 'Escape', rootPath: '/tmp/escape', installedCapabilityIds: [] },
        { workspaceId: 'nested/path', name: 'Nested', rootPath: '/tmp/nested', installedCapabilityIds: [] },
        { workspaceId: 'safe-workspace_1', name: 'Safe', rootPath: '/tmp/safe', installedCapabilityIds: [] }
      ]
    } as never, 'user');

    const userConfig = getConfig({ layer: 'user' }) as { workspaces?: Array<{ workspaceId: string }> };
    expect(userConfig.workspaces?.map((workspace) => workspace.workspaceId)).toEqual(['safe-workspace_1']);
  });

  test('drops artifact remote repos with unsafe owner or name segments', () => {
    writeConfig({
      workspaces: [
        {
          workspaceId: 'unsafe-legacy-remote',
          name: 'Unsafe Legacy Remote',
          rootPath: '/tmp/unsafe-legacy-remote',
          installedCapabilityIds: [],
          artifactRepo: { provider: 'github', owner: '../acme', name: 'repo' }
        },
        {
          workspaceId: 'unsafe-storage-remote',
          name: 'Unsafe Storage Remote',
          rootPath: '/tmp/unsafe-storage-remote',
          installedCapabilityIds: [],
          artifactStorage: { mode: 'local-with-remote-sync', remote: { provider: 'gitlab', owner: 'acme', name: 'repo/escape' } }
        }
      ]
    } as never, 'user');

    const userConfig = getConfig({ layer: 'user' }) as { workspaces?: Array<{ workspaceId: string; artifactRepo?: unknown; artifactStorage?: unknown }> };
    expect(userConfig.workspaces?.find((workspace) => workspace.workspaceId === 'unsafe-legacy-remote')?.artifactRepo).toBeUndefined();
    expect(userConfig.workspaces?.find((workspace) => workspace.workspaceId === 'unsafe-storage-remote')?.artifactStorage).toBeUndefined();
  });

  test('finds the most specific workspace containing a path', () => {
    const parentRoot = mkdtempSync(join(tmpdir(), 'peaks-config-parent-workspace-'));
    const childRoot = join(parentRoot, 'packages', 'app');
    const outsideRoot = mkdtempSync(join(tmpdir(), 'peaks-config-outside-workspace-'));
    mkdirSync(childRoot, { recursive: true });
    writeConfig({
      workspaces: [
        { workspaceId: 'parent-ws', name: 'Parent WS', rootPath: parentRoot, installedCapabilityIds: [] },
        { workspaceId: 'child-ws', name: 'Child WS', rootPath: childRoot, installedCapabilityIds: [] },
        { workspaceId: 'relative-ws', name: 'Relative WS', rootPath: '.', installedCapabilityIds: [] },
        { workspaceId: 'missing-ws', name: 'Missing WS', rootPath: join(parentRoot, 'missing'), installedCapabilityIds: [] }
      ]
    } as never, 'user');

    expect(getWorkspaceConfigForPath(join(childRoot, 'src', 'index.ts'))?.workspaceId).toBe('child-ws');
    expect(getWorkspaceConfigForPath(outsideRoot)).toBeNull();
  });

  test('ensureWorkspaceConfigForPath returns null when no workspace matches', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'peaks-config-auto-workspace-'));
    mkdirSync(join(projectRoot, '.peaks'), { recursive: true });

    const workspace = ensureWorkspaceConfigForPath(projectRoot);
    expect(workspace).toBeNull();
  });

  test('user workspaces are stored in user config layer', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'peaks-config-shadow-project-'));
    const userArtifactRoot = mkdtempSync(join(tmpdir(), 'peaks-config-user-artifacts-'));
    mkdirSync(join(projectRoot, '.peaks'), { recursive: true });
    writeConfig({
      workspaces: [{ workspaceId: 'repo-ws', name: 'User Repo WS', rootPath: projectRoot, installedCapabilityIds: [], artifactStorage: { mode: 'local', localPath: userArtifactRoot } }]
    } as never, 'user');
    writeFileSync(join(projectRoot, '.peaks', 'config.json'), JSON.stringify({ workspaces: [{ workspaceId: 'repo-ws', name: 'Project Shadow WS', rootPath: '/tmp/project-shadow', installedCapabilityIds: [] }] }), 'utf8');

    const userConfig = getConfig({ layer: 'user' }) as { workspaces?: Array<{ workspaceId: string; name: string; rootPath: string }> };
    const workspace = userConfig.workspaces?.find((item) => item.workspaceId === 'repo-ws');
    expect(workspace).toMatchObject({ name: 'User Repo WS', rootPath: projectRoot });
  });

  test('workspace helpers tolerate malformed layer config and use the requested layer', () => {
    writeConfig({ workspaces: 'broken' as never, currentWorkspace: 123 as never } as never, 'user');
    addWorkspace({ workspaceId: 'ws-a', name: 'Workspace A', rootPath: '/tmp/ws-a', installedCapabilityIds: [] }, 'user');
    const userConfig = getConfig({ layer: 'user' }) as { workspaces?: Array<{ workspaceId: string }> };
    expect(userConfig.workspaces).toMatchObject([{ workspaceId: 'ws-a' }]);
    expect(setCurrentWorkspace('ws-a', 'user')).toBe(true);
    expect(removeWorkspace('ws-a', 'user')).toBe(true);
  });

  test('rejects unsafe nested config paths and ignores polluted reads', () => {
    expect(() => setConfig({ key: '__proto__.polluted', value: true })).toThrow('Unsafe config path');
    expect(() => setConfig({ key: 'constructor.prototype.polluted', value: true })).toThrow('Unsafe config path');
    expect(() => setConfig({ key: 'safe.path', value: 'ok' })).not.toThrow();
    expect(getConfig({ key: '__proto__.polluted' })).toBeUndefined();
  });

  test('normalizes malformed persisted configs when reading the full config', () => {
    writeFileSync(join(configTestHome, '.peaks', 'config.json'), JSON.stringify({ workspaces: 'broken', currentWorkspace: 123 }), 'utf8');
    const config = readConfig();

    expect(config.version).toBeDefined();
    // 2.0.1 slim: `model` is no longer synthesised by DEFAULT_CONFIG;
    // assert `ocr.llm` is the new always-present placeholder block.
    expect(config.ocr?.llm).toBeDefined();
  });

  test('rejects user config writes when config.json is hardlinked', () => {
    const outsideRoot = mkdtempSync(join(tmpdir(), 'peaks-config-outside-'));
    const outsideConfigPath = join(outsideRoot, 'config.json');
    const configPath = join(configTestHome, '.peaks', 'config.json');
    mkdirSync(join(configTestHome, '.peaks'), { recursive: true });
    writeFileSync(outsideConfigPath, '{}', 'utf8');
    if (existsSync(configPath)) unlinkSync(configPath);
    linkSync(outsideConfigPath, configPath);

    try {
      expect(() => writeConfig({ language: 'zh-CN' }, 'user')).toThrow('Config path must not be hardlinked');
      expect(() => getConfig({ layer: 'user' })).toThrow('Config path must not be hardlinked');
      expect(readFileSync(outsideConfigPath, 'utf8')).toBe('{}');
    } finally {
      if (existsSync(configPath)) unlinkSync(configPath);
      writeFileSync(configPath, '{}', 'utf8');
    }
  });

  fileSymlinkTest('rejects user config writes when config.json is a symlink', () => {
    const outsideRoot = mkdtempSync(join(tmpdir(), 'peaks-config-outside-'));
    const outsideConfigPath = join(outsideRoot, 'config.json');
    const configPath = join(configTestHome, '.peaks', 'config.json');
    mkdirSync(join(configTestHome, '.peaks'), { recursive: true });
    writeFileSync(outsideConfigPath, '{}', 'utf8');
    if (existsSync(configPath)) unlinkSync(configPath);
    symlinkSync(outsideConfigPath, configPath);

    // Slice 2026-06-13-repair-pre-existing-test-failures: use
    // `writeConfig` (which does not apply the 2.0.1 legacy-key guard)
    // instead of `setConfig({ key: 'language', ... })`, so the symlink
    // path guard fires BEFORE the legacy-key rejection. The legacy
    // guard intentionally short-circuits on `language`, masking the
    // symlink guard on the older API surface.
    try {
      expect(() => writeConfig({ language: 'zh-CN' }, 'user')).toThrow('User config path must stay inside the user root');
      expect(() => getConfig({ layer: 'user' })).toThrow('User config path must stay inside the user root');
      expect(readFileSync(outsideConfigPath, 'utf8')).toBe('{}');
    } finally {
      // try/finally so a mid-test failure does not leak the symlink
      // into later tests in this file (cascade caused 5 other
      // config-service tests to fail with `validateUserConfigPathForWrite`
      // throwing on a stale symlink at configPath).
      if (existsSync(configPath)) unlinkSync(configPath);
      writeFileSync(configPath, '{}', 'utf8');
    }
  });

  test('rejects artifact marker creation when artifact .peaks is a symlink', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'peaks-config-project-'));
    const artifactRoot = mkdtempSync(join(tmpdir(), 'peaks-config-artifacts-'));
    const outsideRoot = mkdtempSync(join(tmpdir(), 'peaks-config-outside-'));
    symlinkSync(outsideRoot, join(artifactRoot, '.peaks'), 'junction');
    writeConfig({
      workspaces: [{ workspaceId: 'unsafe-artifact-marker', name: 'Unsafe Artifact Marker', rootPath: projectRoot, installedCapabilityIds: [], artifactStorage: { mode: 'local', localPath: artifactRoot } }]
    } as never, 'user');

    expect(() => ensureWorkspaceConfigForPath(projectRoot)).toThrow('Artifact workspace marker must stay inside the artifact workspace');
    expect(existsSync(join(outsideRoot, 'config.json'))).toBe(false);
  });

  test('rejects artifact marker creation when artifact root is a symlink into the project', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'peaks-config-project-'));
    const artifactTarget = join(projectRoot, 'artifacts');
    const artifactRoot = join(tmpdir(), `peaks-config-linked-artifacts-${Date.now()}`);
    mkdirSync(artifactTarget, { recursive: true });
    symlinkSync(artifactTarget, artifactRoot, 'junction');
    writeConfig({
      workspaces: [{ workspaceId: 'unsafe-artifact-root', name: 'Unsafe Artifact Root', rootPath: projectRoot, installedCapabilityIds: [], artifactStorage: { mode: 'local', localPath: artifactRoot } }]
    } as never, 'user');

    expect(() => ensureWorkspaceConfigForPath(projectRoot)).toThrow('Artifact workspace marker must stay inside the artifact workspace');
    expect(existsSync(join(artifactTarget, '.peaks', 'config.json'))).toBe(false);
  });

  test('rejects MiniMax provider updates when an existing stored URL is invalid', () => {
    // Slice 2026-06-13-repair-pre-existing-test-failures: ensure the
    // `.peaks` directory exists before writeFileSync (otherwise the
    // write throws ENOENT before the MiniMax URL validator fires).
    mkdirSync(join(configTestHome, '.peaks'), { recursive: true });
    writeFileSync(join(configTestHome, '.peaks', 'config.json'), JSON.stringify({ providers: { minimax: { baseUrl: 'https://example.com/anthropic' } } }), 'utf8');
    expect(() => setMiniMaxProviderConfig({ apiKey: 'secret' })).toThrow('MiniMax base URL must be the MiniMax HTTPS endpoint without embedded credentials');
  });
});

// Note: `loadGlobalConfig` and its 1.x throw / promotion paths are
// covered in `tests/unit/load-global-config.test.ts` (split out of this
// file during the cycle 2 file-size-cap refactor — this file exceeded
// the 800-line cap once the coverage-closure tests were added).

