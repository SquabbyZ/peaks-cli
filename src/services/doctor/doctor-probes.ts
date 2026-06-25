import { join } from 'node:path';
import { createRequire } from 'node:module';
import { dirname, resolve as resolvePath } from 'node:path';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { findProjectRoot } from '../config/config-safety.js';
import { planStatusLineInstall } from '../skills/statusline-settings-service.js';

export type CodegraphCapabilityProbe = {
  packagePath: string;
  version: string;
  binaryPath: string;
  binaryExists: boolean;
};

export type DistVersionComparison = {
  dist: string | null;
  source: string;
  match: boolean;
  distReadable: boolean;
};

export type DistVersionProbe = () => DistVersionComparison;

export type WorkspaceLayoutInspection = {
  topLevelSessionDirs: string[];
  legacyDotfiles: string[];
  /**
   * Slice 007 — per-change-id top-level dirs (e.g. `.peaks/001-2026-06-06-.../`).
   * The pre-F3 canonical layout put reviewable artifacts under a
   * per-change-id top-level dir; the post-F3 canonical layout
   * consolidates them under `.peaks/_runtime/<sid>/<role>/`. Any
   * leftover per-change-id top-level dir is a regression to flag.
   * Slice 008's migration will consolidate these; until then, the
   * check reports them as `ok: false`.
   *
   * Optional in the type for back-compat with test probes that
   * pre-date the slice 007 broadening; the check itself falls back
   * to an empty array when the field is missing.
   */
  perChangeIdDirs?: string[];
};

export type WorkspaceLayoutProbe = () => WorkspaceLayoutInspection;

export function defaultCodegraphProbe(): CodegraphCapabilityProbe {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve('@colbymchenry/codegraph/package.json');
  const pkg = require(packagePath) as { version?: string };
  const binaryPath = resolvePath(dirname(packagePath), 'dist', 'bin', 'codegraph.js');
  return {
    packagePath,
    version: pkg.version ?? 'unknown',
    binaryPath,
    binaryExists: existsSync(binaryPath)
  };
}

export function defaultStatusLineInstalledProbe(): boolean {
  const projectRoot = findProjectRoot(process.cwd());
  // Check both scopes: a user may have installed the statusLine globally, which
  // the project-only check would miss and falsely report as "not installed".
  try {
    if (projectRoot !== null && planStatusLineInstall('project', projectRoot).alreadyInstalled) {
      return true;
    }
  } catch {
    /* fall through to global */
  }
  try {
    return planStatusLineInstall('global').alreadyInstalled;
  } catch {
    return false;
  }
}

export function defaultWorkspaceInitializedProbe(): boolean {
  const projectRoot = findProjectRoot(process.cwd());
  if (projectRoot === null) return false;
  // Workspace is "initialized" when EITHER the canonical runtime-layer session
  // binding (`.peaks/_runtime/session.json`, the home since slice
  // 2026-06-05-peaks-runtime-layer) OR the legacy top-level binding
  // (`.peaks/.session.json`, kept as read-only back-compat for one minor
  // release) is present. The legacy check is what catches projects that ran
  // `peaks workspace init` before the runtime-layer migration and have not yet
  // been reconciled; both paths must continue to satisfy the doctor until the
  // legacy location is removed.
  return isWorkspaceInitializedAt(projectRoot);
}

/**
 * Pure helper extracted from `defaultWorkspaceInitializedProbe` so tests can
 * drive the filesystem check without monkey-patching `process.cwd()` or
 * `findProjectRoot`. Returns `true` when EITHER the canonical
 * `.peaks/_runtime/session.json` OR the legacy `.peaks/.session.json` exists.
 */
export function isWorkspaceInitializedAt(projectRoot: string): boolean {
  return (
    existsSync(join(projectRoot, '.peaks', '_runtime', 'session.json')) ||
    existsSync(join(projectRoot, '.peaks', '.session.json'))
  );
}

/**
 * Pure helper that compares the published dist `CLI_VERSION` against the
 * source-of-truth `package.json#version`. Default readers fail-soft to `null`
 * on missing/unreadable/malformed input. Exported so tests can drive the
 * filesystem reads without monkey-patching `process.cwd()`.
 */
export function compareDistVersion(opts: {
  projectRoot: string;
  distVersionReader?: (root: string) => string | null;
  sourceVersionReader?: (root: string) => string | null;
}): DistVersionComparison {
  const distReader = opts.distVersionReader ?? defaultDistVersionReader;
  const sourceReader = opts.sourceVersionReader ?? defaultSourceVersionReader;
  const dist = safeRead(() => distReader(opts.projectRoot));
  const source = safeRead(() => sourceReader(opts.projectRoot)) ?? 'unknown';
  const distReadable = dist !== null;
  return {
    dist,
    source,
    match: distReadable && dist === source,
    distReadable
  };
}

function safeRead(reader: () => string | null): string | null {
  try {
    return reader();
  } catch {
    return null;
  }
}

function defaultDistVersionReader(projectRoot: string): string | null {
  // Synchronous read is fine: the dist version.js is small and on the
  // local build pipeline's hot path. readFileSync + regex is cheaper
  // than pulling in fs/promises for a single short file.
  const distPath = join(projectRoot, 'dist', 'src', 'shared', 'version.js');
  if (!existsSync(distPath)) {
    return null;
  }
  const body = readFileSync(distPath, 'utf8');
  const match = /export\s+const\s+CLI_VERSION\s*=\s*["']([^"']+)["']/.exec(body);
  return match?.[1] ?? null;
}

function defaultSourceVersionReader(projectRoot: string): string | null {
  const pkgPath = join(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    return null;
  }
  const body = readFileSync(pkgPath, 'utf8');
  const parsed = JSON.parse(body) as { version?: unknown };
  return typeof parsed.version === 'string' ? parsed.version : null;
}

export function defaultDistVersionProbe(): DistVersionComparison {
  const projectRoot = findProjectRoot(process.cwd());
  if (projectRoot === null) {
    return { dist: null, source: 'unknown', match: false, distReadable: false };
  }
  return compareDistVersion({ projectRoot });
}

/**
 * Pure helper that inspects the on-disk workspace layout for
 * post-F3-canonical violations. The post-F3 canonical layout puts
 * session dirs under `.peaks/_runtime/<sid>/` and the runtime
 * binding at `.peaks/_runtime/session.json`; the legacy paths
 * (top-level `<YYYY-MM-DD-session-<hex>>/` dirs and the legacy
 * top-level `.peaks/.session.json` / `.peaks/.active-skill.json`
 * dotfiles) must be absent. This helper is exported so tests can
 * drive the filesystem walk without monkey-patching `process.cwd()`
 * or `findProjectRoot`.
 *
 * Both scanners fail-soft (return `[]` on read errors) so a flaky
 * filesystem read on a non-fatal probe path never escalates into a
 * doctor failure.
 */
export function inspectWorkspaceLayout(opts: {
  projectRoot: string;
  topLevelScanner?: (root: string) => string[];
  dotfileScanner?: (root: string) => string[];
  perChangeIdScanner?: (root: string) => string[];
}): WorkspaceLayoutInspection {
  const topLevel = opts.topLevelScanner ?? defaultTopLevelSessionDirScanner;
  const dotfiles = opts.dotfileScanner ?? defaultLegacyDotfileScanner;
  const perChangeId = opts.perChangeIdScanner ?? defaultPerChangeIdDirScanner;
  return {
    topLevelSessionDirs: safeList(() => topLevel(opts.projectRoot)),
    legacyDotfiles: safeList(() => dotfiles(opts.projectRoot)),
    perChangeIdDirs: safeList(() => perChangeId(opts.projectRoot))
  };
}

function safeList(reader: () => string[]): string[] {
  try {
    const out = reader();
    return Array.isArray(out) ? out : [];
  } catch {
    return [];
  }
}

const SESSION_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}-session-[a-f0-9]+$/;

export function defaultTopLevelSessionDirScanner(projectRoot: string): string[] {
  const peaksRoot = join(projectRoot, '.peaks');
  if (!existsSync(peaksRoot)) return [];
  let names: string[];
  try {
    names = readdirSync(peaksRoot);
  } catch {
    return [];
  }
  const offenders: string[] = [];
  for (const name of names) {
    if (!SESSION_DIR_PATTERN.test(name)) continue;
    const full = join(peaksRoot, name);
    try {
      const stat = existsSync(full) ? lstatSync(full) : null;
      if (stat === null) continue;
      // Directories only — the regex should never match a dotfile or
      // regular file, but be defensive against weird filesystem state
      // (e.g. someone manually created a file whose name happens to
      // match the session-id pattern).
      if (stat.isDirectory()) {
        offenders.push(join('.peaks', name) + '/');
      }
    } catch {
      continue;
    }
  }
  return offenders;
}

const LEGACY_DOTFILES: ReadonlyArray<string> = ['.session.json', '.active-skill.json'];

export function defaultLegacyDotfileScanner(projectRoot: string): string[] {
  const peaksRoot = join(projectRoot, '.peaks');
  if (!existsSync(peaksRoot)) return [];
  const offenders: string[] = [];
  for (const name of LEGACY_DOTFILES) {
    if (existsSync(join(peaksRoot, name))) {
      offenders.push(join('.peaks', name));
    }
  }
  return offenders;
}

export function defaultWorkspaceLayoutProbe(): WorkspaceLayoutInspection {
  const projectRoot = findProjectRoot(process.cwd());
  if (projectRoot === null) {
    return { topLevelSessionDirs: [], legacyDotfiles: [], perChangeIdDirs: [] };
  }
  return inspectWorkspaceLayout({ projectRoot });
}

// Slice 007 — per-change-id top-level dir pattern. Matches the
// F3-canonical (pre-canonicalization) layout the 5 already-shipped
// slices left behind, e.g. `.peaks/001-2026-06-06-doctor-dist-version-check/`.
// The pattern is intentionally narrow so it does NOT match the
// post-F3 system dirs (`_runtime/`, `_dogfood/`, `retrospective/`,
// `memory/`, `perf-baseline/`, `project-scan/`, `sops/`,
// `0NN-session-...`, `YYYY-MM-DD-session-...`).
const PER_CHANGE_ID_PATTERN = /^\d{3}-\d{4}-\d{2}-\d{2}-[a-z][a-z0-9-]*[a-z0-9]$/;

export function defaultPerChangeIdDirScanner(projectRoot: string): string[] {
  const peaksRoot = join(projectRoot, '.peaks');
  if (!existsSync(peaksRoot)) return [];
  let names: string[];
  try {
    names = readdirSync(peaksRoot);
  } catch {
    return [];
  }
  const offenders: string[] = [];
  for (const name of names) {
    if (!PER_CHANGE_ID_PATTERN.test(name)) continue;
    const full = join(peaksRoot, name);
    try {
      const stat = existsSync(full) ? lstatSync(full) : null;
      if (stat === null) continue;
      // Directories only — the regex should never match a dotfile
      // or regular file, but be defensive against weird filesystem
      // state (e.g. someone manually created a file whose name
      // happens to match the per-change-id pattern).
      if (stat.isDirectory()) {
        offenders.push(join('.peaks', name) + '/');
      }
    } catch {
      continue;
    }
  }
  return offenders;
}
