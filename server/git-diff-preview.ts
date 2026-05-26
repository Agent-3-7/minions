import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { resolveAgentControlWorkspaceDir } from './paths.js';
import type { CodeDiffSummary } from '../shared/types.js';

const execFileAsync = promisify(execFile);

const MAX_DIFF_BYTES = 16_000;
const MAX_STAT_BYTES = 4_000;
const MAX_FILES = 12;

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 512 * 1024,
    timeout: 5_000,
  });
  return stdout.toString();
}

function trimOutput(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes <= maxBytes) return { value, truncated: false };

  const clipped = Buffer.from(value, 'utf8').subarray(0, maxBytes).toString('utf8');
  return {
    value: `${clipped.replace(/\s+$/, '')}\n… diff preview truncated (${Math.round(bytes / 1024)} KB total)`,
    truncated: true,
  };
}

function parseChangedFiles(nameStatus: string): CodeDiffSummary['files'] {
  return nameStatus
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_FILES)
    .map((line) => {
      const [status = 'M', ...rest] = line.split(/\s+/);
      return { status, path: rest.join(' ') };
    });
}

async function isGitWorkTree(cwd: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--is-inside-work-tree'], cwd);
    return true;
  } catch {
    return false;
  }
}

async function resolveDiffCwd(preferredCwd?: string): Promise<string | null> {
  const candidates = [preferredCwd, resolveAgentControlWorkspaceDir(), process.cwd()]
    .filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (await isGitWorkTree(candidate)) return candidate;
  }
  return null;
}

export async function collectGitDiffSummary(cwd?: string): Promise<CodeDiffSummary | null> {
  const diffCwd = await resolveDiffCwd(cwd);
  if (!diffCwd) return null;

  const [nameStatus, statRaw, unstagedRaw, stagedRaw] = await Promise.all([
    git(['status', '--short'], diffCwd),
    git(['diff', '--stat', 'HEAD'], diffCwd),
    git(['diff', '--no-ext-diff', '--minimal'], diffCwd),
    git(['diff', '--cached', '--no-ext-diff', '--minimal'], diffCwd),
  ]);

  const changedFiles = parseChangedFiles(nameStatus);
  const combinedDiff = [stagedRaw, unstagedRaw].filter(Boolean).join('\n');
  if (changedFiles.length === 0 && !combinedDiff.trim()) return null;

  const stat = trimOutput(statRaw.trim(), MAX_STAT_BYTES);
  const diff = trimOutput(combinedDiff.trim(), MAX_DIFF_BYTES);

  return {
    files: changedFiles,
    fileCount: nameStatus.split('\n').filter((line) => line.trim()).length,
    stat: stat.value,
    patch: diff.value,
    truncated: stat.truncated || diff.truncated,
    capturedAt: Date.now(),
  };
}
