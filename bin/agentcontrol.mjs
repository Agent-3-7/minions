#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.NODE_ENV = process.env.NODE_ENV || 'production';

const here = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = resolve(here, '..', 'package.json');
const serverEntry = resolve(here, '..', 'dist', 'server', 'server', 'index.js');
const [command] = process.argv.slice(2);

function readPackageMetadata() {
  try {
    return JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch {
    return { name: 'agentcontrol', version: 'unknown' };
  }
}

if (command === '--version' || command === '-v' || command === 'version') {
  console.log(readPackageMetadata().version);
  process.exit(0);
}

if (command === '--help' || command === '-h' || command === 'help') {
  const metadata = readPackageMetadata();
  console.log(`Usage: agentcontrol [options]

${metadata.description ?? 'AgentControl for Hermes Agent'}

Options:
  -v, --version  Print the installed AgentControl version
  -h, --help     Show this help message`);
  process.exit(0);
}

if (!existsSync(serverEntry)) {
  console.error(
    `agentcontrol: built server entry not found at ${serverEntry}.\n` +
      `If you are running from a source checkout, use "npm run dev" or "npm run prod" instead.`,
  );
  process.exit(1);
}

await import(pathToFileURL(serverEntry).href);
