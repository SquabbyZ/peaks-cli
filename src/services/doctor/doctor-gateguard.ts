import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { findProjectRoot } from '../config/config-safety.js';

/**
 * 2026-06-10 — `gateguard-fact-force` (a third-party PreToolUse hook,
 * NOT peaks-cli) fires on Edit / Write and demands a 4-fact questionnaire
 * before allowing the edit. When the LLM is in a peaks-qa flow and tries
 * to update `.peaks/_runtime/<sid>/qa/requests/*.md` via the Edit/Write
 * tool, the hook demands facts that are inapplicable to QA envelope
 * templates (no importers, no public API, no data files, user
 * instruction already in the conversation context). The check detects
 * this hook in the user's global and project `.claude/settings.json` and
 * warns when no `.peaks/**` skip is configured. The probe is injected so
 * tests do not depend on the real `~/.claude/settings.json` state.
 */
export type GateguardHookLocation = {
  /** Source file the hook was discovered in (`global` or `project .claude/settings.json`). */
  source: 'global' | 'project';
  /** Resolved absolute path to the source file (for the message). */
  sourcePath: string;
  /** The PreToolUse entry that contains a gateguard hook command. */
  entry: {
    matcher?: string;
    hooks: ReadonlyArray<{ type?: string; command?: string }>;
  };
};

export type GateguardProbeResult = {
  /** Absolute path to `~/.claude/settings.json` (or null when the probe could not resolve it). */
  globalSettingsPath: string | null;
  /** Parsed global settings payload (or null when missing / unreadable / malformed). */
  globalSettings: unknown;
  /** Absolute path to the project `.claude/settings.json` (or null when the project root is not in a peaks project). */
  projectSettingsPath: string | null;
  /** Parsed project settings payload (or null when missing / unreadable / malformed). */
  projectSettings: unknown;
};

export type GateguardProbe = () => GateguardProbeResult;

// ---------------------------------------------------------------------------
// 2026-06-10 — gateguard-fact-force integration check (NOT a peaks-cli hook).
//
// The `gateguard-fact-force` hook is a third-party PreToolUse hook that
// fires on Edit / Write / MultiEdit and demands a 4-fact questionnaire
// before allowing the edit. It is unrelated to peaks-cli, but when the
// LLM is in a peaks-qa flow and edits `.peaks/_runtime/<sid>/qa/requests/
// *.md`, the questionnaire demands facts that do not apply (no
// importers, no public API, no data files, user instruction already
// in the conversation context). The check below detects the hook in
// `~/.claude/settings.json` and the project `.claude/settings.json`,
// and warns when no `.peaks/**` skip is configured.
//
// Probing is split out of the check so the check itself stays a pure
// mapping over `GateguardProbeResult`. Tests inject the probe to keep
// `~/.claude/settings.json` from leaking into test fixtures.
// ---------------------------------------------------------------------------

/** Hook command fragments that identify the gateguard-fact-force hook. */
export const GATEGUARD_HOOK_NEEDLES: ReadonlyArray<string> = ['gateguard', 'fact-force', 'fact_force'];

/** Token the gateguard hook exposes for "skip these paths" — the check
 *  treats any match against `.peaks` (path or globs) as a routed
 *  configuration. We accept a few common spellings because the third-
 *  party hook's CLI surface is not part of peaks-cli's contract. */
export const GATEGUARD_PEAKS_SKIP_NEEDLES: ReadonlyArray<string> = [
  '.peaks',
  'peaks-skip',
  'skip-glob',
  '--skip',
  'skip_paths'
];

export function commandMentionsGateguard(command: string | undefined): boolean {
  if (typeof command !== 'string' || command.length === 0) return false;
  const lower = command.toLowerCase();
  return GATEGUARD_HOOK_NEEDLES.some((needle) => lower.includes(needle));
}

export function entrySkipsPeaks(entry: GateguardHookLocation['entry']): boolean {
  const matcher = typeof entry.matcher === 'string' ? entry.matcher : '';
  const matcherMentionsPeaks = matcher.toLowerCase().includes('.peaks');
  if (matcherMentionsPeaks) return true;
  for (const hook of entry.hooks) {
    const command = typeof hook.command === 'string' ? hook.command : '';
    const lower = command.toLowerCase();
    if (GATEGUARD_PEAKS_SKIP_NEEDLES.some((needle) => lower.includes(needle))) {
      return true;
    }
  }
  return false;
}

export function extractGateguardEntries(
  source: 'global' | 'project',
  sourcePath: string,
  settings: unknown
): GateguardHookLocation[] {
  if (settings === null || typeof settings !== 'object') return [];
  const hooks = (settings as { hooks?: unknown }).hooks;
  if (hooks === null || typeof hooks !== 'object') return [];
  const preToolUse = (hooks as { PreToolUse?: unknown }).PreToolUse;
  if (!Array.isArray(preToolUse)) return [];

  const out: GateguardHookLocation[] = [];
  for (const rawEntry of preToolUse) {
    if (rawEntry === null || typeof rawEntry !== 'object') continue;
    const entry = rawEntry as {
      matcher?: unknown;
      hooks?: unknown;
    };
    if (!Array.isArray(entry.hooks)) continue;
    const hooks: Array<{ type?: string; command?: string }> = [];
    for (const rawHook of entry.hooks) {
      if (rawHook === null || typeof rawHook !== 'object') continue;
      const h = rawHook as { type?: unknown; command?: unknown };
      const hookEntry: { type?: string; command?: string } = {};
      if (typeof h.type === 'string') hookEntry.type = h.type;
      if (typeof h.command === 'string') hookEntry.command = h.command;
      hooks.push(hookEntry);
    }
    if (!hooks.some((h) => commandMentionsGateguard(h.command))) continue;
    const outEntry: {
      matcher?: string;
      hooks: ReadonlyArray<{ type?: string; command?: string }>;
    } = { hooks };
    if (typeof entry.matcher === 'string') outEntry.matcher = entry.matcher;
    out.push({ source, sourcePath, entry: outEntry });
  }
  return out;
}

function readSettingsJson(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

export function defaultGateguardProbe(): GateguardProbeResult {
  const projectRoot = findProjectRoot(process.cwd());
  const globalPath = join(homedir(), '.claude', 'settings.json');
  const projectPath = projectRoot === null ? null : join(projectRoot, '.claude', 'settings.json');

  return {
    globalSettingsPath: globalPath,
    globalSettings: readSettingsJson(globalPath),
    projectSettingsPath: projectPath,
    projectSettings: projectPath === null ? null : readSettingsJson(projectPath)
  };
}

export function collectGateguardEntries(probe: GateguardProbeResult): GateguardHookLocation[] {
  const fromGlobal = extractGateguardEntries('global', probe.globalSettingsPath ?? '~/.claude/settings.json', probe.globalSettings);
  const fromProject = probe.projectSettingsPath === null
    ? []
    : extractGateguardEntries('project', probe.projectSettingsPath, probe.projectSettings);
  return [...fromGlobal, ...fromProject];
}
