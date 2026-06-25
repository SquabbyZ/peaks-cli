import { existsSync } from 'node:fs';
import type { PeaksConfig, WorkspaceConfig } from './config-types.js';
import { readConfigFileSafely } from './config-safety.js';

/**
 * Pure path / value utilities used by the config service family.
 * These helpers are deterministic and side-effect-free; they
 * exist in their own module so `config-service.ts`, `workspace-state-service.ts`,
 * and any future config-aware feature can share them without a circular
 * import back through `config-service.ts`.
 *
 * `getNestedPathParts` and `setNestedValue` defend against prototype-pollution
 * vectors (`__proto__`, `constructor`, `prototype`) by rejecting those segments
 * before any property access.
 */

const UNSAFE_NESTED_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

export function getNestedPathParts(path: string): string[] {
  return path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
}

export function hasUnsafeNestedPathSegment(parts: string[]): boolean {
  return parts.some((part) => UNSAFE_NESTED_PATH_SEGMENTS.has(part));
}

export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = getNestedPathParts(path);
  if (parts.length === 0 || hasUnsafeNestedPathSegment(parts)) {
    return undefined;
  }

  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = getNestedPathParts(path);
  if (parts.length === 0 || hasUnsafeNestedPathSegment(parts)) {
    throw new Error('Unsafe config path');
  }

  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i] as string;
    if (!Object.prototype.hasOwnProperty.call(current, part) || typeof current[part] !== 'object' || current[part] === null || Array.isArray(current[part])) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1] as string;
  current[last] = value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readJsonFile(path: string | null, validateBeforeRead?: () => void, errorMessage = 'Config path must stay inside the config root'): Partial<PeaksConfig> | null {
  if (!path || !existsSync(path)) return null;
  validateBeforeRead?.();
  const content = readConfigFileSafely(path, errorMessage);
  try {
    return JSON.parse(content) as Partial<PeaksConfig>;
  } catch {
    return null;
  }
}

export function isSafeConfigSegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && !value.includes('..') && !value.endsWith('.');
}

export function toArtifactRemoteRepoConfig(value: unknown): WorkspaceConfig['artifactRepo'] | null {
  if (!isRecord(value) || (value.provider !== 'github' && value.provider !== 'gitlab') || typeof value.owner !== 'string' || typeof value.name !== 'string') {
    return null;
  }
  if (!isSafeConfigSegment(value.owner) || !isSafeConfigSegment(value.name)) {
    return null;
  }
  return { provider: value.provider, owner: value.owner, name: value.name };
}

export function toArtifactStorageConfig(value: unknown): WorkspaceConfig['artifactStorage'] | null {
  if (!isRecord(value)) return null;
  const localPath = typeof value.localPath === 'string' ? { localPath: value.localPath } : {};
  if (value.mode === 'local') {
    return { mode: 'local', ...localPath };
  }
  const remote = toArtifactRemoteRepoConfig(value.remote);
  if (value.mode === 'local-with-remote-sync' && remote) {
    return { mode: 'local-with-remote-sync', ...localPath, remote };
  }
  return null;
}

export function toWorkspaceConfig(value: unknown): WorkspaceConfig | null {
  if (!isRecord(value)) return null;
  const { workspaceId, name, rootPath, installedCapabilityIds } = value;
  if (typeof workspaceId !== 'string' || !isSafeConfigSegment(workspaceId) || typeof name !== 'string' || typeof rootPath !== 'string' || !Array.isArray(installedCapabilityIds) || !installedCapabilityIds.every((id) => typeof id === 'string')) {
    return null;
  }
  const artifactRepo = toArtifactRemoteRepoConfig(value.artifactRepo);
  const artifactStorage = toArtifactStorageConfig(value.artifactStorage);
  return {
    workspaceId,
    name,
    rootPath,
    installedCapabilityIds,
    ...(artifactRepo ? { artifactRepo } : {}),
    ...(artifactStorage ? { artifactStorage } : {})
  };
}

export function toWorkspaceConfigs(value: unknown): WorkspaceConfig[] {
  return Array.isArray(value) ? value.map(toWorkspaceConfig).filter((workspace): workspace is WorkspaceConfig => workspace !== null) : [];
}