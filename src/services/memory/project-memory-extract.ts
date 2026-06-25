import { closeSync, constants, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { isInsidePath, resolveInputPath, stablePath, stableRealPath } from '../../shared/path-utils.js';
import {
  assertInsideProject,
  assertSafeMemory,
  assertSafeMemoryFileContent,
  assertSafeProjectMemoryDir,
  normalizeRoot,
  realPathOrThrow
} from './project-memory-safety.js';
import type {
  ExtractedProjectMemory,
  ProjectMemoryBackupPlan,
  ProjectMemoryBackupResult,
  ProjectMemoryBackupSummary,
  ProjectMemoryExtractPlan,
  ProjectMemoryExtractResult,
  ProjectMemoryExtractSummary,
  ProjectMemoryKind,
  StoredProjectMemory
} from './project-memory-service.js';
import {
  emptyByKind,
  generateMemoryIndexFile,
  parseStoredMemoryFile,
  readStoredMemoryNames
} from './project-memory-index.js';

type ExtractPlanOptions = {
  projectRoot: string;
  artifactPaths: string[];
  apply?: boolean;
};

type BackupPlanOptions = {
  projectRoot: string;
  artifactWorkspacePath: string;
  apply?: boolean;
};

const START_MARKER = '<!-- peaks-memory:start -->';
const END_MARKER = '<!-- peaks-memory:end -->';
const VALID_MEMORY_KINDS = new Set<ProjectMemoryKind>(['project', 'rule', 'decision', 'reference', 'feedback', 'convention', 'module', 'lesson']);

function slugify(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'project-memory';
}

function parseBlock(block: string, sourceArtifact: string): ExtractedProjectMemory | null {
  const normalizedBlock = block.replace(/\r\n/g, '\n');
  const separatorIndex = normalizedBlock.indexOf('\n---\n');
  if (separatorIndex < 0) return null;

  const header = normalizedBlock.slice(0, separatorIndex).trim();
  const body = normalizedBlock.slice(separatorIndex + '\n---\n'.length).trim();
  const fields = new Map<string, string>();

  for (const line of header.split('\n')) {
    const [key, ...valueParts] = line.split(':');
    const normalizedKey = key?.trim();
    const value = valueParts.join(':').trim();
    if (normalizedKey && value) {
      fields.set(normalizedKey, value);
    }
  }

  const title = fields.get('title')?.trim();
  const kind = fields.get('kind')?.trim() as ProjectMemoryKind | undefined;
  if (!title || !kind || !VALID_MEMORY_KINDS.has(kind) || body.length === 0) return null;

  return { title, kind, body, sourceArtifact };
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

function writeNewFile(path: string, content: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeFileSync(fd, content, 'utf8');
  } finally {
    closeSync(fd);
  }
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

function listStoredMemories(memoryDir: string): StoredProjectMemory[] {
  const memories: StoredProjectMemory[] = [];
  for (const filePath of listMarkdownFiles(memoryDir)) {
    const parsed = parseStoredMemoryFile(readFileSync(filePath, 'utf8'), filePath);
    if (parsed) memories.push(parsed);
  }
  memories.sort((left, right) => left.name.localeCompare(right.name));
  return memories;
}

export function extractStableProjectMemories(content: string, sourceArtifact: string): ExtractedProjectMemory[] {
  const memories: ExtractedProjectMemory[] = [];
  let searchStart = 0;

  while (searchStart < content.length) {
    const start = content.indexOf(START_MARKER, searchStart);
    if (start < 0) break;
    const bodyStart = start + START_MARKER.length;
    const end = content.indexOf(END_MARKER, bodyStart);
    if (end < 0) break;

    const memory = parseBlock(content.slice(bodyStart, end).trim(), sourceArtifact);
    if (memory) {
      assertSafeMemory(memory);
      memories.push(memory);
    }
    searchStart = end + END_MARKER.length;
  }

  return memories.sort((left, right) => slugify(left.title).localeCompare(slugify(right.title)));
}

function summarizeExtractResult(result: ProjectMemoryExtractResult): ProjectMemoryExtractSummary {
  return {
    apply: result.apply,
    projectRoot: result.projectRoot,
    primaryMemoryDir: result.primaryMemoryDir,
    backupPolicy: result.backupPolicy,
    extractedCount: result.extractedMemories.length,
    plannedWrites: result.plannedWrites.map((write) => ({
      filePath: write.filePath,
      title: write.memory.title,
      kind: write.memory.kind,
      sourceArtifact: write.memory.sourceArtifact
    })),
    writtenFiles: result.writtenFiles
  };
}

function summarizeBackupResult(result: ProjectMemoryBackupResult): ProjectMemoryBackupSummary {
  return {
    apply: result.apply,
    projectRoot: result.projectRoot,
    artifactWorkspacePath: result.artifactWorkspacePath,
    primaryMemoryDir: result.primaryMemoryDir,
    backupMemoryDir: result.backupMemoryDir,
    plannedCopies: result.plannedCopies,
    copiedFiles: result.copiedFiles
  };
}

export function createProjectMemoryExtractPlan(options: ExtractPlanOptions): ProjectMemoryExtractPlan {
  const projectRoot = normalizeRoot(options.projectRoot);
  const primaryMemoryDir = assertSafeProjectMemoryDir(projectRoot);
  const extractedMemories = options.artifactPaths.flatMap((artifactPath) => {
    const safeArtifactPath = assertInsideProject(artifactPath, projectRoot);
    const relativeArtifactPath = relative(projectRoot, safeArtifactPath).replaceAll('\\', '/');
    return extractStableProjectMemories(readFileSync(safeArtifactPath, 'utf8'), relativeArtifactPath);
  }).sort((left, right) => slugify(left.title).localeCompare(slugify(right.title)));

  const slugCounts = new Map<string, number>();
  for (const memory of extractedMemories) {
    const slug = slugify(memory.title);
    slugCounts.set(slug, (slugCounts.get(slug) ?? 0) + 1);
  }
  const duplicateTitles = [...slugCounts.entries()].filter(([, count]) => count > 1).map(([slug]) => slug);
  if (duplicateTitles.length > 0) {
    throw new Error(`Duplicate memory titles are not allowed: ${duplicateTitles.join(', ')}`);
  }

  const plannedWrites = extractedMemories.map((memory) => ({
    memory,
    filePath: join(primaryMemoryDir, `${slugify(memory.title)}.md`),
    content: renderMemoryFile(memory)
  }));

  return {
    apply: options.apply ?? false,
    projectRoot,
    primaryMemoryDir,
    backupPolicy: 'project-memory-primary-artifact-backup',
    extractedMemories,
    plannedWrites
  };
}

export function executeProjectMemoryExtract(options: ExtractPlanOptions): ProjectMemoryExtractResult {
  const plan = createProjectMemoryExtractPlan(options);
  const writtenFiles: string[] = [];

  if (plan.apply) {
    mkdirSync(plan.primaryMemoryDir, { recursive: true });
    const safeMemoryDir = assertSafeProjectMemoryDir(plan.projectRoot);
    // Idempotency: skip writes for memories whose slug already lives in
    // .peaks/memory/. Re-running `peaks memory extract --apply` on the
    // same handoff is a normal peaks-solo / peaks-txt retry pattern (the
    // skill prompt may invoke extract more than once when a handoff is
    // edited and re-extracted). Without this, writeNewFile's O_EXCL
    // throws EEXIST and aborts the whole batch. Symmetric with
    // extractSessionMemories (line ~614) which does the same skip.
    const existingNames = readStoredMemoryNames(plan.primaryMemoryDir, listMarkdownFiles);
    for (const write of plan.plannedWrites) {
      const slug = slugify(write.memory.title);
      if (existingNames.has(slug)) continue;

      const targetPath = resolveInputPath(write.filePath);
      const stableTargetPath = stablePath(targetPath);
      if (!isInsidePath(stableTargetPath, stableRealPath(safeMemoryDir))) {
        throw new Error('Project memory write target must stay inside the project memory directory');
      }
      writeNewFile(targetPath, write.content);
      writtenFiles.push(targetPath);
    }

    // After writing any markdown, regenerate the index so downstream
    // readers (peaks project memory-index, peaks-txt re-runs, the next
    // session's presence-set bootstrap) see the new memory. Without
    // this, `peaks memory extract --apply` would leave the index stale
    // and `readMemoryIndex` would either return the empty bootstrap or
    // — pre-bootstrap-fix — return null. Symmetric with
    // extractSessionMemories, which already regenerates the index on
    // apply (see line ~626). We regen whenever --apply is set, even
    // if every write was skipped by idempotency, so the index is
    // always rebuilt against the current .peaks/memory/ directory.
    const memoriesForIndex = listStoredMemories(plan.primaryMemoryDir);
    const indexPath = join(plan.primaryMemoryDir, 'index.json');
    generateMemoryIndexFile(memoriesForIndex, plan.primaryMemoryDir, indexPath);
  }

  return { ...plan, writtenFiles };
}

export function createProjectMemoryBackupPlan(options: BackupPlanOptions): ProjectMemoryBackupPlan {
  const projectRoot = normalizeRoot(options.projectRoot);
  const artifactWorkspacePath = normalizeRoot(options.artifactWorkspacePath);
  if (isInsidePath(artifactWorkspacePath, projectRoot)) {
    throw new Error('Artifact workspace must be outside the project root');
  }

  const primaryMemoryDir = assertSafeProjectMemoryDir(projectRoot);
  const backupMemoryDir = join(artifactWorkspacePath, '.peaks', 'memory-backups', 'project-memory-primary');
  const plannedCopies = listMarkdownFiles(primaryMemoryDir).map((sourcePath) => {
    assertSafeMemoryFileContent(readFileSync(sourcePath, 'utf8'));
    const relativeMemoryPath = relative(primaryMemoryDir, sourcePath);
    return {
      sourcePath,
      targetPath: join(backupMemoryDir, relativeMemoryPath)
    };
  });

  return {
    apply: options.apply ?? false,
    projectRoot,
    artifactWorkspacePath,
    primaryMemoryDir,
    backupMemoryDir,
    plannedCopies
  };
}

export function executeProjectMemoryBackup(options: BackupPlanOptions): ProjectMemoryBackupResult {
  const plan = createProjectMemoryBackupPlan(options);
  const copiedFiles: string[] = [];

  if (plan.apply) {
    const safeMemoryDir = assertSafeProjectMemoryDir(plan.projectRoot);
    mkdirSync(plan.backupMemoryDir, { recursive: true });
    for (const copy of plan.plannedCopies) {
      const sourcePath = realPathOrThrow(copy.sourcePath, 'Project memory source must stay inside the project memory directory');
      if (!isInsidePath(sourcePath, stableRealPath(safeMemoryDir))) {
        throw new Error('Project memory source must stay inside the project memory directory');
      }
      mkdirSync(dirname(copy.targetPath), { recursive: true });
      copyFileSync(sourcePath, copy.targetPath);
      copiedFiles.push(copy.targetPath);
    }
  }

  return { ...plan, copiedFiles };
}

export function summarizeProjectMemoryExtractResult(result: ProjectMemoryExtractResult): ProjectMemoryExtractSummary {
  return summarizeExtractResult(result);
}

export function summarizeProjectMemoryBackupResult(result: ProjectMemoryBackupResult): ProjectMemoryBackupSummary {
  return summarizeBackupResult(result);
}

export {
  summarizeExtractResult,
  summarizeBackupResult,
  emptyByKind
};