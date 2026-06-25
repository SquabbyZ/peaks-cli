import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { isInsidePath, isWindowsAbsolutePath, normalizePath, resolveInputPath, stableRealPath } from '../../shared/path-utils.js';
import { containsSensitiveConfigValue, isSensitiveConfigPath } from '../config/config-service.js';
import { getSessionDir } from '../session/getSessionDir.js';
import type { ExtractedProjectMemory } from './project-memory-service.js';

function normalizeRoot(path: string): string {
  return resolveInputPath(path);
}

function normalizeRealRoot(path: string): string {
  return stableRealPath(path);
}

function realPathOrThrow(path: string, errorMessage: string): string {
  if (!existsSync(path)) {
    throw new Error(errorMessage);
  }
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) {
    throw new Error(errorMessage);
  }
  return realpathSync(path);
}

function resolveProjectPath(path: string, projectRoot: string): string {
  if (isWindowsAbsolutePath(path)) return normalizePath(path);
  if (isAbsolute(path)) return resolve(path);
  const resolvedPath = join(projectRoot, path);
  return isWindowsAbsolutePath(projectRoot) ? normalizePath(resolvedPath) : resolve(resolvedPath);
}

function assertInsideProject(path: string, projectRoot: string): string {
  const resolvedRoot = normalizeRoot(projectRoot);
  const resolvedPath = resolveProjectPath(path, resolvedRoot);
  const realProjectRoot = realPathOrThrow(resolvedRoot, 'Project root is not accessible');
  const realArtifactPath = realPathOrThrow(resolvedPath, 'Artifact path must stay inside the project root');
  if (!isInsidePath(realArtifactPath, realProjectRoot)) {
    throw new Error('Artifact path must stay inside the project root');
  }
  return resolvedPath;
}

function assertSafeProjectMemoryDir(projectRoot: string): string {
  const resolvedRoot = normalizeRoot(projectRoot);
  const realRoot = normalizeRealRoot(projectRoot);
  const peaksDir = join(resolvedRoot, '.peaks');
  if (existsSync(peaksDir) && lstatSync(peaksDir).isSymbolicLink()) {
    throw new Error('Project memory directory must stay inside the project root');
  }

  const memoryDir = join(peaksDir, 'memory');
  if (existsSync(memoryDir)) {
    if (lstatSync(memoryDir).isSymbolicLink()) {
      throw new Error('Project memory directory must stay inside the project root');
    }
    const realMemoryDir = realpathSync(memoryDir);
    if (!isInsidePath(realMemoryDir, realRoot)) {
      throw new Error('Project memory directory must stay inside the project root');
    }
    return memoryDir;
  }

  return memoryDir;
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function assertSafeSessionDir(projectRoot: string, sessionId: string): string {
  const normalizedRoot = normalizeRoot(projectRoot);
  const realRoot = normalizeRealRoot(projectRoot);
  const sessionDir = getSessionDir(normalizedRoot, sessionId);
  if (!existsSync(sessionDir)) {
    // Distinguish "not found" (caller will treat as no-op) from "escapes project
    // root" (caller must surface a hard error). We probe by checking whether the
    // joined path, after realpath, would still be inside the project root.
    if (isAbsolute(getSessionDir(normalizedRoot, sessionId))) {
      const realJoined = safeRealpath(getSessionDir(normalizedRoot, sessionId));
      if (realJoined && !isInsidePath(realJoined, realRoot)) {
        throw new Error('Session directory must stay inside the project root');
      }
    }
    throw new Error('SESSION_DIR_NOT_FOUND');
  }
  const stats = lstatSync(sessionDir);
  if (stats.isSymbolicLink()) {
    throw new Error('Session directory must stay inside the project root');
  }
  const realSessionDir = realpathSync(sessionDir);
  if (!isInsidePath(realSessionDir, realRoot)) {
    throw new Error('Session directory must stay inside the project root');
  }
  return sessionDir;
}

function hasSensitiveMemoryContent(content: string): boolean {
  return /(?:api[_-]?key|token|secret|password|credential|bearer)\s*[:=]/i.test(content)
    || /\bauthorization\s*:\s*bearer\s+\S+/i.test(content)
    || /\bbearer\s+[A-Za-z0-9._~+/=-]{12,}\b/i.test(content)
    || /\bsk-[A-Za-z0-9_-]{6,}\b/.test(content)
    || /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/.test(content)
    || /\bgithub_pat_[A-Za-z0-9_]{20,}\b/.test(content)
    || /\bglpat-[A-Za-z0-9_-]{20,}\b/.test(content)
    || /\bAKIA[0-9A-Z]{16}\b/.test(content)
    || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content)
    || /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(content);
}

function assertSafeMemory(memory: ExtractedProjectMemory): void {
  const content = `${memory.title}\n${memory.kind}\n${memory.body}`;
  const metadata = { title: memory.title, kind: memory.kind, body: memory.body };
  if (containsSensitiveConfigValue(metadata) || hasSensitiveMemoryContent(content)) {
    throw new Error('Refusing to store sensitive memory content');
  }
  if (isSensitiveConfigPath(memory.title)) {
    throw new Error('Refusing to store sensitive memory content');
  }
}

function assertSafeMemoryFileContent(content: string): void {
  if (hasSensitiveMemoryContent(content)) {
    throw new Error('Refusing to back up sensitive memory content');
  }
}

export {
  normalizeRoot,
  normalizeRealRoot,
  realPathOrThrow,
  resolveProjectPath,
  assertInsideProject,
  assertSafeProjectMemoryDir,
  assertSafeSessionDir,
  safeRealpath,
  hasSensitiveMemoryContent,
  assertSafeMemory,
  assertSafeMemoryFileContent
};