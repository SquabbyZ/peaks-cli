import { closeSync, constants, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { isInsidePath, resolveInputPath, stablePath, stableRealPath } from '../../shared/path-utils.js';
import {
  assertSafeProjectMemoryDir,
  assertSafeSessionDir,
  normalizeRoot
} from './project-memory-safety.js';
import {
  emptyByKind,
  generateMemoryIndexFile,
  parseStoredMemoryFile,
  readMemoryFileMtime,
  readMemoryIndex,
  readStoredMemoryNames,
  renderEmptyIndex
} from './project-memory-index.js';
import type { MemoryIndex, MemoryIndexEntry, StoredProjectMemory } from './project-memory-index.js';
import {
  createProjectMemoryBackupPlan,
  createProjectMemoryExtractPlan,
  executeProjectMemoryBackup,
  executeProjectMemoryExtract,
  extractStableProjectMemories,
  summarizeProjectMemoryBackupResult,
  summarizeProjectMemoryExtractResult
} from './project-memory-extract.js';

export type ProjectMemoryKind = 'project' | 'rule' | 'decision' | 'reference' | 'feedback' | 'convention' | 'module' | 'lesson';

export type ExtractedProjectMemory = {
  title: string;
  kind: ProjectMemoryKind;
  body: string;
  sourceArtifact: string;
};

export type ProjectMemoryWrite = {
  memory: ExtractedProjectMemory;
  filePath: string;
  content: string;
};

export type ProjectMemoryExtractPlan = {
  apply: boolean;
  projectRoot: string;
  primaryMemoryDir: string;
  backupPolicy: 'project-memory-primary-artifact-backup';
  extractedMemories: ExtractedProjectMemory[];
  plannedWrites: ProjectMemoryWrite[];
};

export type ProjectMemoryExtractResult = ProjectMemoryExtractPlan & {
  writtenFiles: string[];
};

export type ProjectMemoryExtractSummary = {
  apply: boolean;
  projectRoot: string;
  primaryMemoryDir: string;
  backupPolicy: 'project-memory-primary-artifact-backup';
  extractedCount: number;
  plannedWrites: Array<{
    filePath: string;
    title: string;
    kind: ProjectMemoryKind;
    sourceArtifact: string;
  }>;
  writtenFiles: string[];
};

export type ProjectMemoryBackupSummary = {
  apply: boolean;
  projectRoot: string;
  artifactWorkspacePath: string;
  primaryMemoryDir: string;
  backupMemoryDir: string;
  plannedCopies: ProjectMemoryCopy[];
  copiedFiles: string[];
};

export type ProjectMemoryCopy = {
  sourcePath: string;
  targetPath: string;
};

export type ProjectMemoryBackupPlan = {
  apply: boolean;
  projectRoot: string;
  artifactWorkspacePath: string;
  primaryMemoryDir: string;
  backupMemoryDir: string;
  plannedCopies: ProjectMemoryCopy[];
};

export type ProjectMemoryBackupResult = ProjectMemoryBackupPlan & {
  copiedFiles: string[];
};

export type ProjectMemoryReadResult = {
  projectRoot: string;
  memoryDir: string;
  total: number;
  byKind: Record<ProjectMemoryKind, StoredProjectMemory[]>;
  memories: StoredProjectMemory[];
};

export type ExtractSessionMemoriesOptions = {
  projectRoot: string;
  sessionId: string;
  apply?: boolean;
};

export type ExtractSessionMemoriesResult = {
  apply: boolean;
  projectRoot: string;
  sessionId: string;
  primaryMemoryDir: string;
  memoryIndexPath: string;
  scannedFiles: number;
  extractedCount: number;
  writtenFiles: string[];
  updatedIndex: boolean;
};

function slugify(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'project-memory';
}

function writeNewFile(path: string, content: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeFileSync(fd, content, 'utf8');
  } finally {
    closeSync(fd);
  }
}

function renderMemoryFile(memory: ExtractedProjectMemory): string {
  const name = slugify(memory.title);
  return [
    '---',
    `name: ${name}`,
    `description: ${memory.title}`,
    'metadata:',
    `  type: ${memory.kind}`,
    `  sourceArtifact: ${memory.sourceArtifact}`,
    '---',
    '',
    memory.body,
    ''
  ].join('\n');
}

function listMarkdownFiles(dirPath: string, options: { maxDepth?: number; skipDotfiles?: boolean } = {}): string[] {
  if (!existsSync(dirPath)) return [];

  const { maxDepth = Infinity, skipDotfiles = true } = options;
  const files: string[] = [];
  const stack: Array<{ path: string; depth: number }> = [{ path: dirPath, depth: 0 }];

  while (stack.length > 0) {
    const frame = stack.pop() as { path: string; depth: number };
    if (frame.depth > maxDepth) continue;
    for (const entry of readdirSync(frame.path, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (skipDotfiles && entry.name.startsWith('.')) continue;
      const entryPath = join(frame.path, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        stack.push({ path: entryPath, depth: frame.depth + 1 });
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(entryPath);
      }
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

export function extractSessionMemories(options: ExtractSessionMemoriesOptions): ExtractSessionMemoriesResult {
  const projectRoot = normalizeRoot(options.projectRoot);
  const apply = options.apply ?? false;
  const primaryMemoryDir = assertSafeProjectMemoryDir(projectRoot);
  const memoryIndexPath = join(primaryMemoryDir, 'index.json');

  // Resolve sessionDir through realpath + inside-project guard so a hostile
  // sessionId (`..`, abs path, symlink chain) cannot walk the scanner outside
  // the project root. A sentinel "SESSION_DIR_NOT_FOUND" distinguishes a
  // benign miss from an escape attempt.
  let sessionDir: string;
  try {
    sessionDir = assertSafeSessionDir(projectRoot, options.sessionId);
  } catch (error) {
    if (error instanceof Error && error.message === 'SESSION_DIR_NOT_FOUND') {
      return {
        apply,
        projectRoot,
        sessionId: options.sessionId,
        primaryMemoryDir,
        memoryIndexPath,
        scannedFiles: 0,
        extractedCount: 0,
        writtenFiles: [],
        updatedIndex: false
      };
    }
    throw error;
  }
  const scannedFiles = listMarkdownFiles(sessionDir, { maxDepth: 6, skipDotfiles: true });

  const allExtracted: ExtractedProjectMemory[] = [];
  for (const filePath of scannedFiles) {
    try {
      const content = readFileSync(filePath, 'utf8');
      const relativePath = relative(projectRoot, filePath).replaceAll('\\', '/');
      const extracted = extractStableProjectMemories(content, relativePath);
      allExtracted.push(...extracted);
    } catch {
      // skip unreadable files
    }
  }

  if (allExtracted.length === 0) {
    return {
      apply,
      projectRoot,
      sessionId: options.sessionId,
      primaryMemoryDir,
      memoryIndexPath,
      scannedFiles: scannedFiles.length,
      extractedCount: 0,
      writtenFiles: [],
      updatedIndex: false
    };
  }

  const slugCounts = new Map<string, number>();
  for (const memory of allExtracted) {
    const slug = slugify(memory.title);
    slugCounts.set(slug, (slugCounts.get(slug) ?? 0) + 1);
  }
  const duplicateTitles = [...slugCounts.entries()].filter(([, count]) => count > 1).map(([slug]) => slug);
  if (duplicateTitles.length > 0) {
    throw new Error(`Duplicate memory titles are not allowed: ${duplicateTitles.join(', ')}`);
  }

  // Idempotency: pre-read existing memory names so a re-run of the same
  // session does not throw EEXIST. `writtenFiles` reports only the new
  // writes so callers can still tell what the run actually produced.
  const existingNames = apply ? readStoredMemoryNames(primaryMemoryDir, listMarkdownFiles) : new Set<string>();
  const writtenFiles: string[] = [];
  if (apply) {
    mkdirSync(primaryMemoryDir, { recursive: true });

    for (const memory of allExtracted) {
      const slug = slugify(memory.title);
      if (existingNames.has(slug)) continue;

      const targetPath = join(primaryMemoryDir, `${slug}.md`);
      const safePath = resolveInputPath(targetPath);
      const stableSafePath = stablePath(safePath);
      if (!isInsidePath(stableSafePath, stableRealPath(primaryMemoryDir))) {
        throw new Error('Project memory write target must stay inside the project memory directory');
      }
      writeNewFile(safePath, renderMemoryFile(memory));
      writtenFiles.push(safePath);
    }

    // Regenerate index after writes
    const memoriesForIndex: StoredProjectMemory[] = [];
    for (const filePath of listMarkdownFiles(primaryMemoryDir)) {
      const parsed = parseStoredMemoryFile(readFileSync(filePath, 'utf8'), filePath);
      if (parsed) memoriesForIndex.push(parsed);
    }
    memoriesForIndex.sort((left, right) => left.name.localeCompare(right.name));
    generateMemoryIndexFile(memoriesForIndex, primaryMemoryDir, memoryIndexPath);
  }

  return {
    apply,
    projectRoot,
    sessionId: options.sessionId,
    primaryMemoryDir,
    memoryIndexPath,
    scannedFiles: scannedFiles.length,
    extractedCount: allExtracted.length,
    writtenFiles,
    updatedIndex: apply && writtenFiles.length > 0
  };
}

/**
 * Ensure `.peaks/memory/` and its `index.json` exist for a project, with
 * the same full-shape empty index the generator emits when there are zero
 * memories. Idempotent — safe to call on every skill activation.
 *
 * Why this exists: before this helper, `.peaks/memory/` was only created
 * by `extractSessionMemories` when at least one memory markdown was being
 * written, and `index.json` was only emitted by the generator when at
 * least one markdown was on disk. Stock projects therefore had no
 * `.peaks/memory/` directory and no index, even after `peaks project
 * memories` was read. Bootstrap closes that cold-start gap.
 *
 * This function is fail-open for the same reason the rest of the
 * presence layer is fail-open: a failure here must NOT block skill
 * activation. Any error is swallowed and surfaced only via the returned
 * boolean. Callers that need the truth should check the result.
 */
export function ensureMemoryBootstrap(projectRoot: string): boolean {
  try {
    const normalizedRoot = normalizeRoot(projectRoot);
    const memoryDir = assertSafeProjectMemoryDir(normalizedRoot);
    const indexPath = join(memoryDir, 'index.json');

    mkdirSync(memoryDir, { recursive: true });

    if (!existsSync(indexPath)) {
      writeFileSync(indexPath, renderEmptyIndex(), { mode: 0o644 });
    }
    return true;
  } catch {
    return false;
  }
}

export function readProjectMemories(projectRoot: string): ProjectMemoryReadResult {
  const normalizedRoot = normalizeRoot(projectRoot);
  const memoryDir = assertSafeProjectMemoryDir(normalizedRoot);

  // Read-side bootstrap: on a stock project the directory does not exist
  // yet. Reading must not return an error, but we also want the directory
  // to materialise (along with a full-shape empty index) so subsequent
  // `peaks project memories` invocations, `readMemoryIndex`, and any
  // extraction call find a stable target. The helper is fail-open.
  if (!existsSync(memoryDir)) {
    ensureMemoryBootstrap(normalizedRoot);
  }

  const memories: StoredProjectMemory[] = [];
  for (const filePath of listMarkdownFiles(memoryDir)) {
    const parsed = parseStoredMemoryFile(readFileSync(filePath, 'utf8'), filePath);
    if (parsed) memories.push(parsed);
  }
  memories.sort((left, right) => left.name.localeCompare(right.name));

  const byKind = emptyByKind();
  for (const memory of memories) {
    byKind[memory.kind].push(memory);
  }

  return {
    projectRoot: normalizedRoot,
    memoryDir,
    total: memories.length,
    byKind,
    memories
  };
}

export interface ProjectMemoryShowResult {
  projectRoot: string;
  memoryDir: string;
  name: string;
  body: string;
  filePath: string;
  updatedAt: string | null;
  kind: ProjectMemoryKind | null;
  title: string;
  /** Whether the on-disk body bytes are returned (true) or a compact form (false). */
  pretty: boolean;
}

/**
 * Read a single project memory's full body by name. Returns null when
 * the memory does not exist. The on-disk body is returned verbatim
 * (pretty). The CLI layer applies `formatMdCompact` when `format: 'compact'`
 * is requested. Slice 023 (R3).
 */
export function readProjectMemoryBody(projectRoot: string, name: string): ProjectMemoryShowResult | null {
  const normalizedRoot = normalizeRoot(projectRoot);
  const memoryDir = assertSafeProjectMemoryDir(normalizedRoot);
  if (!existsSync(memoryDir)) {
    ensureMemoryBootstrap(normalizedRoot);
  }
  for (const filePath of listMarkdownFiles(memoryDir)) {
    if (basename(filePath, '.md') !== name) continue;
    const parsed = parseStoredMemoryFile(readFileSync(filePath, 'utf8'), filePath);
    if (parsed === null) continue;
    const updatedAt = readMemoryFileMtime(filePath);
    return {
      projectRoot: normalizedRoot,
      memoryDir,
      name: parsed.name,
      body: parsed.body,
      filePath,
      updatedAt,
      kind: parsed.kind,
      title: parsed.title,
      pretty: true
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Re-exports for public API preservation (load-bearing contract).
// All symbols formerly defined in this file are now in sibling modules.
// Existing import paths resolve unchanged.
// ---------------------------------------------------------------------------

export {
  extractStableProjectMemories,
  createProjectMemoryExtractPlan,
  executeProjectMemoryExtract,
  createProjectMemoryBackupPlan,
  executeProjectMemoryBackup,
  summarizeProjectMemoryExtractResult,
  summarizeProjectMemoryBackupResult
} from './project-memory-extract.js';

export type { MemoryIndex, MemoryIndexEntry, StoredProjectMemory } from './project-memory-index.js';

export { readMemoryIndex } from './project-memory-index.js';