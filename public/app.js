/*
  The wall. Reads one SSE stream and patches tiles in place — tiles are never
  re-created, so the activity strip only animates genuinely new events and
  keyboard focus survives updates. Ordering is done with CSS `order` for the
  same reason: nothing moves in the DOM.
*/

const token = new URLSearchParams(location.search).get('token') || '';
/*
  Read now, because establishSession() replaces the URL with a bare path once the
  cookie is established. The selection persists in localStorage from there, so a
  reload of the scrubbed URL still lands on the same view.
*/
const viewParam = new URLSearchParams(location.search).get('view');
/*
  The document request already carried the token, so the server has issued an
  HttpOnly cookie. Probe once without the token: if the cookie works we stop
  sending it entirely and scrub it from the address bar, which keeps it out of
  proxy access logs. If cookies are blocked we fall back to the query string.
*/
let useCookie = false;
/*
  Set when there is no token in the URL and the cookie probe below comes back
  401: no credential anywhere, not just a dropped connection. That is the
  bookmark-after-restart case — establishSession() scrubs the token out of the
  address bar on success, and the cookie it leaves behind is now the only way
  back in, so once it expires a bare `/` has nothing to authenticate with.
*/
let authFailed = false;
const api = (p) => (useCookie || !token ? p : p + (p.includes('?') ? '&' : '?') + 'token=' + token);

async function establishSession() {
  let probe;
  try {
    probe = await fetch('/api/state', { credentials: 'same-origin' });
  } catch {
    return; // a network hiccup, not an auth problem — connect() reports it as "signal lost"
  }
  if (token) {
    useCookie = probe.ok;
    if (useCookie) history.replaceState(null, '', location.pathname);
  } else if (probe.status === 401) {
    authFailed = true;
  }
}

const wall = document.getElementById('wall');
const link = document.getElementById('link');
const clockEl = document.getElementById('clock');
const inspector = document.getElementById('inspector');
const timelineEl = document.getElementById('timeline');
const metaEl = document.getElementById('inspector-meta');
const tasksEl = document.getElementById('inspector-tasks');
const titleEl = document.getElementById('inspector-title');

import { sourceMeta } from './icons.js';
import { shouldNotify, describe as describeAlert } from './notify.js';
import { mountViews, setViews, inView, currentView, wantedViewId } from './views.js';

const sessions = new Map();
const tiles = new Map();
const groupNodes = new Map();
/** A dashboard you leave open should come back the way you left it. */
const FILTER_KEY = 'agent-cctv:view';
const filters = Object.assign(
  { state: 'all', source: 'all', project: 'all', groupBy: 'none', notify: false },
  (() => {
    try {
      return JSON.parse(localStorage.getItem(FILTER_KEY)) || {};
    } catch {
      return {};
    }
  })()
);

function saveFilters() {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify(filters));
  } catch {}
}

let selected = null;

/* ── helpers ───────────────────────────────────────────────────────────── */

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

function shortPath(p) {
  if (!p) return '';
  return p.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

/** Agents write markdown; a tile shows plain text. Strip the syntax, keep the words. */
function plain(s) {
  if (!s) return '';
  return s
    .replace(/```[\s\S]*?```/g, ' ⟨code⟩ ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)\*([^*\n]+)\*/g, '$1$2')
    .replace(/^\s*[-*]\s+/gm, '· ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * How long it has been in this state.
 *
 * Seconds are dropped past a minute on purpose. On an instrument whose attention
 * currency is motion, a dozen tiles each rewriting "4m 32s" → "4m 33s" every
 * second is constant peripheral flicker that means nothing — and it trains you to
 * ignore exactly the kind of movement the wall uses to say something is wrong.
 * Past a minute the text changes once a minute, and motion is meaningful again.
 */
function since(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm';
}

function clockTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

function tokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1e6) return Math.round(n / 1000) + 'k';
  return (n / 1e6).toFixed(n < 1e7 ? 1 : 0) + 'M';
}

/**
 * How full the model's context is. Only the agents that record their own window
 * get a percentage — inventing a denominator would turn a real number into a
 * guess, and this one is worth trusting because it predicts a compaction.
 */
function contextLabel(u) {
  if (!u || u.context == null) return null;
  const size = tokens(u.context);
  if (!u.contextWindow) return `ctx ${size}`;
  return `ctx ${size} · ${Math.round((u.context / u.contextWindow) * 100)}%`;
}

const STATE_WORD = { busy: 'working', waiting: 'standing by', idle: 'idle', ended: 'no signal' };

function stateLabel(s) {
  if (s.urgent) return s.waitingFor || 'needs you';
  if (s.state === 'waiting') return s.waitingFor === 'input needed' ? 'your move' : s.waitingFor;
  return STATE_WORD[s.state] || s.state;
}

function rank(s) {
  if (s.urgent) return 0;
  if (s.state === 'busy') return 1;
  if (s.state === 'waiting') return 2;
  if (s.state === 'idle') return 3;
  return 4;
}

function visible(s) {
  if (!inView(s)) return false;
  if (filters.source !== 'all' && s.source !== filters.source) return false;
  if (filters.project !== 'all' && s.project !== filters.project) return false;
  if (filters.state === 'live') return s.state !== 'ended';
  if (filters.state === 'busy') return s.state === 'busy';
  if (filters.state === 'attention') return s.urgent || s.state === 'waiting';
  return true;
}

/** What each readout counts. Same predicate the button filters by, so the number
    on a button is always exactly what clicking it leaves on the wall. */
const COUNTS = {
  all: () => true,
  live: (s) => s.state !== 'ended',
  busy: (s) => s.state === 'busy',
  attention: (s) => s.urgent || s.state === 'waiting',
};

/* ── grouping ──────────────────────────────────────────────────────────── */

const GROUP_STATE = {
  attention: 'Needs you',
  busy: 'Working',
  waiting: 'Standing by',
  idle: 'Idle',
  ended: 'No signal',
};

/**
 * Ways to carve up the wall. Each returns a stable key per session; groups are
 * then ordered by their most urgent member, so whichever group contains a
 * blocked session is always the one at the top.
 */
const GROUPS = {
  none: null,
  project: { keyOf: (s) => s.project || 'unknown', labelOf: (v) => v },
  agent: { keyOf: (s) => s.source || 'unknown', labelOf: (v) => sourceMeta(v).label },
  state: { keyOf: (s) => (s.urgent ? 'attention' : s.state), labelOf: (v) => GROUP_STATE[v] || v },
  branch: { keyOf: (s) => s.gitBranch || 'no branch', labelOf: (v) => v },
};

/* ── tiles ─────────────────────────────────────────────────────────────── */

function buildTile(s) {
  const tile = el('article', 'tile');
  tile.tabIndex = 0;
  tile.setAttribute('role', 'button');

  const head = el('div', 'tile-head');
  const mark = el('i', 'agent-mark');
  const name = el('div', 'tile-name');
  const tag = el('div', 'state-tag');
  const tagWord = el('span', 'word');
  const tagDur = el('span', 'dur');
  tag.append(tagWord, tagDur);
  head.append(mark, name, el('div', 'tile-head-spacer'), tag);

  const body = el('div', 'tile-body');
  const title = el('h3', 'tile-title');
  const doing = el('div', 'doing');
  const verb = el('span', 'doing-verb');
  const arg = el('span', 'doing-arg');
  doing.append(verb, arg);
  const says = el('p', 'says');
  body.append(title, doing, says);

  const strip = el('div', 'strip');

  const foot = el('div', 'tile-foot');
  const where = el('div', 'where');
  const counts = el('div', 'counts');
  foot.append(where, counts);

  tile.append(head, body, strip, foot);

  tile._refs = { mark, name, tag, tagWord, tagDur, title, doing, verb, arg, says, strip, where, counts };
  tile._ticks = new Set();

  const open = () => openInspector(s.id);
  tile.addEventListener('click', open);
  tile.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });
  return tile;
}

function paintTile(tile, s) {
  const r = tile._refs;
  tile.dataset.state = s.state;
  tile.dataset.urgent = String(!!s.urgent);
  tile.dataset.selected = String(selected === s.id);
  tile.hidden = !visible(s);

  const meta = sourceMeta(s.source);
  if (r.mark.dataset.source !== s.source) {
    r.mark.dataset.source = s.source || '';
    r.mark.innerHTML = meta.icon; // static, from SOURCES — never session data
    r.mark.title = meta.label;
  }

  r.name.textContent = s.name;
  r.name.title = `${meta.label} · ${s.id}`;
  r.tagWord.textContent = stateLabel(s);
  r.tagDur.textContent = since(s.stateSince);
  r.tag.dataset.ts = s.stateSince;

  // Without this the tile's accessible name is every word inside it.
  tile.setAttribute('aria-label', `${s.name}, ${stateLabel(s)}, ${meta.label}`);

  r.title.textContent = plain(s.title || s.lastPrompt) || '—';

  // One line for what it's doing: the running tool, or what it's waiting on,
  // or the task it's working through.
  if (s.currentTool) {
    r.doing.hidden = false;
    r.verb.textContent = `▸ ${s.currentTool.pretty || s.currentTool.name}`;
    r.arg.textContent = s.currentTool.detail || '';
    r.arg.title = s.currentTool.detail || '';
  } else if (s.state === 'waiting') {
    r.doing.hidden = false;
    r.verb.textContent = '▸ waiting on you';
    r.arg.textContent = s.waitingFor || '';
  } else if (s.taskSummary?.active) {
    r.doing.hidden = false;
    r.verb.textContent = '▸ task';
    r.arg.textContent = s.taskSummary.active;
    r.arg.title = s.taskSummary.active;
  } else {
    r.doing.hidden = true;
  }

  const said = plain(s.lastText || s.lastThinking);
  r.says.hidden = said.length < 2;
  r.says.textContent = said;

  r.where.textContent = shortPath(s.cwd);
  r.where.title = s.cwd;

  r.counts.replaceChildren();
  if (s.gitBranch && s.gitBranch !== 'HEAD') r.counts.append(el('span', 'branch', s.gitBranch));
  if (s.taskSummary) {
    r.counts.append(el('span', null, `${s.taskSummary.done}/${s.taskSummary.total} done`));
  }
  r.counts.append(el('span', null, `${s.stats.tools} tools`));
  if (s.stats.errors) r.counts.append(el('span', 'bad', `${s.stats.errors} failed`));
  if (s.subagentsActive) r.counts.append(el('span', null, `${s.subagentsActive} sub`));

  const ctx = contextLabel(s.usage);
  if (ctx) {
    const node = el('span', 'ctx', ctx);
    // A session near its window is about to compact, which is worth seeing
    // coming. Without a recorded window there is nothing to be near.
    let pressure = '';
    if (s.usage.contextWindow) {
      const pct = s.usage.context / s.usage.contextWindow;
      if (pct >= 0.9) {
        node.dataset.pressure = 'high';
        pressure = ' · about to compact';
      } else if (pct >= 0.75) {
        node.dataset.pressure = 'warm';
        pressure = ' · nearing its window';
      }
    }
    // The tint is the warning, and a tint is the one thing some people cannot
    // read. Say it in the tooltip too.
    node.title = `${s.usage.context.toLocaleString()} tokens in context${pressure}`;
    r.counts.append(node);
  }

  paintStrip(tile, s.events || []);
}

function paintStrip(tile, events) {
  const strip = tile._refs.strip;
  for (const ev of events) {
    if (tile._ticks.has(ev.id)) continue;
    tile._ticks.add(ev.id);
    const tick = el('i', 'tick');
    tick.dataset.kind = ev.kind;
    if (ev.tool?.category) tick.dataset.cat = ev.tool.category;
    if (ev.tool?.ok === false) tick.dataset.error = 'true';
    tick.title = `${clockTime(ev.ts)}  ${ev.label}${ev.detail ? ' — ' + ev.detail.slice(0, 80) : ''}`;
    strip.append(tick);
  }
  // Enough ticks to fill the lane at any tile width — the old cap of 64 left a
  // permanent gap on the left that read as an unfinished chart. `overflow: hidden`
  // does the visual clipping; this keeps the DOM bounded on a long session.
  while (strip.childElementCount > 120) strip.removeChild(strip.firstElementChild);
}

function upsert(s) {
  const prev = sessions.get(s.id);
  sessions.set(s.id, s);
  alertFor(prev, s);
  let tile = tiles.get(s.id);
  if (!tile) {
    tile = buildTile(s);
    tiles.set(s.id, tile);
    wall.append(tile);
  }
  paintTile(tile, s);
  layout();
  paintStats();
  refreshFilterOptions();
  if (selected === s.id) renderInspectorMeta(s);
}

function remove(id) {
  tiles.get(id)?.remove();
  tiles.delete(id);
  sessions.delete(id);
  dismissAlert(id);
  if (selected === id) closeInspector();
  layout();
  paintStats();
  refreshFilterOptions();
}

/* ── alerts ────────────────────────────────────────────────────────────── */

/**
 * The wall only helps if you are looking at it. An alert is the same signal —
 * a session blocked on a permission prompt — delivered when you are not.
 *
 * Held handles, one per session: a session that flaps replaces its own
 * notification rather than stacking, and answering the prompt in the terminal
 * takes the alert away instead of leaving a stale one behind.
 */
const alerts = new Map();
/** The first snapshot is the wall arriving, not sessions going wrong. */
let booted = false;

function canAlert() {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

const announceEl = document.getElementById('announce');

function alertFor(prev, next) {
  if (!next.urgent) return dismissAlert(next.id);
  if (!booted) return;
  /*
    Scoped to the view's population, never to what is on screen: sitting on the
    "working" filter must still tell you when a session leaves it for blocked —
    that transition is the only thing this alert exists for.
  */
  if (!inView(next)) return;
  if (!shouldNotify(prev, next)) return;

  // Spoken whether or not desktop alerts are armed: the wall is not narrated, so
  // this transition is the only thing a screen reader ever hears from it.
  announceEl.textContent = `${next.name} needs you — ${next.waitingFor || 'blocked'}`;

  if (!filters.notify || !canAlert()) return;
  const { title, body, tag } = describeAlert(next);
  try {
    const note = new Notification(title, { body, tag });
    note.onclick = () => {
      window.focus();
      openInspector(next.id);
      note.close();
    };
    alerts.set(next.id, note);
  } catch {}
}

function dismissAlert(id) {
  const note = alerts.get(id);
  if (!note) return;
  alerts.delete(id);
  try {
    note.close();
  } catch {}
}

function buildGroup() {
  const section = el('section', 'group');
  const head = el('div', 'group-head');
  const mark = el('i', 'agent-mark');
  const label = el('h2', 'group-label');
  const count = el('span', 'group-count');
  head.append(mark, label, count);
  const grid = el('div', 'group-grid');
  section.append(head, grid);
  section._refs = { mark, label, count, grid };
  return section;
}

function paintGroupHead(section, key, label, members) {
  const r = section._refs;
  r.label.textContent = label;

  const need = members.filter((s) => s.urgent).length;
  const busy = members.filter((s) => s.state === 'busy').length;
  const parts = [`${members.length} feed${members.length === 1 ? '' : 's'}`];
  if (need) parts.push(`${need} need${need === 1 ? 's' : ''} you`);
  if (busy) parts.push(`${busy} working`);
  r.count.textContent = parts.join(' · ');
  r.count.dataset.urgent = String(need > 0);

  // The agent mark only means something when the groups are agents.
  const isAgent = filters.groupBy === 'agent';
  r.mark.hidden = !isAgent;
  if (isAgent && r.mark.dataset.source !== key) {
    r.mark.dataset.source = key;
    r.mark.innerHTML = sourceMeta(key).icon;
  }
}

/**
 * Places every tile. Flat mode leaves tiles as direct children of the wall and
 * sorts with CSS `order` so nothing moves in the DOM; grouped mode has to move
 * them, but tiles are reused rather than rebuilt, so their activity strips keep
 * their history.
 */
function layout() {
  for (const [id, tile] of tiles) tile.hidden = !visible(sessions.get(id));

  const shown = [...sessions.values()]
    .filter(visible)
    .sort((a, b) => rank(a) - rank(b) || b.lastActivityAt - a.lastActivityAt);

  const grouping = GROUPS[filters.groupBy];
  wall.dataset.grouped = String(!!grouping);

  if (!grouping) {
    for (const node of groupNodes.values()) node.remove();
    groupNodes.clear();
    shown.forEach((s, i) => {
      const tile = tiles.get(s.id);
      if (tile) tile.style.order = String(i);
    });
    for (const tile of tiles.values()) if (tile.parentElement !== wall) wall.append(tile);
    renderEmpty();
    return;
  }

  const buckets = new Map();
  for (const s of shown) {
    const key = grouping.keyOf(s);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(s);
  }

  const order = [...buckets.keys()].sort((a, b) => {
    const ra = Math.min(...buckets.get(a).map(rank));
    const rb = Math.min(...buckets.get(b).map(rank));
    return ra - rb || String(a).localeCompare(String(b));
  });

  order.forEach((key, gi) => {
    let section = groupNodes.get(key);
    if (!section) {
      section = buildGroup();
      groupNodes.set(key, section);
    }
    if (wall.children[gi] !== section) wall.insertBefore(section, wall.children[gi] || null);

    const members = buckets.get(key);
    paintGroupHead(section, key, grouping.labelOf(key), members);

    const grid = section._refs.grid;
    members.forEach((s, i) => {
      const tile = tiles.get(s.id);
      if (!tile) return;
      tile.style.order = '';
      if (grid.children[i] !== tile) grid.insertBefore(tile, grid.children[i] || null);
    });
    while (grid.childElementCount > members.length) grid.removeChild(grid.lastElementChild);
  });

  for (const [key, section] of groupNodes) {
    if (!buckets.has(key)) {
      section.remove();
      groupNodes.delete(key);
    }
  }

  // Tiles filtered out have no group; park them on the wall (they stay hidden).
  for (const [id, tile] of tiles) {
    if (tile.hidden && tile.parentElement && tile.parentElement !== wall) wall.append(tile);
  }

  renderEmpty();
}

let emptyNode = null;

/**
 * Nothing on the wall means one of four different things, and saying the wrong
 * one is a small lie the reader has no way to check: before the first snapshot we
 * simply have not looked yet, which is not the same as "you have no sessions",
 * which is not the same as "your filters exclude them all" — and none of those
 * is "you have no credential", which never resolves on its own.
 */
function emptyCopy() {
  if (authFailed) {
    return [
      'No credential',
      'This link has no token and the saved one is gone. Reopen the link your operator gave you.',
    ];
  }
  if (!booted) return ['Connecting', 'Reading what every agent on this machine is doing.'];
  if (filters.state === 'all' && filters.source === 'all' && filters.project === 'all') {
    const view = currentView();
    if (view.id !== 'all') {
      return [
        'Nothing in this view',
        `No session matches ${view.name} right now. Switch to Everything for the whole wall.`,
      ];
    }
    return [
      'No feeds',
      'Start a Claude Code or Codex session in any terminal and it appears here. Nothing to install, nothing to restart.',
    ];
  }
  return [
    'Nothing matches',
    'No session matches these filters right now. History has the ones that have already finished.',
  ];
}

function renderEmpty() {
  const shown = [...sessions.values()].filter(visible).length;
  if (shown > 0) {
    emptyNode?.remove();
    emptyNode = null;
    return;
  }
  const [head, body] = emptyCopy();
  // Rebuilt rather than kept, so "Connecting" is replaced the moment the wall
  // arrives empty rather than sitting there forever.
  if (emptyNode?.dataset.head === head) return;
  emptyNode?.remove();
  emptyNode = el('div', 'empty');
  emptyNode.dataset.head = head;
  emptyNode.append(el('h2', null, head), el('p', null, body));
  wall.append(emptyNode);
}

function paintStats() {
  // Counted within the view: a button's figure must stay exactly what clicking
  // it leaves on the wall.
  const all = [...sessions.values()].filter(inView);
  for (const [key, match] of Object.entries(COUNTS)) {
    document.getElementById(`stat-${key}`).textContent = all.filter(match).length;
  }

  // "Need you" is the number the wall exists to surface, so it is the only one
  // allowed to change colour — and only while there is something to say.
  const need = all.filter((s) => s.urgent).length;
  document.querySelector('.readout[data-kind="attention"]').dataset.hot = String(need > 0);

  const live = all.filter(COUNTS.live).length;
  document.title = need ? `(${need}) agent-cctv` : live ? `${live} · agent-cctv` : 'agent-cctv';
}

/* ── inspector ─────────────────────────────────────────────────────────── */

const scrim = document.getElementById('scrim');
const closeBtn = document.getElementById('inspector-close');
/** Where focus was when the drawer opened, so it can be handed back. */
let returnFocus = null;

/**
 * The drawer is a modal, and used not to know it: no backdrop, no scroll lock, and
 * Tab walked the wall behind it. Open-ness lives on the element rather than in
 * `selected`, because an archived session opens the drawer with nothing selected —
 * which is why Escape used to do nothing in the archive.
 */
function openDrawer() {
  returnFocus = document.activeElement;
  inspector.dataset.open = 'true';
  scrim.dataset.open = 'true';
  document.body.dataset.locked = 'true';
  closeBtn.focus();
}

async function openInspector(id) {
  selected = id;
  openDrawer();
  for (const [tid, tile] of tiles) tile.dataset.selected = String(tid === id);
  const s = sessions.get(id);
  if (s) renderInspectorMeta(s);
  try {
    const res = await fetch(api(`/api/session/${encodeURIComponent(id)}`));
    if (!res.ok) return;
    const detail = await res.json();
    renderInspectorMeta(detail);
    renderTasks(detail.tasks);
    renderTimeline(detail.events || []);
  } catch {}
}

function closeInspector() {
  if (inspector.dataset.open !== 'true') return;
  selected = null;
  inspector.dataset.open = 'false';
  scrim.dataset.open = 'false';
  delete document.body.dataset.locked;
  for (const tile of tiles.values()) tile.dataset.selected = 'false';
  // Only if it is still on the page — the tile may have been retired meanwhile.
  if (returnFocus?.isConnected) returnFocus.focus();
  returnFocus = null;
}

/** Tab must not escape into the wall behind the scrim. */
function trapFocus(e) {
  if (e.key !== 'Tab' || inspector.dataset.open !== 'true') return;
  const stops = inspector.querySelectorAll('button, [href], select, textarea, input, [tabindex]:not([tabindex="-1"])');
  if (!stops.length) return;
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function renderInspectorMeta(s) {
  titleEl.textContent = plain(s.title) || s.name;
  const meta = sourceMeta(s.source);
  document.getElementById('inspector-mark').innerHTML = meta.icon;
  const rows = [
    // A past session's "how long ago" is when it stopped, not when we read it.
    ['status', s.historical ? `archived · last active ${new Date(s.endedAt).toLocaleString()}` : `${stateLabel(s)} · ${since(s.stateSince)}`],
    ['agent', meta.label + (s.agentName ? ` · ${s.agentName}` : '')],
    ['channel', s.name],
    ['where', shortPath(s.cwd)],
    ['branch', s.gitBranch],
    ['model', s.model],
    ['process', s.process?.pid ? `pid ${s.process.pid}` : 'not running'],
    ['mode', s.permissionMode],
    ['claude', s.version],
    ['session', s.id],
    ['work', `${s.stats.tools} tools · ${s.stats.turns} turns · ${s.stats.errors} failed`],
    ['context', contextUsage(s.usage)],
    ['output', outputUsage(s.usage)],
  ].filter(([, v]) => v);

  metaEl.replaceChildren();
  for (const [k, v] of rows) {
    metaEl.append(el('dt', null, k), el('dd', null, String(v)));
  }
}

function contextUsage(u) {
  if (!u || u.context == null) return null;
  const n = u.context.toLocaleString();
  return u.contextWindow
    ? `${n} of ${u.contextWindow.toLocaleString()} (${Math.round((u.context / u.contextWindow) * 100)}%)`
    : n;
}

/**
 * Output is a sum, so say plainly when it is a partial one. A transcript picked
 * up mid-file has real tokens behind it that we never saw, and quietly showing
 * the short number as a total would be the one dishonest thing on this panel.
 */
function outputUsage(u) {
  if (!u || u.output == null) return null;
  return u.output.toLocaleString() + (u.outputPartial ? ' (since watching)' : '');
}

function renderTasks(tasks) {
  if (!tasks?.length) {
    tasksEl.hidden = true;
    return;
  }
  tasksEl.hidden = false;
  tasksEl.replaceChildren();
  for (const t of tasks) {
    const row = el('div', 'task-row');
    row.dataset.status = t.status;
    const mark = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '·';
    row.append(el('span', 'mark', mark), el('span', 'body', t.subject));
    tasksEl.append(row);
  }
}

/** How long a tool took. Sub-second calls don't get one — a read that finished in
    40ms is not news, and printing it on every row buries the one that took 90s. */
function took(ms) {
  if (ms == null || ms < 1000) return '';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  const s = Math.round(ms / 1000);
  return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
}

/**
 * The row for one event. Built once and repainted in place, because a tool call's
 * row has to survive its own completion — see `foldTools`.
 */
function buildEntry(ev) {
  const entry = el('div', 'entry');
  entry.dataset.lane = ev.lane || 'main';
  entry.dataset.id = ev.id;
  entry.dataset.time = clockTime(ev.ts);
  const time = el('time', null, clockTime(ev.ts));
  time.dateTime = new Date(ev.ts).toISOString();
  const col = el('div');
  const head = el('div', 'label');
  col.append(head, el('div', 'detail'));
  entry.append(time, col);
  entry._refs = { label: head, detail: col.lastElementChild };
  paintEntry(entry, ev);
  return entry;
}

function paintEntry(entry, ev) {
  const { label, detail } = entry._refs;
  entry.dataset.kind = ev.kind;
  entry.dataset.error = String(ev.tool?.ok === false);
  if (ev.tool?.id) entry.dataset.tool = ev.tool.id;
  // 'start' means still in flight, which is what earns the amber label.
  entry.dataset.phase = ev.tool?.phase || '';

  label.replaceChildren(document.createTextNode(ev.label));
  const t = took(ev.tool?.durationMs);
  if (t) label.append(el('span', 'took', t));

  const prose = ev.kind === 'assistant_text' || ev.kind === 'thinking' || ev.kind === 'prompt';
  detail.hidden = !ev.detail;
  detail.textContent = ev.detail ? (prose ? plain(ev.detail) : ev.detail) : '';
}

/**
 * One row per tool call, not two.
 *
 * A tool emits `tool_start` and later `tool_end`, and the pair carries the same
 * `tool.id` *and the same detail string* — so a busy turn rendered as stacks of
 * near-identical rows with the whole command printed twice, once under "Running
 * Bash" and again under "Bash done". They are one thing that happened, so they are
 * one row: it appears when the call starts, and is completed in place — label,
 * outcome, duration — when the result lands.
 *
 * A `tool_end` with no matching start still gets its own row. Codex emits some of
 * those with no start at all, and inventing a call we never saw would be worse
 * than showing the result on its own.
 */
function foldTools(events) {
  const out = [];
  const open = new Map();
  for (const ev of events) {
    const id = ev.tool?.id;
    if (ev.kind === 'tool_end' && id != null && open.has(id)) {
      const at = open.get(id);
      open.delete(id);
      out[at] = mergeToolPair(out[at], ev);
      continue;
    }
    if (ev.kind === 'tool_start' && id != null) open.set(id, out.length);
    out.push(ev);
  }
  return out;
}

/** The row keeps the start's identity and position — it is the call, and the call
    happened when it began — and takes everything it learned from the result. */
function mergeToolPair(start, end) {
  return { ...end, id: start.id, ts: start.ts, detail: end.detail || start.detail };
}

/**
 * A tool call and its result land in the same second, so a busy turn renders as a
 * column of six identical timestamps. Only the first of a run is printed at full
 * strength; the repeats stay in place for alignment but fade back, which is what
 * lets you see where a turn actually began.
 */
function renderTimeline(events) {
  timelineEl.replaceChildren();
  let above = null;
  // Folded before the slice, so a call is never cut off from its own result.
  for (const ev of foldTools(events).slice(-120).reverse()) {
    const entry = buildEntry(ev);
    if (above && above.dataset.time === entry.dataset.time) entry.dataset.repeat = 'true';
    timelineEl.append(entry);
    above = entry;
  }
}

/** The row this result belongs to, if its call is still on screen. */
function openCall(ev) {
  const id = ev.tool?.id;
  if (ev.kind !== 'tool_end' || id == null) return null;
  return timelineEl.querySelector(`.entry[data-phase="start"][data-tool="${CSS.escape(String(id))}"]`);
}

/** Newest first, so a live event goes on top rather than triggering a refetch. */
function prependEntry(ev) {
  // A result completes the row its call already made rather than adding a second
  // one — the live path has to fold exactly like `renderTimeline` does.
  const running = openCall(ev);
  if (running) {
    // The row keeps its own id and position; only what the result taught us
    // changes. A result with no detail of its own keeps the call's.
    return paintEntry(running, {
      ...ev,
      id: running.dataset.id,
      detail: ev.detail || running._refs.detail.textContent,
    });
  }

  if (timelineEl.querySelector(`[data-id="${CSS.escape(ev.id)}"]`)) return;
  const entry = buildEntry(ev);
  const below = timelineEl.firstElementChild;
  // The newest event is never the repeat; the one it lands on top of becomes one.
  if (below && below.dataset.time === entry.dataset.time) below.dataset.repeat = 'true';
  timelineEl.prepend(entry);
  while (timelineEl.childElementCount > 200) timelineEl.removeChild(timelineEl.lastElementChild);
}

closeBtn.addEventListener('click', closeInspector);
scrim.addEventListener('click', closeInspector);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeInspector();
  trapFocus(e);
});

/* ── archive ───────────────────────────────────────────────────────────── */

/**
 * Sessions that have already left the wall.
 *
 * The wall stays a live instrument — this does not keep tiles around longer or
 * store anything. It reads the agents' own logs, which are already on disk, one
 * session at a time and only when you ask for one.
 */
const archive = document.getElementById('archive');
const archiveList = document.getElementById('archive-list');
const archiveCount = document.getElementById('archive-count');
const archiveDays = document.getElementById('archive-days');
const archiveToggle = document.getElementById('archive-toggle');

function bytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Today';
  const yesterday = new Date(today.getTime() - 864e5);
  if (same(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

async function loadArchive() {
  archiveList.replaceChildren(el('div', 'archive-empty', 'Reading…'));
  let data;
  try {
    const res = await fetch(api(`/api/history?days=${archiveDays.value}`));
    if (!res.ok) throw new Error('failed');
    data = await res.json();
  } catch {
    archiveList.replaceChildren(el('div', 'archive-empty', 'Could not read the archive.'));
    return;
  }

  archiveCount.textContent = data.total
    ? `${data.total} session${data.total === 1 ? '' : 's'}${data.truncated ? ` · showing ${data.sessions.length}` : ''}`
    : '';

  if (!data.sessions.length) {
    archiveList.replaceChildren(
      el('div', 'archive-empty', 'Nothing finished in this window. Sessions still running are on the wall.')
    );
    return;
  }

  archiveList.replaceChildren();
  let currentDay = null;
  for (const s of data.sessions) {
    const day = dayLabel(s.endedAt);
    if (day !== currentDay) {
      currentDay = day;
      archiveList.append(el('div', 'archive-day', day));
    }

    const row = el('button', 'archive-row');
    row.type = 'button';

    const mark = el('i', 'agent-mark');
    mark.innerHTML = sourceMeta(s.source).icon; // static, from SOURCES
    mark.title = sourceMeta(s.source).label;

    const time = el('time', 'archive-time', clockTime(s.endedAt));
    time.dateTime = new Date(s.endedAt).toISOString();

    const title = el('span', 'archive-title', plain(s.title) || s.name);
    const where = el('span', 'archive-where', s.project || '');
    const meta = el('span', 'archive-meta', [s.gitBranch, bytes(s.bytes)].filter(Boolean).join(' · '));

    row.append(time, mark, title, where, meta);
    row.addEventListener('click', () => openHistory(s.id));
    archiveList.append(row);
  }
}

async function openHistory(id) {
  // A past session is not on the wall, so nothing is selected — the inspector
  // is just the viewer.
  selected = null;
  for (const tile of tiles.values()) tile.dataset.selected = 'false';
  openDrawer();
  titleEl.textContent = 'Reading…';
  metaEl.replaceChildren();
  tasksEl.hidden = true;
  timelineEl.replaceChildren();

  try {
    const res = await fetch(api(`/api/history/${encodeURIComponent(id)}`));
    if (!res.ok) {
      titleEl.textContent = 'That session is no longer readable.';
      return;
    }
    const detail = await res.json();
    renderInspectorMeta(detail);
    renderTasks(detail.tasks);
    renderTimeline(detail.events || []);
  } catch {
    titleEl.textContent = 'Could not read that session.';
  }
}

function showArchive(on) {
  archive.hidden = !on;
  wall.hidden = on;
  archiveToggle.setAttribute('aria-pressed', String(on));
  // The agent/project/group-by selects only steer the wall. Dimming them in the
  // archive beats leaving three live-looking controls that do nothing.
  document.getElementById('masthead').dataset.mode = on ? 'archive' : 'wall';
  if (on) loadArchive();
}

archiveToggle.addEventListener('click', () => showArchive(archive.hidden));
document.getElementById('archive-close').addEventListener('click', () => showArchive(false));
archiveDays.addEventListener('change', loadArchive);

/* ── filters, clock ────────────────────────────────────────────────────── */

const sourceSel = document.getElementById('pick-source');
const projectSel = document.getElementById('pick-project');

function applyFilters() {
  saveFilters();
  layout();
}

/**
 * The selects only ever offer values that exist on the wall right now. A filter
 * whose value disappears falls back to "all" rather than showing nothing.
 */
function refreshFilterOptions() {
  const all = [...sessions.values()].filter(inView);

  const build = (select, key, values, labelFor) => {
    const counts = new Map();
    for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
    const wanted = ['all', ...[...counts.keys()].sort()];
    const current = [...select.options].map((o) => o.value);
    if (current.join('\0') !== wanted.join('\0')) {
      select.replaceChildren();
      for (const v of wanted) {
        const label = v === 'all' ? `all (${values.length})` : `${labelFor(v)} (${counts.get(v)})`;
        const opt = el('option', null, label);
        opt.value = v;
        select.append(opt);
      }
    } else {
      for (const opt of select.options) {
        opt.textContent =
          opt.value === 'all' ? `all (${values.length})` : `${labelFor(opt.value)} (${counts.get(opt.value)})`;
      }
    }
    if (!wanted.includes(filters[key])) filters[key] = 'all';
    select.value = filters[key];
  };

  build(sourceSel, 'source', all.map((s) => s.source).filter(Boolean), (v) => sourceMeta(v).label);
  build(projectSel, 'project', all.map((s) => s.project).filter(Boolean), (v) => v);
}

sourceSel.addEventListener('change', () => {
  filters.source = sourceSel.value;
  applyFilters();
});

projectSel.addEventListener('change', () => {
  filters.project = projectSel.value;
  applyFilters();
});

/**
 * Browsers only grant notification permission from inside a user gesture, so
 * this is a click and not a preference toggle somewhere quiet.
 */
const bell = document.getElementById('bell');
const bellLabel = document.getElementById('bell-label');

function paintBell() {
  const supported = typeof Notification !== 'undefined';
  const perm = supported ? Notification.permission : 'denied';
  const state = !supported ? 'unsupported' : perm === 'denied' ? 'blocked' : filters.notify ? 'on' : 'off';

  bell.dataset.state = state;
  bell.setAttribute('aria-pressed', String(state === 'on'));
  // aria-disabled, not disabled: a disabled button is unfocusable, which puts the
  // one thing that explains *why* it is off — the title — out of reach of the
  // keyboard and the screen reader that most need it.
  bell.setAttribute('aria-disabled', String(state === 'unsupported' || state === 'blocked'));
  bellLabel.textContent = state === 'blocked' ? 'Alerts blocked' : 'Alerts';
  bell.title =
    state === 'unsupported'
      ? 'This browser has no notification support'
      : state === 'blocked'
        ? 'Your browser is blocking notifications for this page — allow them in site settings'
        : state === 'on'
          ? 'Notifying you when a session needs you. Click to stop.'
          : 'Notify me when a session needs you';
}

bell.addEventListener('click', async () => {
  if (typeof Notification === 'undefined') return;
  if (bell.getAttribute('aria-disabled') === 'true') return;
  if (filters.notify) {
    filters.notify = false;
  } else {
    let perm = Notification.permission;
    if (perm === 'default') {
      try {
        perm = await Notification.requestPermission();
      } catch {
        perm = 'denied';
      }
    }
    filters.notify = perm === 'granted';
  }
  saveFilters();
  paintBell();
});

paintBell();

const groupSel = document.getElementById('pick-group');
groupSel.value = filters.groupBy;
groupSel.addEventListener('change', () => {
  filters.groupBy = groupSel.value;
  applyFilters();
});

/* ── state filter ──────────────────────────────────────────────────────── */

const readouts = [...document.querySelectorAll('.readout')];

function paintReadouts() {
  for (const b of readouts) b.setAttribute('aria-pressed', String(b.dataset.filter === filters.state));
}

for (const btn of readouts) {
  btn.addEventListener('click', () => {
    filters.state = btn.dataset.filter;
    paintReadouts();
    applyFilters();
  });
}

paintReadouts();

/* ── theme ─────────────────────────────────────────────────────────────── */

/**
 * Three settings, one button: follow the system, or override it either way. The
 * resolved look is applied to <html> by the inline script in index.html before
 * first paint; this only has to keep it in sync afterwards.
 */
const THEMES = ['auto', 'light', 'dark'];
const THEME_ICON = {
  auto: '<path d="M12 3v18M12 3a9 9 0 0 1 0 18"/><circle cx="12" cy="12" r="9"/>',
  light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>',
  dark: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/>',
};
const THEME_LABEL = { auto: 'Auto', light: 'Light', dark: 'Dark' };

const themeBtn = document.getElementById('theme');
const themeIcon = document.getElementById('theme-icon');
const themeLabel = document.getElementById('theme-label');
const systemLight = matchMedia('(prefers-color-scheme: light)');

function applyTheme() {
  const pref = filters.theme || 'auto';
  const dark = pref === 'auto' ? !systemLight.matches : pref === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  themeIcon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${THEME_ICON[pref]}</svg>`;
  themeLabel.textContent = THEME_LABEL[pref];
  themeBtn.title =
    pref === 'auto'
      ? `Following your system, currently ${dark ? 'dark' : 'light'}. Click for light.`
      : `${THEME_LABEL[pref]} theme. Click for ${pref === 'light' ? 'dark' : 'auto'}.`;
}

themeBtn.addEventListener('click', () => {
  filters.theme = THEMES[(THEMES.indexOf(filters.theme || 'auto') + 1) % THEMES.length];
  saveFilters();
  applyTheme();
});

systemLight.addEventListener('change', () => {
  if ((filters.theme || 'auto') === 'auto') applyTheme();
});

applyTheme();

setInterval(() => {
  clockEl.textContent = new Date().toLocaleTimeString([], { hour12: false });
  for (const tile of tiles.values()) {
    const { tag, tagDur } = tile._refs;
    if (tag.dataset.ts) tagDur.textContent = since(Number(tag.dataset.ts));
  }
}, 1000);

/* ── stream ────────────────────────────────────────────────────────────── */

function connect() {
  if (authFailed) {
    // No point opening an EventSource that will just 401 and retry forever —
    // and "signal lost" would tell the user the wrong thing to try (wait for
    // the network) instead of the right one (reopen the link).
    link.dataset.up = 'false';
    link.textContent = 'no credential';
    link.title = 'Reopen the link your operator gave you — it carries the token this page needs.';
    document.body.dataset.stale = 'true';
    layout(); // repaint the empty card now instead of leaving "Connecting" up forever
    return;
  }

  const es = new EventSource(api('/api/stream'));

  es.addEventListener('open', () => {
    link.dataset.up = 'true';
    link.dataset.stale = 'false';
    link.textContent = 'live';
    delete document.body.dataset.stale;
  });

  /**
   * A dropped stream used to be an 11px whisper in the corner while every lamp
   * kept glowing and every duration kept counting up. That is the worst thing a
   * monitoring instrument can do: present a remembered picture as a live one. The
   * wall greys out until the stream is back, so what you are looking at is
   * unmistakably a freeze frame.
   */
  es.addEventListener('error', () => {
    link.dataset.up = 'false';
    link.textContent = 'signal lost';
    // Not on the very first connect — that is "connecting", not "went stale".
    if (booted) {
      link.dataset.stale = 'true';
      document.body.dataset.stale = 'true';
    }
  });

  es.addEventListener('snapshot', (e) => {
    const data = JSON.parse(e.data);
    for (const id of [...sessions.keys()]) {
      if (!data.sessions.some((s) => s.id === id)) remove(id);
    }
    for (const s of data.sessions) upsert(s);
    // From here on a snapshot is a reconnect, and diffing it against the tiles
    // that survived is what catches a session that blocked while you were away.
    booted = true;
    // An empty first snapshot never reaches upsert, so nothing else would clear
    // the "Connecting" card.
    layout();
  });

  es.addEventListener('session', (e) => upsert(JSON.parse(e.data)));

  es.addEventListener('activity', (e) => {
    const ev = JSON.parse(e.data);
    const tile = tiles.get(ev.sessionId);
    if (tile) paintStrip(tile, [ev]);
    if (selected === ev.sessionId) prependEntry(ev);
  });

  es.addEventListener('removed', (e) => remove(JSON.parse(e.data).id));

  es.addEventListener('views', (e) => {
    const before = currentView().id;
    const view = setViews(JSON.parse(e.data));
    // Only a genuine switch — the selected view was deleted — re-seeds group-by.
    applyView(view, { seedGroup: view.id !== before });
  });
}

/* ── views ─────────────────────────────────────────────────────────────── */

/**
 * A view seeds the group-by select on *switching to it*, and only then —
 * editing some other view file must not throw away a group-by you set by hand.
 * Nothing here is ever written back to the file.
 */
function applyView(view, { seedGroup = true } = {}) {
  // The id asked for, not the one resolved to — a view that is momentarily
  // missing must not overwrite the preference with "Everything".
  filters.view = wantedViewId();
  if (seedGroup && view.groupBy) {
    filters.groupBy = view.groupBy;
    groupSel.value = view.groupBy;
  }
  saveFilters();
  refreshFilterOptions();
  layout();
  paintStats();
}

async function loadViewCatalog() {
  try {
    const res = await fetch(api('/api/views'), { credentials: 'same-origin' });
    if (!res.ok) return;
    applyView(setViews(await res.json()));
  } catch {}
}

mountViews({ initialId: viewParam || filters.view, onSelect: applyView });

layout();
establishSession().then(() => {
  loadViewCatalog();
  connect();
});
