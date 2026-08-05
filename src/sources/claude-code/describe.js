import path from 'node:path';
import { truncate } from '../../util.js';

/**
 * Turning a tool call into one readable line.
 *
 * This is the single most important piece of text in the product: it is what a
 * tile says the agent is doing right now, so the common tools get special cases
 * and everything else degrades to "the most string-ish argument".
 */

const VERBS = {
  Bash: 'Running',
  BashOutput: 'Watching',
  KillShell: 'Killing',
  Read: 'Reading',
  Write: 'Writing',
  Edit: 'Editing',
  NotebookEdit: 'Editing',
  Glob: 'Finding',
  Grep: 'Searching',
  WebFetch: 'Fetching',
  WebSearch: 'Searching web',
  Task: 'Delegating',
  Agent: 'Delegating',
  Skill: 'Using skill',
  TodoWrite: 'Planning',
  TaskCreate: 'Planning',
  TaskUpdate: 'Planning',
  AskUserQuestion: 'Asking you',
  Workflow: 'Orchestrating',
  ExitPlanMode: 'Presenting plan',
  ToolSearch: 'Loading tools',
};

export function toolVerb(name = '') {
  if (VERBS[name]) return VERBS[name];
  if (name.startsWith('mcp__')) return 'Calling';
  return 'Using';
}

/** `mcp__plugin_vercel_vercel__authenticate` -> `vercel: authenticate` */
export function prettyToolName(name = '') {
  if (!name.startsWith('mcp__')) return name;
  const parts = name.split('__').filter(Boolean);
  const fn = parts[parts.length - 1] || name;
  const server = (parts[1] || '').replace(/^plugin_/, '').split('_').pop();
  return server ? `${server}: ${fn}` : fn;
}

export function describeTool(name, input = {}) {
  const i = input && typeof input === 'object' ? input : {};
  const file = (p) => (p ? path.basename(String(p)) : '');

  switch (name) {
    case 'Bash':
      return truncate(i.command || i.description || '', 220);
    case 'BashOutput':
    case 'KillShell':
      return i.bash_id || i.shell_id || '';
    case 'Read':
      return file(i.file_path) + (i.offset ? `:${i.offset}` : '');
    case 'Write':
      return file(i.file_path);
    case 'Edit':
      return file(i.file_path);
    case 'NotebookEdit':
      return file(i.notebook_path || i.file_path);
    case 'Glob':
      return i.pattern || '';
    case 'Grep':
      return truncate(i.pattern || '', 80) + (i.path ? ` in ${file(i.path)}` : '');
    case 'WebFetch':
      return i.url || '';
    case 'WebSearch':
      return truncate(i.query || '', 120);
    case 'Task':
    case 'Agent':
      return i.description || truncate(i.prompt || '', 120);
    case 'Skill':
      return i.skill ? `/${i.skill}` : '';
    case 'Workflow':
      return i.name || truncate(i.description || '', 120);
    case 'TodoWrite': {
      const todos = Array.isArray(i.todos) ? i.todos : [];
      const active = todos.find((t) => t.status === 'in_progress');
      return active ? active.activeForm || active.content || '' : `${todos.length} todos`;
    }
    case 'TaskCreate':
      return truncate(i.subject || '', 120);
    case 'TaskUpdate':
      return `#${i.taskId ?? '?'}${i.status ? ` → ${i.status}` : ''}`;
    case 'AskUserQuestion':
      return truncate(i.questions?.[0]?.question || '', 140);
    case 'ExitPlanMode':
      return truncate(i.plan || '', 120);
    case 'ToolSearch':
      return truncate(i.query || '', 100);
    default: {
      const first = Object.values(i).find((v) => typeof v === 'string' && v.trim().length);
      return truncate(first || '', 140);
    }
  }
}

/** Coarse category, used for tile colour-coding. */
export function toolCategory(name = '') {
  if (['Read', 'Glob', 'Grep', 'ToolSearch', 'NotebookRead', 'LS'].includes(name)) return 'read';
  if (['Write', 'Edit', 'NotebookEdit'].includes(name)) return 'write';
  if (['Bash', 'BashOutput', 'KillShell'].includes(name)) return 'exec';
  if (['WebFetch', 'WebSearch'].includes(name) || name.startsWith('mcp__')) return 'net';
  if (['Task', 'Agent', 'Workflow', 'Skill'].includes(name)) return 'delegate';
  if (['AskUserQuestion', 'ExitPlanMode'].includes(name)) return 'ask';
  return 'other';
}
