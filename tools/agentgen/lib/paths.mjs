import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** tools/agentgen/lib -> repo root */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const SDK_ROOT = join(REPO_ROOT, 'packages', 'sdk');
