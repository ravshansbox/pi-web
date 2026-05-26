import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN_PATH = resolve(ROOT, 'bin/pi-web.js');
const BIN_CONTENT = '#!/usr/bin/env node\nimport "../build/server/server.js";\n';

mkdirSync(dirname(BIN_PATH), { recursive: true });
writeFileSync(BIN_PATH, BIN_CONTENT, 'utf8');
chmodSync(BIN_PATH, 0o755);
