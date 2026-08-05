import path from 'node:path';
import { truncate } from '../../util.js';

/**
 * Turning a Codex call into one readable line.
 *
 * Codex's tool surface is much narrower than Claude's — `exec` and
 * `exec_command` are the overwhelming majority of calls — but the argument is
 * harder to get at: `exec` is a *JavaScript program* that calls
 * `tools.exec_command({cmd: ...})`, not a structured input object. The tile
 * wants the shell command, so that is what we dig out.
 */

/** Pull a JSON string field out of text that may be code rather than JSON. */
function field(text, key) {
  const m = new RegExp(`"${key}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`).exec(text);
  if (!m) return '';
  try {
    return JSON.parse(m[1]);
  } catch {
    return '';
  }
}

/**
 * The first file an apply_patch touches, which is what the patch is "about".
 *
 * The header may arrive as a real multi-line patch (the apply_patch tool) or
 * embedded inside a JS string literal, where the line breaks are a literal
 * backslash-n. Stopping at either keeps the whole patch body out of the tile.
 */
const PATCH_FILE = /\*\*\* (?:Update|Add|Delete) File:[ \t]*(.+?)(?:\\n|\n|$)/g;

function patchTarget(text) {
  const files = [...text.matchAll(PATCH_FILE)];
  if (!files.length) return '';
  const first = path.basename(files[0][1].trim());
  return files.length > 1 ? `${first} +${files.length - 1}` : first;
}

/** `mcp__node_repl__js` -> `node_repl: js`, matching how Claude's marks read. */
export function prettyToolName(name = '') {
  if (!name.startsWith('mcp__')) return name;
  const parts = name.split('__').filter(Boolean);
  const fn = parts[parts.length - 1] || name;
  const server = parts[1] || '';
  return server ? `${server}: ${fn}` : fn;
}

const VERBS = {
  exec: 'Running',
  exec_command: 'Running',
  js: 'Running',
  wait: 'Waiting on',
  apply_patch: 'Patching',
  web_search: 'Searching web',
  load_workspace_dependencies: 'Loading',
};

export function verbFor(name = '') {
  if (VERBS[name]) return VERBS[name];
  if (name.startsWith('mcp__')) return 'Calling';
  return 'Using';
}

export function describeCall(name, args) {
  if (args == null) return '';
  // MCP invocations arrive as an object; everything else as a string.
  if (typeof args === 'object') {
    const o = args;
    const first = o.title || o.cmd || o.query || Object.values(o).find((v) => typeof v === 'string' && v.trim());
    return truncate(String(first || ''), 200);
  }

  const text = String(args);

  switch (name) {
    /**
     * `exec` is most of what Codex does, and its argument is a JS program
     * rather than a structured input. Three things hide in there — a shell
     * command, a patch, or a call through to another tool — and the wrapper
     * around them is boilerplate that would otherwise fill the tile with
     * `const r = await tools...`.
     */
    case 'exec': {
      const cmd = field(text, 'cmd');
      if (cmd) return truncate(cmd, 220);

      const patch = patchTarget(text);
      if (patch) return `patch ${patch}`;

      const inner = /tools\.([A-Za-z0-9_]+)\s*\(/.exec(text);
      if (inner) {
        const tool = prettyToolName(inner[1]);
        const what = field(text, 'title') || field(text, 'code') || field(text, 'query');
        return truncate(what ? `${tool} — ${what}` : tool, 200);
      }
      return truncate(text, 220);
    }

    case 'exec_command':
      return truncate(field(text, 'cmd') || text, 220);

    case 'apply_patch':
      return patchTarget(text) || truncate(text, 120);

    case 'js':
      return truncate(field(text, 'title') || field(text, 'code') || text, 200);

    case 'wait': {
      const cell = field(text, 'cell_id');
      return cell ? `cell ${cell}` : '';
    }

    default: {
      const cmd = field(text, 'cmd') || field(text, 'query') || field(text, 'title');
      if (cmd) return truncate(cmd, 200);
      return text.trim() === '{}' ? '' : truncate(text, 160);
    }
  }
}

/** Coarse category, used for the same tile colour-coding as Claude's tools. */
export function categoryFor(name = '') {
  if (name.startsWith('mcp__')) return 'net';
  switch (name) {
    case 'exec':
    case 'exec_command':
    case 'js':
    case 'wait':
      return 'exec';
    case 'apply_patch':
      return 'write';
    case 'web_search':
      return 'net';
    case 'load_workspace_dependencies':
      return 'read';
    default:
      return 'other';
  }
}
