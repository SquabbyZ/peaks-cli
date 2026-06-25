import { closeSync, constants, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { assertSafeProjectMemoryDir, normalizeRoot } from './project-memory-safety.js';
import type { ProjectMemoryKind } from './project-memory-service.js';

// Length bounds for index entry descriptions. The numbers were chosen when
// summarizeMemoryBody was first introduced; locking them in as named
// constants is a doc-as-code move so the truncation rule is no longer
// "magic". Bump MAX_DESCRIPTION_LENGTH deliberately if downstream UIs grow.
const MIN_BODY_SENTENCE_LENGTH = 20;   // skip fragments shorter than this when picking a leading sentence
const MAX_DESCRIPTION_LENGTH = 120;    // hard cap on description length in the memory index entry
const ELLIPSIS_RESERVE = 3;             // length of the trailing "..." when truncating with an ellipsis

export type MemoryIndexEntry = {
  name: string;
  kind: ProjectMemoryKind;
  description: string;
  sourcePath: string;
  sourceArtifact: string | null;
  updatedAt: string;
};

export type MemoryIndex = {
  version: 1;
  updatedAt: string;
  hot: Record<ProjectMemoryKind, MemoryIndexEntry[]>;
  warm: Record<ProjectMemoryKind, MemoryIndexEntry[]>;
};

export type StoredProjectMemory = {
  name: string;
  title: string;
  kind: ProjectMemoryKind;
  sourceArtifact: string | null;
  body: string;
  filePath: string;
};

const VALID_MEMORY_KINDS = new Set<ProjectMemoryKind>(['project', 'rule', 'decision', 'reference', 'feedback', 'convention', 'module', 'lesson']);

// Hot kinds: full body kept in index for always-available context
const HOT_KINDS = new Set<ProjectMemoryKind>(['feedback', 'decision', 'rule', 'convention', 'module', 'lesson']);

function summarizeMemoryBody(body: string): string {
  const cleaned = body
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/`{1,3}[^`]*`{1,3}/g, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\n+/g, ' ')
    .trim();

  const sentences = cleaned.split(/(?<=[.!?])\s+/).filter(
    (s) => s.length > MIN_BODY_SENTENCE_LENGTH && !/^\[.+\]$/.test(s)
  );
  if (sentences.length === 0) {
    return cleaned.slice(0, MAX_DESCRIPTION_LENGTH) || 'Project memory';
  }

  const first = sentences[0]!;
  if (first.length <= MAX_DESCRIPTION_LENGTH) {
    return first;
  }
  return first.slice(0, MAX_DESCRIPTION_LENGTH - ELLIPSIS_RESERVE) + '...';
}

function readMemoryFileMtime(filePath: string): string {
  try {
    return statSync(filePath).mtime.toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function emptyIndex(): MemoryIndex {
  // Cast through unknown: we *intend* the two halves to together cover the
  // union `ProjectMemoryKind`, but TS does not know that. The `MemoryIndex`
  // type's `hot` / `warm` fields together cover the union; we split the
  // construction so the JSON output mirrors the hot/warm layout the reader
  // expects.
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    hot: {
      feedback: [],
      decision: [],
      rule: [],
      convention: [],
      module: [],
      lesson: []
    } as unknown as Record<ProjectMemoryKind, MemoryIndexEntry[]>,
    warm: {
      project: [],
      reference: []
    } as unknown as Record<ProjectMemoryKind, MemoryIndexEntry[]>
  };
}

function renderEmptyIndex(): string {
  return JSON.stringify(emptyIndex(), null, 2) + '\n';
}

function readExistingIndex(indexPath: string): MemoryIndex | null {
  if (!existsSync(indexPath)) return null;
  try {
    const raw = readFileSync(indexPath, 'utf8');
    const parsed = JSON.parse(raw) as MemoryIndex;
    if (parsed.version === 1) return parsed;
    return null;
  } catch {
    return null;
  }
}

// Decide whether readMemoryIndex should rebuild the on-disk index.json.
// The rule is: rebuild iff index.json is missing OR any memory.md has an
// mtime strictly greater than index.json's mtime. Any statSync failure
// falls back to "rebuild" — a safe default that matches the prior
// always-rebuild behaviour and avoids serving a stale index from a
// partially-corrupt dir.
function shouldRegenerateIndex(indexPath: string, memoryFiles: string[]): boolean {
  let indexMtimeMs = 0;
  try {
    indexMtimeMs = statSync(indexPath).mtimeMs;
  } catch {
    return true; // no index → must regenerate
  }
  for (const memoryPath of memoryFiles) {
    try {
      const memoryMtimeMs = statSync(memoryPath).mtimeMs;
      if (memoryMtimeMs > indexMtimeMs) return true;
    } catch {
      return true; // unreadable file → safe default is regenerate
    }
  }
  return false;
}

function readStoredMemoryNames(memoryDir: string, listMarkdownFiles: (dir: string, options?: { maxDepth?: number; skipDotfiles?: boolean }) => string[]): Set<string> {
  // Two source-of-truth fallbacks for the slug-collision check:
  //   1. Parse frontmatter (the canonical form rendered by
  //      renderMemoryFile / written by both extract paths).
  //   2. Fall back to the bare filename stem, so user-dropped files
  //      without frontmatter (e.g. hand-written memories, legacy
  //      content) still count as a collision and are not overwritten
  //      by an idempotent re-extract.
  const names = new Set<string>();
  for (const filePath of listMarkdownFiles(memoryDir)) {
    const stem = basename(filePath, '.md');
    if (stem.length > 0 && stem !== 'index') names.add(stem);
    try {
      const parsed = parseStoredMemoryFile(readFileSync(filePath, 'utf8'), filePath);
      if (parsed) names.add(parsed.name);
    } catch {
      // ignore unreadable files
    }
  }
  return names;
}

function parseStoredMemoryFile(content: string, filePath: string): StoredProjectMemory | null {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return null;
  const endIndex = normalized.indexOf('\n---\n', 4);
  if (endIndex < 0) return null;

  const frontmatter = normalized.slice(4, endIndex);
  const body = normalized.slice(endIndex + '\n---\n'.length).trim();

  let name: string | undefined;
  let description: string | undefined;
  let kind: string | undefined;
  let sourceArtifact: string | undefined;

  for (const rawLine of frontmatter.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('name:')) name = line.slice('name:'.length).trim();
    else if (line.startsWith('description:')) description = line.slice('description:'.length).trim();
    else if (line.startsWith('type:')) kind = line.slice('type:'.length).trim();
    else if (line.startsWith('sourceArtifact:')) sourceArtifact = line.slice('sourceArtifact:'.length).trim();
  }

  if (!name || !kind || !VALID_MEMORY_KINDS.has(kind as ProjectMemoryKind) || body.length === 0) return null;

  return {
    name,
    title: description ?? name,
    kind: kind as ProjectMemoryKind,
    sourceArtifact: sourceArtifact && sourceArtifact !== 'undefined' ? sourceArtifact : null,
    body,
    filePath
  };
}

function emptyByKind(): Record<ProjectMemoryKind, StoredProjectMemory[]> {
  return {
    project: [],
    rule: [],
    decision: [],
    reference: [],
    feedback: [],
    convention: [],
    module: [],
    lesson: []
  };
}

function ensureMemoryDirAndIndex(normalizedRoot: string, memoryDir: string, indexPath: string): void {
  if (existsSync(memoryDir)) return;
  mkdirSync(memoryDir, { recursive: true });
  if (!existsSync(indexPath)) {
    writeFileSync(indexPath, renderEmptyIndex(), { mode: 0o644 });
  }
}

export function readMemoryIndex(projectRoot: string): MemoryIndex | null {
  const normalizedRoot = normalizeRoot(projectRoot);
  const memoryDir = assertSafeProjectMemoryDir(normalizedRoot);
  const indexPath = join(memoryDir, 'index.json');

  // Read-side bootstrap: if the memory dir is missing entirely, build it and
  // return whatever index is on disk (likely null on a fresh project). We
  // deliberately do NOT pre-write an empty index here: the mtime-based
  // regeneration guard below is the sole authority on whether index.json
  // gets materialised, and pre-writing an empty index would race the guard
  // (giving it a current-time mtime that defeats "memory older than index"
  // detection on the first read).
  if (!existsSync(memoryDir)) {
    ensureMemoryDirAndIndex(normalizedRoot, memoryDir, indexPath);
    return readExistingIndex(indexPath);
  }

  const files = listMarkdownFilesLocal(memoryDir);
  if (files.length > 0 && shouldRegenerateIndex(indexPath, files)) {
    try {
      const memories: StoredProjectMemory[] = [];
      for (const filePath of files) {
        const parsed = parseStoredMemoryFile(readFileSync(filePath, 'utf8'), filePath);
        if (parsed) memories.push(parsed);
      }
      memories.sort((left, right) => left.name.localeCompare(right.name));
      generateMemoryIndexFile(memories, memoryDir, indexPath);
    } catch {
      // fall through to read existing
    }
  }

  return readExistingIndex(indexPath);
}

function listMarkdownFilesLocal(dirPath: string): string[] {
  if (!existsSync(dirPath)) return [];
  const files: string[] = [];
  const stack: Array<{ path: string; depth: number }> = [{ path: dirPath, depth: 0 }];

  while (stack.length > 0) {
    const frame = stack.pop() as { path: string; depth: number };
    for (const entry of readdirSync(frame.path, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith('.')) continue;
      const entryPath = join(frame.path, entry.name);
      if (entry.isSymbolicLink()) continue;
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

function generateMemoryIndexFile(
  memories: StoredProjectMemory[],
  memoryDir: string,
  indexPath: string
): void {
  const hot: Record<string, MemoryIndexEntry[]> = {
    feedback: [], decision: [], rule: [], convention: [], module: [], lesson: []
  };
  const warm: Record<string, MemoryIndexEntry[]> = {
    project: [], reference: []
  };

  for (const memory of memories) {
    const entry: MemoryIndexEntry = {
      name: memory.name,
      kind: memory.kind,
      description: memory.body ? summarizeMemoryBody(memory.body) : memory.title,
      sourcePath: memory.filePath,
      sourceArtifact: memory.sourceArtifact,
      updatedAt: readMemoryFileMtime(memory.filePath)
    };

    if (HOT_KINDS.has(memory.kind)) {
      hot[memory.kind]!.push(entry);
    } else {
      warm[memory.kind]!.push(entry);
    }
  }

  for (const kind of [...Object.keys(hot), ...Object.keys(warm)]) {
    const arr = hot[kind as keyof typeof hot] ?? warm[kind as keyof typeof warm];
    if (arr) arr.sort((a, b) => a.name.localeCompare(b.name));
  }

  const index: MemoryIndex = {
    version: 1,
    updatedAt: new Date().toISOString(),
    hot: hot as Record<ProjectMemoryKind, MemoryIndexEntry[]>,
    warm: warm as Record<ProjectMemoryKind, MemoryIndexEntry[]>
  };

  const fd = openSync(indexPath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o644);
  try {
    writeFileSync(fd, JSON.stringify(index, null, 2), 'utf8');
  } finally {
    closeSync(fd);
  }
}

export {
  generateMemoryIndexFile,
  readExistingIndex,
  shouldRegenerateIndex,
  readStoredMemoryNames,
  readMemoryFileMtime,
  emptyIndex,
  renderEmptyIndex,
  summarizeMemoryBody,
  parseStoredMemoryFile,
  emptyByKind
};