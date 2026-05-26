import { open, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveHermesHome } from '../paths.js';
import type { ScheduledTaskRun, ScheduledTaskRunContent } from '../../shared/types.js';

let _outputDir: string | undefined;
function resolveOutputDir(): string {
  return (_outputDir ??= join(resolveHermesHome(), 'cron', 'output'));
}

function isValidSegment(value: string): boolean {
  return value.length > 0 && !value.includes('/') && !value.includes('\\') && !value.includes('..');
}

function parseTimestamp(stem: string): string | null {
  const match = stem.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
}

function detectStatus(head: string): ScheduledTaskRun['status'] {
  const nlIdx = head.indexOf('\n');
  const firstLine = (nlIdx === -1 ? head : head.slice(0, nlIdx)).trim();
  if (firstLine.startsWith('# Cron Job:') && firstLine.includes('(FAILED)')) return 'error';
  if (firstLine.startsWith('# Cron Job:')) return 'ok';
  return 'unknown';
}

function extractBody(content: string): string {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '## Response' || trimmed === '## Error') {
      return lines.slice(i + 1).join('\n').trim();
    }
  }
  return content.trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

function buildPreview(head: string): string {
  const body = extractBody(head);
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 4);
  return truncate(lines.join('\n'), 240);
}

async function readHead(path: string, maxBytes = 8192): Promise<string> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    return buf.toString('utf8', 0, bytesRead);
  } finally {
    await fh.close();
  }
}

export async function listScheduledTaskRuns(scheduledTaskId: string, limit = 50): Promise<ScheduledTaskRun[]> {
  if (!isValidSegment(scheduledTaskId)) return [];
  const dir = join(resolveOutputDir(), scheduledTaskId);
  const safeLimit = Math.max(1, Math.min(limit, 50));

  let names: string[];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    names = entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name);
  } catch {
    return [];
  }

  names.sort((a, b) => b.localeCompare(a));

  return Promise.all(
    names.slice(0, safeLimit).map(async (name) => {
      const stem = name.replace(/\.md$/, '');
      const path = join(dir, name);
      let head = '';
      try { head = await readHead(path); } catch {}
      return { id: stem, scheduledTaskId, ranAt: parseTimestamp(stem), path, status: detectStatus(head), preview: buildPreview(head) };
    }),
  );
}

export async function getScheduledTaskRunContent(scheduledTaskId: string, runId: string): Promise<ScheduledTaskRunContent | null> {
  if (!isValidSegment(scheduledTaskId) || !isValidSegment(runId)) return null;
  const path = join(resolveOutputDir(), scheduledTaskId, `${runId}.md`);
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  return { body: extractBody(content), status: detectStatus(content) };
}
