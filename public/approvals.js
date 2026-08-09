/*
  The DOM-free half of the approval card, importable by node:test like
  notify.js and match.js. The card is a security surface: the person tapping
  Allow authorizes execution on the strength of what it shows, so nothing
  here may truncate, and characters that lie about their own rendering are
  spelled out instead of trusted.
*/

/** C0 controls (minus \n \t \r), DEL, zero-widths, bidi controls, BOM.
 *  Spelled in \u escapes on purpose — a literal bidi character in this file
 *  would be the very trick the function exists to reveal. */
const INVISIBLE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** U+202E can render `rm -rf /` as something innocuous. Make it loud. */
export function revealInvisibles(text) {
  let count = 0;
  const out = String(text).replace(INVISIBLE, (ch) => {
    count++;
    return `⟨U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}⟩`;
  });
  return { text: out, count };
}

/** Full payload, per tool. An ellipsized command beside an Allow button is
 *  the rubber stamp this feature must never ship. */
export function inputRows(toolName, toolInput) {
  const t = toolInput || {};
  if (toolName === 'Bash') {
    const rows = [['command', String(t.command ?? '')]];
    if (t.description) rows.push(['description', String(t.description)]);
    return rows;
  }
  if (toolName === 'Write') {
    return [
      ['file', String(t.file_path ?? '')],
      ['content', String(t.content ?? '')],
    ];
  }
  if (toolName === 'Edit') {
    return [
      ['file', String(t.file_path ?? '')],
      ['old', String(t.old_string ?? '')],
      ['new', String(t.new_string ?? '')],
    ];
  }
  return [['input', JSON.stringify(t, null, 2)]];
}

/** "4 KB that renders as two lines" is itself a warning the user should see. */
export function inputBytes(toolInput) {
  return JSON.stringify(toolInput || {}).length;
}

export function fmtBytes(n) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

export function secondsLeft(deadline, now = Date.now()) {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}
