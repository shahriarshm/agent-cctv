// Must be imported BEFORE any src/ module. src/paths.js reads these environment
// variables at module load, and ESM evaluates imports in source order.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cctv-test-home-'));
process.env.AGENT_CCTV_HOME = TEST_HOME;

// The sqlite-backed sources and gemini resolve their data directories at
// module load too. Pointed under TEST_HOME so a test that forgets to pass
// explicit roots/dbs reads an empty directory, never this machine's agents.
process.env.AGENT_CCTV_GEMINI_DIR = path.join(TEST_HOME, 'gemini');
process.env.AGENT_CCTV_OPENCODE_DIR = path.join(TEST_HOME, 'opencode');
process.env.AGENT_CCTV_HERMES_DIR = path.join(TEST_HOME, 'hermes');
