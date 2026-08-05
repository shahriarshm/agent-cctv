// Must be imported BEFORE any src/ module. src/paths.js reads these environment
// variables at module load, and ESM evaluates imports in source order.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cctv-test-home-'));
process.env.AGENT_CCTV_HOME = TEST_HOME;
