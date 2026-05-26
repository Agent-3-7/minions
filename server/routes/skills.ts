import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, mkdirSync } from 'node:fs';
import { access, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import multer from 'multer';
import yauzl from 'yauzl';
import { parseDocument } from 'yaml';
import { Router, type Request, type Response } from 'express';
import type { ClawHubSkillSummary, ClawHubStats, SkillMeta } from '../../shared/types.js';
import { resolveHermesHome, resolveAgentControlSkillsDir } from '../paths.js';

const CLAWHUB_API_BASE = 'https://clawhub.ai/api/v1';
const SIDECAR_FILENAME = '.agentcontrol-skill.json';
const MAX_SKILL_FILES = 250;
const MAX_SKILL_FILE_BYTES = 5 * 1024 * 1024;
const MAX_SKILL_TOTAL_BYTES = 25 * 1024 * 1024;
const SKILL_IMPORT_TMP_DIR = join(tmpdir(), 'agentcontrol-skill-imports');

mkdirSync(SKILL_IMPORT_TMP_DIR, { recursive: true });

const skillImportUploadMiddleware = multer({
  storage: multer.diskStorage({
    destination: SKILL_IMPORT_TMP_DIR,
    filename: (_req, file, callback) => {
      callback(null, `${Date.now()}-${randomUUID()}-${basename(file.originalname)}`);
    },
  }),
  limits: {
    files: MAX_SKILL_FILES,
    fileSize: MAX_SKILL_FILE_BYTES,
  },
}).array('files');

export const skillsRouter = Router();

interface Frontmatter {
  name?: string;
  description?: string;
}

interface AgentControlSkillSidecar {
  provider?: string;
  registrySlug?: string;
  version?: string;
  displayName?: string;
  summary?: string;
  sourceUrl?: string;
  installedAt?: string;
}

interface ClawHubFileEntry {
  path: string;
  size?: number;
  sha256?: string;
  content?: string;
}

interface PreparedSkillFiles {
  files: Map<string, Buffer>;
  rootName?: string;
}

class RouteError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'SKILLS_ERROR',
  ) {
    super(message);
    this.name = 'RouteError';
  }
}

function sendError(res: Response, error: unknown, fallback: string): void {
  if (error instanceof RouteError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }

  console.error(fallback, error);
  const message = error instanceof Error ? error.message : fallback;
  res.status(500).json({ error: message, code: 'SKILLS_ERROR' });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringArrayFromField(value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
  throw new RouteError(400, 'Upload paths must be strings.', 'INVALID_UPLOAD_PATHS');
}

function ensureSafeSlug(value: unknown): string {
  const slug = stringValue(value);
  if (!slug || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(slug)) {
    throw new RouteError(400, 'Invalid ClawHub skill slug.', 'INVALID_SKILL_SLUG');
  }
  return slug;
}

function clampLimit(value: unknown, fallback: number, max = 100): number {
  const parsed = typeof value === 'string'
    ? Number.parseInt(value, 10)
    : typeof value === 'number'
      ? value
      : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.trunc(parsed), max);
}

function normalizeRelativePath(value: string, label: string): string {
  if (value.includes('\0')) {
    throw new RouteError(400, `Unsafe ${label}.`, 'UNSAFE_SKILL_PATH');
  }

  const normalized = value.trim().replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (
    !parts.length
    || normalized.startsWith('/')
    || /^[A-Za-z]:$/.test(parts[0])
    || parts.some((part) => part === '.' || part === '..')
  ) {
    throw new RouteError(400, `Unsafe ${label}.`, 'UNSAFE_SKILL_PATH');
  }

  return parts.join('/');
}

function ensureInside(root: string, target: string): void {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${sep}`)) {
    throw new RouteError(400, 'Resolved path escapes skills directory.', 'UNSAFE_SKILL_PATH');
  }
}

function normalizeSkillId(id: string): string {
  return normalizeRelativePath(id, 'skill id');
}

function isIgnoredSkillArchivePath(path: string): boolean {
  return path === '.DS_Store'
    || path.startsWith('__MACOSX/')
    || path.split('/').some((part) => part === '.DS_Store');
}

function skillRootFromFiles(files: Map<string, Buffer>): { prefix: string; rootName?: string } {
  if (files.has('SKILL.md')) return { prefix: '' };

  const skillFiles = [...files.keys()]
    .filter((path) => basename(path) === 'SKILL.md')
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));

  if (skillFiles.length === 0) {
    throw new RouteError(422, 'Skill bundle is missing a root SKILL.md file.', 'INVALID_SKILL_BUNDLE');
  }

  const root = dirname(skillFiles[0]).split(sep).join('/');
  return {
    prefix: `${root}/`,
    rootName: root.split('/').pop(),
  };
}

function prepareSkillFiles(files: Map<string, Buffer>): PreparedSkillFiles {
  const { prefix, rootName } = skillRootFromFiles(files);
  const prepared = new Map<string, Buffer>();

  for (const [path, content] of files) {
    if (prefix && !path.startsWith(prefix)) continue;
    const relPath = prefix ? path.slice(prefix.length) : path;
    if (!relPath || relPath === SIDECAR_FILENAME || isIgnoredSkillArchivePath(relPath)) continue;
    prepared.set(relPath, content);
  }

  if (!prepared.has('SKILL.md')) {
    throw new RouteError(422, 'Skill bundle is missing a root SKILL.md file.', 'INVALID_SKILL_BUNDLE');
  }

  return { files: prepared, rootName };
}

function slugifySkillDirectoryName(value: string | undefined, fallback: string): string {
  const slug = (value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || fallback;
}

async function uniqueLocalSkillDestination(root: string, baseSlug: string): Promise<string> {
  let slug = baseSlug;
  let index = 2;
  let destination = resolve(root, 'local', slug);

  while (await pathExists(destination)) {
    slug = `${baseSlug}-${index}`;
    destination = resolve(root, 'local', slug);
    index += 1;
  }

  ensureInside(root, destination);
  return destination;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function parseFrontmatter(content: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) return {};

  const frontmatter: Frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const item = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!item) continue;
    const key = item[1];
    const value = item[2].trim().replace(/^['"]|['"]$/g, '');
    if (key === 'name' && value) frontmatter.name = value;
    if (key === 'description' && value) frontmatter.description = value;
  }
  return frontmatter;
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function skillIdFromFile(root: string, skillFile: string): string {
  return relative(root, dirname(skillFile)).split(sep).join('/');
}

async function readInstalledSkill(skillFile: string, root = resolveAgentControlSkillsDir()): Promise<SkillMeta> {
  const content = await readFile(skillFile, 'utf8');
  const frontmatter = parseFrontmatter(content);
  const skillDir = dirname(skillFile);
  const id = skillIdFromFile(root, skillFile);
  const sidecar = await readJsonFile<AgentControlSkillSidecar>(join(skillDir, SIDECAR_FILENAME));
  const fallbackName = basename(skillDir);
  const provider = sidecar?.provider;
  const registrySlug = sidecar?.registrySlug ?? (id.startsWith('clawhub/') ? id.slice('clawhub/'.length).split('/')[0] : undefined);

  return {
    id,
    name: sidecar?.displayName || frontmatter.name || registrySlug || fallbackName,
    description: frontmatter.description || sidecar?.summary || '',
    key: frontmatter.name || registrySlug || fallbackName,
    source: provider === 'clawhub' ? 'ClawHub' : 'Local',
    provider,
    registrySlug,
    version: sidecar?.version,
    installedAt: sidecar?.installedAt,
  };
}

async function findSkillFiles(dir: string, found: string[] = []): Promise<string[]> {
  if (!await pathExists(dir)) return found;

  const entries = await readdir(dir, { withFileTypes: true });

  // A directory containing SKILL.md *is* a skill; everything beneath it belongs
  // to that skill, so record it and stop descending. Recursing deeper would
  // register nested SKILL.md files (e.g. references/, examples/) as phantom
  // skills — and deleting such a phantom would rm -rf a real skill's subtree.
  if (entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md')) {
    found.push(join(dir, 'SKILL.md'));
    return found;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      await findSkillFiles(join(dir, entry.name), found);
    }
  }

  return found;
}

async function listInstalledSkills(): Promise<SkillMeta[]> {
  const root = resolveAgentControlSkillsDir();
  await mkdir(root, { recursive: true });
  const files = await findSkillFiles(root);
  const skills = await Promise.all(files.map((file) => readInstalledSkill(file, root)));
  return skills.sort((a, b) => (
    a.source.localeCompare(b.source)
    || a.name.localeCompare(b.name)
    || a.id.localeCompare(b.id)
  ));
}

function resolveInstalledSkillFile(id: string): string {
  const root = resolveAgentControlSkillsDir();
  const relId = normalizeSkillId(id);
  const skillFile = resolve(root, relId, 'SKILL.md');
  ensureInside(root, skillFile);
  return skillFile;
}

async function deleteInstalledSkill(id: string): Promise<SkillMeta> {
  const root = resolveAgentControlSkillsDir();
  const skillFile = resolveInstalledSkillFile(id);
  if (!await pathExists(skillFile)) {
    throw new RouteError(404, `Skill '${id}' is not installed`, 'SKILL_NOT_FOUND');
  }

  const skill = await readInstalledSkill(skillFile, root);
  await rm(dirname(skillFile), { recursive: true, force: true });
  return skill;
}

async function fetchClawHubJson(
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
): Promise<unknown> {
  const url = new URL(`${CLAWHUB_API_BASE}${path}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new RouteError(
      response.status >= 500 ? 502 : response.status,
      text || `ClawHub returned HTTP ${response.status}.`,
      'CLAWHUB_REQUEST_FAILED',
    );
  }
  return response.json() as Promise<unknown>;
}

function statsValue(value: unknown): ClawHubStats | null {
  if (!isRecord(value)) return null;
  return {
    installsAllTime: numberValue(value.installsAllTime),
    downloads: numberValue(value.downloads),
    installsCurrent: numberValue(value.installsCurrent),
    stars: numberValue(value.stars),
  };
}

function skillSummaryValue(value: unknown): ClawHubSkillSummary | null {
  if (!isRecord(value)) return null;
  const slug = stringValue(value.slug);
  if (!slug) return null;

  const tags = isRecord(value.tags) ? value.tags : undefined;
  const latestVersion = isRecord(value.latestVersion) ? value.latestVersion : undefined;
  return {
    slug,
    displayName: stringValue(value.displayName) || stringValue(value.name) || slug,
    summary: stringValue(value.summary) || stringValue(value.description) || '',
    version: stringValue(value.version) ?? null,
    latestVersion: stringValue(latestVersion?.version) ?? stringValue(tags?.latest) ?? null,
    updatedAt: numberValue(value.updatedAt) ?? null,
    stats: statsValue(value.stats),
  };
}

function registrySummaries(data: unknown): ClawHubSkillSummary[] {
  if (!isRecord(data)) return [];
  const list = Array.isArray(data.results)
    ? data.results
    : Array.isArray(data.items)
      ? data.items
      : [];
  return list.flatMap((item) => {
    const summary = skillSummaryValue(item);
    return summary ? [summary] : [];
  });
}

function resolveVersion(detail: unknown, requestedVersion: string | undefined): string {
  if (requestedVersion && requestedVersion !== 'latest') return requestedVersion;
  if (!isRecord(detail)) {
    throw new RouteError(502, 'ClawHub returned an invalid skill payload.', 'CLAWHUB_BAD_RESPONSE');
  }

  const skill = isRecord(detail.skill) ? detail.skill : detail;
  const tags = isRecord(skill.tags) ? skill.tags : undefined;
  const latestVersion = isRecord(detail.latestVersion) ? detail.latestVersion : undefined;
  const version = stringValue(tags?.latest) || stringValue(latestVersion?.version);

  if (!version) {
    throw new RouteError(502, 'ClawHub did not provide a latest version for this skill.', 'CLAWHUB_BAD_RESPONSE');
  }
  return version;
}

function skillPayload(detail: unknown): Record<string, unknown> {
  if (!isRecord(detail)) return {};
  return isRecord(detail.skill) ? detail.skill : detail;
}

function fileEntriesFromPayload(payload: unknown): ClawHubFileEntry[] {
  // The /skills/:slug/versions/:version endpoint nests the file list under
  // `version.files`; fall back to a top-level `files` array for resilience.
  const container = isRecord(payload)
    ? (isRecord(payload.version) && Array.isArray(payload.version.files)
        ? payload.version.files
        : Array.isArray(payload.files)
          ? payload.files
          : [])
    : [];

  return container.flatMap((item): ClawHubFileEntry[] => {
    if (!isRecord(item)) return [];
    const path = stringValue(item.path);
    if (!path) return [];
    return [{
      path,
      size: numberValue(item.size),
      sha256: stringValue(item.sha256),
      content: typeof item.content === 'string' ? item.content : undefined,
    }];
  });
}

async function fetchClawHubFile(slug: string, filePath: string, version: string): Promise<Buffer> {
  const url = new URL(`${CLAWHUB_API_BASE}/skills/${encodeURIComponent(slug)}/file`);
  url.searchParams.set('path', filePath);
  url.searchParams.set('version', version);

  const response = await fetch(url, { headers: { accept: '*/*' } });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new RouteError(
      response.status >= 500 ? 502 : response.status,
      text || `ClawHub returned HTTP ${response.status} while fetching ${filePath}.`,
      'CLAWHUB_REQUEST_FAILED',
    );
  }

  return Buffer.from(await response.arrayBuffer());
}

async function fetchClawHubSkillMarkdown(slug: string, version: string | undefined): Promise<string> {
  const url = new URL(`${CLAWHUB_API_BASE}/skills/${encodeURIComponent(slug)}/file`);
  url.searchParams.set('path', 'SKILL.md');
  if (version) url.searchParams.set('version', version);
  else url.searchParams.set('tag', 'latest');

  const response = await fetch(url, { headers: { accept: 'text/markdown, text/plain, */*' } });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new RouteError(
      response.status >= 500 ? 502 : response.status,
      text || `ClawHub returned HTTP ${response.status}.`,
      'CLAWHUB_REQUEST_FAILED',
    );
  }
  return response.text();
}

function assertFileSize(path: string, size: number): void {
  if (size > MAX_SKILL_FILE_BYTES) {
    throw new RouteError(413, `Skill file ${path} is too large.`, 'SKILL_FILE_TOO_LARGE');
  }
}

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolveZip, reject) => {
    yauzl.open(path, { lazyEntries: true, validateEntrySizes: true }, (error, zipFile) => {
      if (error) {
        reject(error);
        return;
      }
      if (!zipFile) {
        reject(new RouteError(422, 'Could not open skill zip file.', 'INVALID_SKILL_ZIP'));
        return;
      }
      resolveZip(zipFile);
    });
  });
}

function readZipEntry(zipFile: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
  return new Promise((resolveBuffer, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      if (!stream) {
        reject(new RouteError(422, `Could not read ${entry.fileName} from skill zip file.`, 'INVALID_SKILL_ZIP'));
        return;
      }

      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.on('error', reject);
      stream.on('end', () => resolveBuffer(Buffer.concat(chunks)));
    });
  });
}

async function readZipSkillFiles(zipPath: string): Promise<Map<string, Buffer>> {
  const zipFile = await openZip(zipPath);
  try {
    return await new Promise<Map<string, Buffer>>((resolveFiles, reject) => {
      const files = new Map<string, Buffer>();
      let totalBytes = 0;
      let completed = false;

      const fail = (error: unknown) => {
        if (completed) return;
        completed = true;
        reject(error);
      };

      zipFile.on('entry', (entry) => {
        void (async () => {
          try {
            if (entry.fileName.endsWith('/')) {
              zipFile.readEntry();
              return;
            }

            const relPath = normalizeRelativePath(entry.fileName, 'zip file path');
            if (isIgnoredSkillArchivePath(relPath)) {
              zipFile.readEntry();
              return;
            }
            if (files.has(relPath)) {
              throw new RouteError(400, `Duplicate skill file path ${relPath}.`, 'DUPLICATE_SKILL_FILE');
            }
            if (files.size + 1 > MAX_SKILL_FILES) {
              throw new RouteError(413, 'Skill contains too many files.', 'SKILL_TOO_LARGE');
            }
            // yauzl is opened with validateEntrySizes, so the declared
            // uncompressedSize is enforced against the actual stream length.
            assertFileSize(relPath, entry.uncompressedSize);

            const content = await readZipEntry(zipFile, entry);
            totalBytes += content.byteLength;
            if (totalBytes > MAX_SKILL_TOTAL_BYTES) {
              throw new RouteError(413, 'Skill bundle is too large.', 'SKILL_TOO_LARGE');
            }

            files.set(relPath, content);
            zipFile.readEntry();
          } catch (error) {
            fail(error);
          }
        })();
      });

      zipFile.once('error', fail);
      zipFile.once('end', () => {
        if (completed) return;
        completed = true;
        resolveFiles(files);
      });
      zipFile.readEntry();
    });
  } finally {
    zipFile.close();
  }
}

async function uploadedSkillFilesFromRequest(uploadedFiles: Express.Multer.File[], relativePaths: string[]): Promise<PreparedSkillFiles> {
  if (uploadedFiles.length === 1 && extname(uploadedFiles[0].originalname).toLowerCase() === '.zip') {
    return prepareSkillFiles(await readZipSkillFiles(uploadedFiles[0].path));
  }

  if (uploadedFiles.length > MAX_SKILL_FILES) {
    throw new RouteError(413, 'Skill contains too many files.', 'SKILL_TOO_LARGE');
  }

  const files = new Map<string, Buffer>();
  let totalBytes = 0;

  // multer already enforces the per-file size limit (limits.fileSize), so only
  // the cumulative bundle size needs checking here.
  for (const [index, file] of uploadedFiles.entries()) {
    const relPath = normalizeRelativePath(relativePaths[index] ?? file.originalname, 'upload file path');
    if (isIgnoredSkillArchivePath(relPath)) continue;
    if (files.has(relPath)) {
      throw new RouteError(400, `Duplicate skill file path ${relPath}.`, 'DUPLICATE_SKILL_FILE');
    }

    totalBytes += file.size;
    if (totalBytes > MAX_SKILL_TOTAL_BYTES) {
      throw new RouteError(413, 'Skill bundle is too large.', 'SKILL_TOO_LARGE');
    }

    files.set(relPath, await readFile(file.path));
  }

  return prepareSkillFiles(files);
}

async function downloadClawHubFiles(slug: string, version: string, versionPayload: unknown): Promise<Map<string, Buffer>> {
  let entries = fileEntriesFromPayload(versionPayload);
  if (entries.length === 0) entries = [{ path: 'SKILL.md' }];
  if (entries.length > MAX_SKILL_FILES) {
    throw new RouteError(413, 'Skill contains too many files.', 'SKILL_TOO_LARGE');
  }

  const files = new Map<string, Buffer>();
  let totalBytes = 0;

  for (const entry of entries) {
    const relPath = normalizeRelativePath(entry.path, 'skill file path');
    if (entry.size !== undefined) assertFileSize(relPath, entry.size);

    const content = entry.content !== undefined
      ? Buffer.from(entry.content, 'utf8')
      : await fetchClawHubFile(slug, relPath, version);

    assertFileSize(relPath, content.byteLength);
    totalBytes += content.byteLength;
    if (totalBytes > MAX_SKILL_TOTAL_BYTES) {
      throw new RouteError(413, 'Skill bundle is too large.', 'SKILL_TOO_LARGE');
    }

    if (entry.sha256) {
      const actual = createHash('sha256').update(content).digest('hex');
      if (actual !== entry.sha256) {
        throw new RouteError(502, `Checksum mismatch for ${relPath}.`, 'CLAWHUB_CHECKSUM_MISMATCH');
      }
    }

    files.set(relPath, content);
  }

  if (!files.has('SKILL.md')) {
    throw new RouteError(422, 'Skill bundle is missing a root SKILL.md file.', 'INVALID_SKILL_BUNDLE');
  }

  return files;
}

function displayHomePath(path: string): string {
  const home = homedir();
  const resolved = resolve(path);
  if (resolved === home) return '~';
  if (resolved.startsWith(`${home}${sep}`)) return `~/${relative(home, resolved).split(sep).join('/')}`;
  return resolved;
}

function resolveConfigDir(value: string): string {
  const trimmed = value.trim();
  const expanded = trimmed === '~'
    ? homedir()
    : trimmed.startsWith('~/')
      ? join(homedir(), trimmed.slice(2))
      : trimmed;
  return resolve(resolveHermesHome(), expanded);
}

// Registers AGENTCONTROL_HOME/skills as a Hermes `skills.external_dirs` entry so agent
// runs load installed skills. Idempotent — called once at server boot; installs
// drop skills into the already-registered dir and need no further config write.
export async function ensureHermesExternalSkillsDir(): Promise<void> {
  const skillsDir = resolveAgentControlSkillsDir();
  const hermesHome = resolveHermesHome();
  const configPath = join(hermesHome, 'config.yaml');
  await mkdir(hermesHome, { recursive: true });

  const existing = await readFile(configPath, 'utf8').catch(() => '');
  const doc = parseDocument(existing);
  const data = (doc.toJS() ?? {}) as { skills?: unknown };
  const skillsValue = data.skills;
  const rawDirs = isRecord(skillsValue) ? skillsValue.external_dirs : undefined;
  const existingDirs = Array.isArray(rawDirs)
    ? rawDirs.filter((dir): dir is string => typeof dir === 'string')
    : typeof rawDirs === 'string'
      ? [rawDirs]
      : [];

  if (existingDirs.some((dir) => resolveConfigDir(dir) === resolve(skillsDir))) {
    return;
  }

  // If `skills:` exists but is not a mapping (a bare `skills:` parses to null, or
  // it could be a scalar/list), `setIn(['skills', 'external_dirs'], …)` throws
  // "Expected YAML collection at skills". Drop the offending node so setIn can
  // recreate the mapping; a real mapping is left intact, preserving sibling keys.
  if (skillsValue !== undefined && !isRecord(skillsValue)) {
    doc.deleteIn(['skills']);
  }

  doc.setIn(['skills', 'external_dirs'], [...existingDirs, displayHomePath(skillsDir)]);
  await writeFile(configPath, doc.toString(), 'utf8');
}

async function writeSkillFiles(destination: string, files: Map<string, Buffer>, sidecar: AgentControlSkillSidecar): Promise<void> {
  const parent = dirname(destination);
  const tempDir = join(parent, `.${basename(destination)}.tmp-${Date.now()}-${randomUUID()}`);
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });

  try {
    for (const [relPath, content] of files) {
      const target = resolve(tempDir, relPath);
      ensureInside(tempDir, target);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }

    await writeFile(join(tempDir, SIDECAR_FILENAME), `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8');
    await rm(destination, { recursive: true, force: true });
    await rename(tempDir, destination);
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function installClawHubSkill(slug: string, requestedVersion: string | undefined, force: boolean): Promise<{
  skill: SkillMeta;
  installed: boolean;
  alreadyInstalled: boolean;
}> {
  const skillsRoot = resolveAgentControlSkillsDir();
  const destination = resolve(skillsRoot, 'clawhub', slug);
  ensureInside(skillsRoot, destination);
  await mkdir(dirname(destination), { recursive: true });

  const existingSkillFile = join(destination, 'SKILL.md');
  if (!force && await pathExists(existingSkillFile)) {
    return {
      skill: await readInstalledSkill(existingSkillFile, skillsRoot),
      installed: false,
      alreadyInstalled: true,
    };
  }

  const detail = await fetchClawHubJson(`/skills/${encodeURIComponent(slug)}`);
  const version = resolveVersion(detail, requestedVersion);
  const versionPayload = await fetchClawHubJson(`/skills/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}`);
  const files = await downloadClawHubFiles(slug, version, versionPayload);
  const skill = skillPayload(detail);

  const sidecar: AgentControlSkillSidecar = {
    provider: 'clawhub',
    registrySlug: slug,
    version,
    displayName: stringValue(skill.displayName) || slug,
    summary: stringValue(skill.summary) || '',
    sourceUrl: `https://clawhub.ai/skills/${slug}`,
    installedAt: new Date().toISOString(),
  };

  await writeSkillFiles(destination, files, sidecar);

  return {
    skill: await readInstalledSkill(join(destination, 'SKILL.md'), skillsRoot),
    installed: true,
    alreadyInstalled: false,
  };
}

function parseSkillImportRequest(value: unknown, fileCount: number): { relativePaths: string[] } {
  const body = isRecord(value) ? value : {};
  const relativePaths = stringArrayFromField(body.relativePaths);
  if (relativePaths.length > 0 && relativePaths.length !== fileCount) {
    throw new RouteError(400, 'Upload path count must match file count.', 'INVALID_UPLOAD_PATHS');
  }
  return { relativePaths };
}

async function importLocalSkill(uploadedFiles: Express.Multer.File[], relativePaths: string[]): Promise<{
  skill: SkillMeta;
  imported: boolean;
}> {
  const prepared = await uploadedSkillFilesFromRequest(uploadedFiles, relativePaths);
  const skillContent = prepared.files.get('SKILL.md');
  if (!skillContent) {
    throw new RouteError(422, 'Skill bundle is missing a root SKILL.md file.', 'INVALID_SKILL_BUNDLE');
  }

  const frontmatter = parseFrontmatter(skillContent.toString('utf8'));
  const displayName = frontmatter.name || prepared.rootName || 'Local skill';
  const summary = frontmatter.description || '';
  const skillsRoot = resolveAgentControlSkillsDir();
  const baseSlug = slugifySkillDirectoryName(displayName, 'skill');
  const destination = await uniqueLocalSkillDestination(skillsRoot, baseSlug);

  const sidecar: AgentControlSkillSidecar = {
    provider: 'local',
    displayName,
    summary,
    installedAt: new Date().toISOString(),
  };

  await mkdir(dirname(destination), { recursive: true });
  await writeSkillFiles(destination, prepared.files, sidecar);

  return {
    skill: await readInstalledSkill(join(destination, 'SKILL.md'), skillsRoot),
    imported: true,
  };
}

async function handleSkillImportRequest(req: Request, res: Response): Promise<void> {
  const uploadedFiles = Array.isArray(req.files) ? req.files : [];

  try {
    if (uploadedFiles.length === 0) {
      throw new RouteError(400, 'At least one skill file is required.', 'NO_SKILL_FILES');
    }

    const { relativePaths } = parseSkillImportRequest(req.body, uploadedFiles.length);
    const result = await importLocalSkill(uploadedFiles, relativePaths);

    res.status(201).json({
      skill: result.skill,
      installed: result.imported,
      alreadyInstalled: false,
    });
  } catch (error) {
    sendError(res, error, 'Failed to import skill');
  } finally {
    await Promise.all(uploadedFiles.map((file) => unlink(file.path).catch(() => undefined)));
  }
}

skillsRouter.get('/', async (_req, res) => {
  try {
    res.json({ skills: await listInstalledSkills() });
  } catch (error) {
    sendError(res, error, 'Failed to list skills');
  }
});

skillsRouter.get('/registry/search', async (req, res) => {
  try {
    const query = stringValue(req.query.q);
    const limit = clampLimit(req.query.limit, 24);
    const data = query
      ? await fetchClawHubJson('/search', { q: query, limit, nonSuspiciousOnly: true })
      : await fetchClawHubJson('/skills', { sort: 'downloads', limit, nonSuspiciousOnly: true });
    res.json({ skills: registrySummaries(data) });
  } catch (error) {
    sendError(res, error, 'Failed to search ClawHub skills');
  }
});

skillsRouter.get('/registry/browse', async (req, res) => {
  try {
    const limit = clampLimit(req.query.limit, 24);
    const data = await fetchClawHubJson('/skills', { sort: 'downloads', limit, nonSuspiciousOnly: true });
    res.json({ skills: registrySummaries(data) });
  } catch (error) {
    sendError(res, error, 'Failed to load ClawHub skills');
  }
});

skillsRouter.get('/registry/:slug/content', async (req, res) => {
  try {
    const slug = ensureSafeSlug(req.params.slug);
    const content = await fetchClawHubSkillMarkdown(slug, stringValue(req.query.version));
    res.json({ content });
  } catch (error) {
    sendError(res, error, 'Failed to load ClawHub skill content');
  }
});

skillsRouter.get('/registry/:slug/scan', async (req, res) => {
  try {
    const slug = ensureSafeSlug(req.params.slug);
    const version = stringValue(req.query.version);
    const data = await fetchClawHubJson(
      `/skills/${encodeURIComponent(slug)}/scan`,
      version ? { version } : { tag: 'latest' },
    );
    res.json(isRecord(data) ? data : {});
  } catch (error) {
    sendError(res, error, 'Failed to load ClawHub skill scan');
  }
});

skillsRouter.post('/import', (req, res) => {
  skillImportUploadMiddleware(req, res, (error) => {
    if (error) {
      const status = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      sendError(res, new RouteError(status, error instanceof Error ? error.message : 'Failed to upload skill files.', 'SKILL_UPLOAD_FAILED'), 'Failed to upload skill files');
      return;
    }

    void handleSkillImportRequest(req, res);
  });
});

skillsRouter.post('/install', async (req, res) => {
  try {
    const body = isRecord(req.body) ? req.body : {};
    const provider = stringValue(body.provider) || 'clawhub';
    if (provider !== 'clawhub') {
      throw new RouteError(400, `Unsupported skills provider '${provider}'.`, 'UNSUPPORTED_SKILLS_PROVIDER');
    }

    const slug = ensureSafeSlug(body.slug);
    const requestedVersion = stringValue(body.version);
    const force = body.force === true;
    const result = await installClawHubSkill(slug, requestedVersion, force);

    res.status(result.installed ? 201 : 200).json({
      skill: result.skill,
      installed: result.installed,
      alreadyInstalled: result.alreadyInstalled,
    });
  } catch (error) {
    sendError(res, error, 'Failed to install skill');
  }
});

skillsRouter.delete('/:id', async (req, res) => {
  try {
    const skill = await deleteInstalledSkill(req.params.id);
    res.json({ ok: true, skill });
  } catch (error) {
    sendError(res, error, 'Failed to delete skill');
  }
});

skillsRouter.get('/:id/content', async (req, res) => {
  try {
    const skillFile = resolveInstalledSkillFile(req.params.id);
    if (!await pathExists(skillFile)) {
      throw new RouteError(404, `Skill '${req.params.id}' is not installed`, 'SKILL_NOT_FOUND');
    }

    const root = resolveAgentControlSkillsDir();
    const [skill, content] = await Promise.all([
      readInstalledSkill(skillFile, root),
      readFile(skillFile, 'utf8'),
    ]);
    res.json({ skill, content });
  } catch (error) {
    sendError(res, error, 'Failed to load skill content');
  }
});
