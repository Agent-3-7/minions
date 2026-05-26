import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppVersion } from '@shared/types';

const FALLBACK_VERSION: AppVersion = {
  name: 'AgentControl',
  version: 'unknown',
};

function readAppVersion(): AppVersion {
  let dir = dirname(fileURLToPath(import.meta.url));

  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const parsed = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };

      return {
        name: 'AgentControl',
        version: typeof parsed.version === 'string' ? parsed.version : FALLBACK_VERSION.version,
      };
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  return FALLBACK_VERSION;
}

export function getAppVersion(): AppVersion {
  return readAppVersion();
}
