import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandHomePrefix } from '../paths.js';

export interface BundledSkillMeta {
  id: string;
  name: string;
  description: string;
  key: string;
  source: 'Minions bundled';
  bundled: true;
  readOnly: true;
  autoIncluded: true;
}

export interface BundledSkill extends BundledSkillMeta {
  filePath: string;
}

const VALID_SKILL_ID = /^[a-z0-9][a-z0-9._-]*$/;

function serverDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

export function resolveBundledSkillsDir(): string {
  const here = serverDir();
  const candidates = [
    resolve(process.cwd(), 'skills'),
    resolve(here, '../../skills'),
    resolve(here, '../../../skills'),
    resolve(here, '../../../../skills'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseFrontmatter(content: string): Record<string, string> {
  if (!content.startsWith('---\n')) return {};
  const end = content.indexOf('\n---', 4);
  if (end === -1) return {};

  const fields: Record<string, string> = {};
  const raw = content.slice(4, end);
  for (const line of raw.split('\n')) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    fields[match[1]] = stripQuotes(match[2]);
  }
  return fields;
}

function bodyWithoutFrontmatter(content: string): string {
  if (!content.startsWith('---\n')) return content;
  const end = content.indexOf('\n---', 4);
  return end === -1 ? content : content.slice(end + 4);
}

function firstBodyLine(body: string): string {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) return trimmed;
  }
  return '';
}

function firstHeading(body: string): string | null {
  for (const line of body.split('\n')) {
    const match = /^#\s+(.+)$/.exec(line.trim());
    if (match) return match[1].trim();
  }
  return null;
}

function humanizeSkillId(id: string): string {
  return id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function parseSkillContent(id: string, filePath: string, content: string): BundledSkill {
  const frontmatter = parseFrontmatter(content);
  const body = bodyWithoutFrontmatter(content);
  const name = firstHeading(body) || humanizeSkillId(frontmatter.name || id);
  const description = frontmatter.description || firstBodyLine(body);
  return {
    id,
    name,
    description,
    key: `minions/${id}`,
    source: 'Minions bundled',
    bundled: true,
    readOnly: true,
    autoIncluded: true,
    filePath,
  };
}

export async function listBundledSkills(): Promise<BundledSkill[]> {
  const root = resolveBundledSkillsDir();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && VALID_SKILL_ID.test(entry.name))
    .map(async (entry): Promise<BundledSkill | null> => {
      const id = entry.name;
      const filePath = join(root, id, 'SKILL.md');
      try {
        const content = await readFile(filePath, 'utf-8');
        return parseSkillContent(id, filePath, content);
      } catch {
        return null;
      }
    }));

  return skills
    .filter((skill): skill is BundledSkill => skill !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getBundledSkillWithContent(id: string): Promise<{ skill: BundledSkill; content: string } | null> {
  if (!VALID_SKILL_ID.test(id)) return null;
  const root = resolveBundledSkillsDir();
  const filePath = join(root, id, 'SKILL.md');
  try {
    const content = await readFile(filePath, 'utf-8');
    return { skill: parseSkillContent(id, filePath, content), content };
  } catch {
    return null;
  }
}

export function toSkillMeta(skill: BundledSkill): BundledSkillMeta {
  const { filePath: _filePath, ...meta } = skill;
  return meta;
}

export function ensureBundledSkillsLinked(): void {
  const source = resolveBundledSkillsDir();
  if (!existsSync(source)) return;

  const hermesHome = process.env.HERMES_HOME
    ? expandHomePrefix(process.env.HERMES_HOME)
    : join(homedir(), '.hermes');
  const target = join(hermesHome, 'skills', 'minions');
  mkdirSync(dirname(target), { recursive: true });

  try {
    const stat = lstatSync(target);
    if (!stat.isSymbolicLink()) {
      console.warn(`Bundled skills not linked: ${target} already exists and is not a symlink.`);
      return;
    }

    const current = readlinkSync(target);
    const resolvedCurrent = resolve(dirname(target), current);
    if (relative(source, resolvedCurrent) === '') return;
    unlinkSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  symlinkSync(source, target, 'dir');
}
