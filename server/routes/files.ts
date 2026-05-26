import { constants, mkdirSync } from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import {
  access,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import archiver from 'archiver';
import multer from 'multer';
import { Router, type Request, type Response } from 'express';
import { expandHomePrefix } from '../paths.js';
import { errorCode, isRecord } from '../errors.js';
import type {
  FileEntry,
  FileEntryType,
  FileCreateType,
} from '../../shared/types.js';

interface FileWriteRequest {
  path: string;
  content: string;
  expectedModifiedAt?: number;
  overwrite?: boolean;
}

interface FileCreateRequest {
  parentPath: string;
  name: string;
  type: FileCreateType;
  content?: string;
}

const HOME = resolve(homedir());
const TEXT_SAMPLE_BYTES = 8192;
const MAX_TEXT_FILE_SIZE = 10 * 1024 * 1024;
const MAX_TEXT_FILE_SIZE_DISPLAY = '10 MiB';
const DEFAULT_FILE_BROWSER_PATH = '~/.agentcontrol/workspace';
const UPLOAD_TMP_DIR = join(tmpdir(), 'agentcontrol-uploads');

mkdirSync(UPLOAD_TMP_DIR, { recursive: true });

const uploadMiddleware = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_TMP_DIR,
    filename: (_req, file, callback) => {
      callback(null, `${Date.now()}-${randomUUID()}-${basename(file.originalname)}`);
    },
  }),
}).array('files');

class FileRouteError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export const filesRouter = Router();

filesRouter.get('/list', async (req, res) => {
  try {
    const directoryPath = resolveUserPath(req.query.path, DEFAULT_FILE_BROWSER_PATH);
    const directoryStats = await stat(directoryPath);

    if (!directoryStats.isDirectory()) {
      throw new FileRouteError(400, 'Path is not a directory', 'NOT_DIRECTORY');
    }

    const dirents = await readdir(directoryPath, { withFileTypes: true });
    const entries = await Promise.all(
      dirents.map((dirent) => entryFromDirent(directoryPath, dirent)),
    );

    entries.sort(compareEntries);

    const parentPath = dirname(directoryPath);
    res.json({
      path: directoryPath,
      displayPath: displayPath(directoryPath),
      parentPath: parentPath === directoryPath ? null : parentPath,
      entries,
    });
  } catch (error) {
    sendFileError(res, error, 'Failed to list directory');
  }
});

filesRouter.get('/read', async (req, res) => {
  try {
    const filePath = resolveRequiredPath(req.query.path);
    const fileStats = await stat(filePath);

    if (fileStats.isDirectory()) {
      throw new FileRouteError(400, 'Cannot open a directory as text', 'IS_DIRECTORY');
    }
    if (!fileStats.isFile()) {
      throw new FileRouteError(400, 'Path is not a regular text file', 'NOT_FILE');
    }
    if (fileStats.size > MAX_TEXT_FILE_SIZE) {
      throw new FileRouteError(413, `File is too large to open as text. Maximum size is ${MAX_TEXT_FILE_SIZE_DISPLAY}.`, 'FILE_TOO_LARGE');
    }
    if (await looksBinary(filePath, fileStats.size)) {
      throw new FileRouteError(415, 'Binary files cannot be opened as text', 'BINARY_FILE');
    }

    const content = await readFile(filePath, 'utf8');
    res.json({
      path: filePath,
      displayPath: displayPath(filePath),
      name: basename(filePath),
      content,
      size: fileStats.size,
      modifiedAt: fileStats.mtimeMs,
      encoding: 'utf8',
      fileType: 'text',
    });
  } catch (error) {
    sendFileError(res, error, 'Failed to read file');
  }
});

filesRouter.get('/download', async (req, res) => {
  try {
    const targetPath = resolveRequiredPath(req.query.path);
    const targetStats = await stat(targetPath);
    const targetName = basename(targetPath) || 'download';

    if (targetStats.isDirectory()) {
      res.attachment(`${targetName}.zip`);
      res.type('application/zip');

      const archive = archiver('zip', { zlib: { level: 6 } });
      let handledArchiveError = false;
      const handleArchiveError = (archiveError: unknown) => {
        if (handledArchiveError) return;
        handledArchiveError = true;
        sendStreamingFileError(res, archiveError, 'Failed to download folder');
      };

      archive.on('error', handleArchiveError);
      archive.pipe(res);
      archive.directory(targetPath, targetName);
      archive.finalize().catch(handleArchiveError);
      return;
    }

    if (!targetStats.isFile()) {
      throw new FileRouteError(400, 'Path is not a downloadable file or folder', 'NOT_DOWNLOADABLE');
    }

    res.download(targetPath, targetName, (downloadError) => {
      if (downloadError) sendStreamingFileError(res, downloadError, 'Failed to download file');
    });
  } catch (error) {
    sendFileError(res, error, 'Failed to download file entry');
  }
});

filesRouter.put('/write', async (req, res) => {
  try {
    const body = parseWriteRequest(req.body);
    const filePath = resolveUserPath(body.path);
    const currentStats = await stat(filePath);

    if (currentStats.isDirectory()) {
      throw new FileRouteError(400, 'Cannot write text to a directory', 'IS_DIRECTORY');
    }
    if (!currentStats.isFile()) {
      throw new FileRouteError(400, 'Path is not a regular file', 'NOT_FILE');
    }
    if (
      typeof body.expectedModifiedAt === 'number'
      && !body.overwrite
      && Math.abs(currentStats.mtimeMs - body.expectedModifiedAt) > 1
    ) {
      throw new FileRouteError(409, 'File changed on disk', 'FILE_CHANGED');
    }

    await writeFile(filePath, body.content, 'utf8');
    const nextStats = await stat(filePath);

    res.json({
      path: filePath,
      displayPath: displayPath(filePath),
      size: nextStats.size,
      modifiedAt: nextStats.mtimeMs,
    });
  } catch (error) {
    sendFileError(res, error, 'Failed to write file');
  }
});

filesRouter.post('/create', async (req, res) => {
  try {
    const body = parseCreateRequest(req.body);
    const parentPath = resolveUserPath(body.parentPath);
    const name = validateFileName(body.name);
    const targetPath = join(parentPath, name);

    if (body.type === 'directory') {
      await mkdir(targetPath);
    } else {
      await writeFile(targetPath, body.content ?? '', { encoding: 'utf8', flag: 'wx' });
    }

    res.status(201).json({ entry: await entryFromPath(targetPath) });
  } catch (error) {
    sendFileError(res, error, 'Failed to create file entry');
  }
});

filesRouter.post('/upload', (req, res) => {
  uploadMiddleware(req, res, (error) => {
    if (error) {
      sendFileError(res, error, 'Failed to upload files');
      return;
    }

    void handleUploadRequest(req, res);
  });
});

filesRouter.patch('/rename', async (req, res) => {
  try {
    const body = parseRenameRequest(req.body);
    const sourcePath = resolveUserPath(body.path);
    const newName = validateFileName(body.newName);
    const targetPath = join(dirname(sourcePath), newName);

    if (await canAccess(targetPath, constants.F_OK)) {
      throw new FileRouteError(409, 'Target already exists', 'EEXIST');
    }

    await rename(sourcePath, targetPath);
    res.json({ entry: await entryFromPath(targetPath) });
  } catch (error) {
    sendFileError(res, error, 'Failed to rename file entry');
  }
});

filesRouter.delete('/', async (req, res) => {
  try {
    const body = parseDeleteRequest(req.body);
    const targetPath = resolveUserPath(body.path);
    const targetStats = await lstat(targetPath);

    if (targetStats.isDirectory() && !targetStats.isSymbolicLink()) {
      if (body.recursive) {
        await rm(targetPath, { recursive: true, force: false });
      } else {
        await rmdir(targetPath);
      }
    } else {
      await unlink(targetPath);
    }

    res.json({ ok: true });
  } catch (error) {
    sendFileError(res, error, 'Failed to delete file entry');
  }
});

async function handleUploadRequest(req: Request, res: Response): Promise<void> {
  const uploadedFiles = Array.isArray(req.files) ? req.files : [];

  try {
    if (uploadedFiles.length === 0) {
      throw new FileRouteError(400, 'At least one file is required', 'BAD_REQUEST');
    }

    const { targetPath, relativePaths } = parseUploadRequest(req.body, uploadedFiles.length);
    const targetDirectory = resolveUserPath(targetPath);
    const directoryStats = await stat(targetDirectory);

    if (!directoryStats.isDirectory()) {
      throw new FileRouteError(400, 'Upload target is not a directory', 'NOT_DIRECTORY');
    }

    const uploadedRootPaths = new Set<string>();

    for (const [index, file] of uploadedFiles.entries()) {
      const segments = sanitizeUploadRelativePath(relativePaths[index] ?? file.originalname);
      const destinationPath = join(targetDirectory, ...segments);

      if (!isSameOrChildPath(targetDirectory, destinationPath)) {
        throw new FileRouteError(400, 'Upload path cannot escape the target directory', 'BAD_REQUEST');
      }

      await assertWritableUploadTarget(destinationPath);
      await mkdir(dirname(destinationPath), { recursive: true });
      try {
        await rename(file.path, destinationPath);
      } catch {
        await copyFile(file.path, destinationPath);
      }
      uploadedRootPaths.add(join(targetDirectory, segments[0]));
    }

    const entries = await Promise.all(
      [...uploadedRootPaths].sort((a, b) => a.localeCompare(b)).map((entryPath) => entryFromPath(entryPath)),
    );

    res.status(201).json({ uploaded: uploadedFiles.length, entries });
  } catch (error) {
    sendFileError(res, error, 'Failed to upload files');
  } finally {
    await Promise.all(uploadedFiles.map((file) => unlink(file.path).catch(() => undefined)));
  }
}

function parseWriteRequest(value: unknown): FileWriteRequest {
  if (!isRecord(value)) throw new FileRouteError(400, 'Request body is required', 'BAD_REQUEST');
  if (typeof value.path !== 'string') throw new FileRouteError(400, 'Path is required', 'BAD_REQUEST');
  if (typeof value.content !== 'string') throw new FileRouteError(400, 'Content is required', 'BAD_REQUEST');
  assertTextContentSize(value.content);

  return {
    path: value.path,
    content: value.content,
    expectedModifiedAt: typeof value.expectedModifiedAt === 'number' ? value.expectedModifiedAt : undefined,
    overwrite: value.overwrite === true,
  };
}

function parseCreateRequest(value: unknown): FileCreateRequest {
  if (!isRecord(value)) throw new FileRouteError(400, 'Request body is required', 'BAD_REQUEST');
  if (typeof value.parentPath !== 'string') throw new FileRouteError(400, 'Parent path is required', 'BAD_REQUEST');
  if (typeof value.name !== 'string') throw new FileRouteError(400, 'Name is required', 'BAD_REQUEST');
  if (value.type !== 'file' && value.type !== 'directory') {
    throw new FileRouteError(400, 'Type must be file or directory', 'BAD_REQUEST');
  }

  let content: string | undefined;
  if (typeof value.content === 'string') {
    assertTextContentSize(value.content);
    content = value.content;
  } else if (value.content !== undefined) {
    throw new FileRouteError(400, 'Content must be a string', 'BAD_REQUEST');
  }

  return {
    parentPath: value.parentPath,
    name: value.name,
    type: value.type,
    content,
  };
}

function assertTextContentSize(content: string): void {
  if (Buffer.byteLength(content, 'utf8') <= MAX_TEXT_FILE_SIZE) return;
  throw new FileRouteError(413, `Text file content cannot exceed ${MAX_TEXT_FILE_SIZE_DISPLAY}.`, 'FILE_TOO_LARGE');
}

function parseUploadRequest(value: unknown, fileCount: number): { targetPath: string; relativePaths: string[] } {
  if (!isRecord(value)) throw new FileRouteError(400, 'Request body is required', 'BAD_REQUEST');
  if (typeof value.targetPath !== 'string') {
    throw new FileRouteError(400, 'Upload target path is required', 'BAD_REQUEST');
  }

  const relativePaths = stringArrayFromField(value.relativePaths);
  if (relativePaths.length > 0 && relativePaths.length !== fileCount) {
    throw new FileRouteError(400, 'Upload path count must match file count', 'BAD_REQUEST');
  }

  return { targetPath: value.targetPath, relativePaths };
}

function parseRenameRequest(value: unknown): { path: string; newName: string } {
  if (!isRecord(value)) throw new FileRouteError(400, 'Request body is required', 'BAD_REQUEST');
  if (typeof value.path !== 'string') throw new FileRouteError(400, 'Path is required', 'BAD_REQUEST');
  if (typeof value.newName !== 'string') throw new FileRouteError(400, 'New name is required', 'BAD_REQUEST');
  return { path: value.path, newName: value.newName };
}

function parseDeleteRequest(value: unknown): { path: string; recursive: boolean } {
  if (!isRecord(value)) throw new FileRouteError(400, 'Request body is required', 'BAD_REQUEST');
  if (typeof value.path !== 'string') throw new FileRouteError(400, 'Path is required', 'BAD_REQUEST');
  return { path: value.path, recursive: value.recursive === true };
}

function resolveRequiredPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new FileRouteError(400, 'Path is required', 'BAD_REQUEST');
  }
  return resolveUserPath(value);
}

function resolveUserPath(value: unknown, fallback?: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    if (fallback !== undefined) return resolve(expandHomePrefix(fallback));
    throw new FileRouteError(400, 'Path is required', 'BAD_REQUEST');
  }
  return resolve(expandHomePrefix(value));
}

function validateFileName(value: string): string {
  const name = value.trim();
  if (!name) throw new FileRouteError(400, 'Name is required', 'BAD_REQUEST');
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new FileRouteError(400, 'Name cannot include path separators', 'BAD_REQUEST');
  }
  return name;
}

function stringArrayFromField(value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
  throw new FileRouteError(400, 'Upload paths must be strings', 'BAD_REQUEST');
}

function sanitizeUploadRelativePath(value: string): string[] {
  const normalized = value.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/')) {
    throw new FileRouteError(400, 'Upload path must be relative', 'BAD_REQUEST');
  }

  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new FileRouteError(400, 'Upload path contains invalid segments', 'BAD_REQUEST');
  }

  return segments;
}

async function assertWritableUploadTarget(destinationPath: string): Promise<void> {
  try {
    const destinationStats = await lstat(destinationPath);
    if (destinationStats.isDirectory()) {
      throw new FileRouteError(409, 'A directory already exists at the upload target', 'EEXIST');
    }
  } catch (error) {
    if (error instanceof FileRouteError) throw error;
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

function isSameOrChildPath(parentPath: string, childPath: string): boolean {
  const childRelativePath = relative(parentPath, childPath);
  return childRelativePath === '' || (!childRelativePath.startsWith('..') && !isAbsolute(childRelativePath));
}

async function entryFromDirent(parentPath: string, dirent: Dirent): Promise<FileEntry> {
  const entryPath = join(parentPath, dirent.name);
  const type = fileEntryType(dirent);
  return entryFromPath(entryPath, dirent.name, type, type !== 'symlink');
}

async function entryFromPath(
  entryPath: string,
  entryName = basename(entryPath),
  fallbackType: FileEntryType = 'other',
  skipLstat = false,
): Promise<FileEntry> {
  let linkStats: Stats | null = null;
  let targetStats: Stats | null = null;

  const unreachable: FileEntry = {
    name: entryName,
    path: entryPath,
    displayPath: displayPath(entryPath),
    type: fallbackType,
    hidden: entryName.startsWith('.'),
    size: null,
    modifiedAt: null,
    readable: false,
    writable: false,
  };

  if (skipLstat) {
    try {
      targetStats = await stat(entryPath);
      linkStats = targetStats;
    } catch {
      return unreachable;
    }
  } else {
    try {
      linkStats = await lstat(entryPath);
    } catch {
      return unreachable;
    }

    try {
      targetStats = await stat(entryPath);
    } catch {
      targetStats = linkStats;
    }
  }

  const type = skipLstat ? fallbackType : fileEntryType(linkStats!);
  const metadataStats = targetStats ?? linkStats!;
  const [readable, writable] = await Promise.all([
    canAccess(entryPath, constants.R_OK),
    canAccess(entryPath, constants.W_OK),
  ]);

  return {
    name: entryName,
    path: entryPath,
    displayPath: displayPath(entryPath),
    type,
    hidden: entryName.startsWith('.'),
    size: metadataStats.isDirectory() ? null : metadataStats.size,
    modifiedAt: metadataStats.mtimeMs,
    readable,
    writable,
  };
}

async function canAccess(targetPath: string, mode: number): Promise<boolean> {
  try {
    await access(targetPath, mode);
    return true;
  } catch {
    return false;
  }
}

function displayPath(absolutePath: string): string {
  if (absolutePath === HOME) return '~/';
  const pathRelativeToHome = relative(HOME, absolutePath);
  if (pathRelativeToHome && !pathRelativeToHome.startsWith('..') && !isAbsolute(pathRelativeToHome)) {
    return `~/${pathRelativeToHome.split(sep).join('/')}`;
  }
  return absolutePath;
}

function fileEntryType(entry: { isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean }): FileEntryType {
  if (entry.isSymbolicLink()) return 'symlink';
  if (entry.isDirectory()) return 'directory';
  if (entry.isFile()) return 'file';
  return 'other';
}

const ENTRY_RANK: Record<FileEntryType, number> = { directory: 0, file: 1, symlink: 2, other: 3 };

function compareEntries(a: FileEntry, b: FileEntry): number {
  const typeDifference = (ENTRY_RANK[a.type] ?? 3) - (ENTRY_RANK[b.type] ?? 3);
  if (typeDifference !== 0) return typeDifference;
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

async function looksBinary(filePath: string, size: number): Promise<boolean> {
  if (size === 0) return false;

  const sampleSize = Math.min(TEXT_SAMPLE_BYTES, size);
  const buffer = Buffer.alloc(sampleSize);
  const handle = await open(filePath, 'r');

  try {
    const { bytesRead } = await handle.read(buffer, 0, sampleSize, 0);
    if (bytesRead === 0) return false;

    let controlBytes = 0;
    for (let index = 0; index < bytesRead; index += 1) {
      const byte = buffer[index];
      if (byte === 0) return true;
      const isAllowedWhitespace = byte === 9 || byte === 10 || byte === 12 || byte === 13;
      if ((byte < 32 && !isAllowedWhitespace) || byte === 127) controlBytes += 1;
    }

    return controlBytes / bytesRead > 0.2;
  } finally {
    await handle.close();
  }
}

function sendFileError(res: Response, error: unknown, fallback: string): void {
  if (error instanceof FileRouteError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }

  const code = errorCode(error);
  const status = statusForNodeCode(code);
  const message = error instanceof Error && error.message ? error.message : fallback;
  res.status(status).json({ error: message, code });
}

function sendStreamingFileError(res: Response, error: unknown, fallback: string): void {
  if (res.headersSent) {
    res.destroy(error instanceof Error ? error : new Error(fallback));
    return;
  }

  sendFileError(res, error, fallback);
}

function statusForNodeCode(code: string | undefined): number {
  switch (code) {
    case 'ENOENT':
      return 404;
    case 'EACCES':
    case 'EPERM':
      return 403;
    case 'ENOTDIR':
    case 'EISDIR':
      return 400;
    case 'EEXIST':
    case 'ENOTEMPTY':
      return 409;
    default:
      return 500;
  }
}
