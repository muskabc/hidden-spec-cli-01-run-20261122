// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Section 5: a file as lines, its own line break, and whether it ends with one. */
interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

function spliceLines(f: FileLines, at: number, remove: number, insert: string[], keepFinal: boolean | null): FileLines {
  return { lines: f.lines.slice(0, at).concat(insert, f.lines.slice(at + remove)), br: f.br, final: keepFinal === null ? f.final : keepFinal };
}

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** The first tier at which old occurs in lines at or after `from`, with every position there. */
function occurrences(old: string[], lines: string[], from: number, strict: boolean): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const at: number[] = [];
    for (let i = from; i + old.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < old.length; j++) {
        if (!lineEq(old[j]!, lines[i + j]!, t)) {
          ok = false;
          break;
        }
      }
      if (ok) at.push(i);
    }
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** One chunk's old lines and the new lines that replace them. A context line is its index in old. */
interface BodyChunk {
  oldLines: string[];
  newParts: Array<{ ctx: number } | { text: string }>;
}

function pushCtx(c: BodyChunk, text: string): void {
  c.oldLines.push(text);
  c.newParts.push({ ctx: c.oldLines.length - 1 });
}

/** The new lines for a match at `at`: context lines from the file, tier 2 re-indented. */
function resolveNew(c: BodyChunk, f: FileLines, at: number, tier: number): string[] {
  const out: string[] = [];
  const reindent = tier === 2 && c.oldLines.length > 0;
  const lead = reindent ? leadWs(f.lines[at]!) : '';
  const orig = reindent ? leadWs(c.oldLines[0]!) : '';
  for (const part of c.newParts) {
    if ('ctx' in part) {
      out.push(f.lines[at + part.ctx]!);
      continue;
    }
    const t = part.text;
    if (reindent && !/^[ \t]*$/.test(t) && t.startsWith(orig)) out.push(lead + t.slice(orig.length));
    else out.push(t);
  }
  return out;
}

/** A unified hunk, read from its body lines. */
interface Hunk extends BodyChunk {
  a: number;
  noEol: boolean;
  noEolPlus: boolean;
}

function parseBodyLines(body: string[]): { chunk: BodyChunk; noEol: boolean; noEolPlus: boolean } {
  const chunk: BodyChunk = { oldLines: [], newParts: [] };
  let lastCtxPlus = -1;
  let lastPlus = -1;
  body.forEach((l, k) => {
    if (l === '') {
      pushCtx(chunk, '');
      lastCtxPlus = k;
    } else if (l[0] === ' ') {
      pushCtx(chunk, l.slice(1));
      lastCtxPlus = k;
    } else if (l[0] === '-') chunk.oldLines.push(l.slice(1));
    else if (l[0] === '+') {
      chunk.newParts.push({ text: l.slice(1) });
      lastCtxPlus = k;
      lastPlus = k;
    }
  });
  const afterBackslash = (k: number): boolean => k >= 0 && k + 1 < body.length && body[k + 1]![0] === '\\';
  return { chunk, noEol: afterBackslash(lastCtxPlus), noEolPlus: afterBackslash(lastPlus) };
}

/** Apply a section's hunks in order to a file's lines (section 6). */
function applyHunks(f: FileLines, hunks: Hunk[], strict: boolean, path: string): FileLines {
  let cur = f;
  let d = 0;
  for (const h of hunks) {
    if (h.oldLines.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, cur.lines.length));
      const insert = h.newParts.map((p) => ('ctx' in p ? '' : p.text));
      cur = spliceLines(cur, at, 0, insert, at === cur.lines.length ? !h.noEol : null);
      d += insert.length;
      continue;
    }
    const occ = occurrences(h.oldLines, cur.lines, 0, strict);
    if (occ === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = occ.at[0]!;
    for (const pos of occ.at) {
      if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
    }
    const made = resolveNew(h, cur, best, occ.tier);
    const toEnd = best + h.oldLines.length === cur.lines.length;
    cur = spliceLines(cur, best, h.oldLines.length, made, toEnd ? !h.noEol : null);
    d += made.length - h.oldLines.length;
  }
  return cur;
}

/** One unified section: where its paths come from, and its hunks. */
interface USection {
  pairOld?: string | null;
  pairNew?: string | null;
  renOld?: string;
  renNew?: string;
  gitOld?: string;
  gitNew?: string;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

/** A `---`/`+++` path: text after the four characters, up to the first tab, trimmed; `/dev/null` is no file. */
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function unifiedEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const open = (s: USection): void => {
    if (cur !== null) sections.push(cur);
    cur = s;
    inHeader = true;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const no = i + 1;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${no}`);
      open({ gitOld: m[1], gitNew: m[2], create: false, remove: false, hunks: [] });
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = headerPath(line);
      const newP = headerPath(lines[i + 1]!);
      if (cur !== null && inHeader && cur.pairOld === undefined) {
        cur.pairOld = oldP;
        cur.pairNew = newP;
      } else {
        open({ pairOld: oldP, pairNew: newP, create: false, remove: false, hunks: [] });
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${no}`);
      const m = hunkRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${no}`);
      const a = Number(m[1]);
      i += 1;
      const body: string[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          body.push(bl);
          i += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const parsed = parseBodyLines(body);
      cur.hunks.push({ oldLines: parsed.chunk.oldLines, newParts: parsed.chunk.newParts, a, noEol: parsed.noEol, noEolPlus: parsed.noEolPlus });
      inHeader = false;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${no + 1}`);
      if (line.startsWith('rename from ')) cur.renOld = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renNew = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.create = true;
      else if (line.startsWith('deleted file mode')) cur.remove = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  if (cur !== null) sections.push(cur);
  return sections.map((s) => unifiedSectionEdit(s, strict, moves));
}

function unifiedSectionEdit(s: USection, strict: boolean, moves: Array<[string, string]>): Edit {
  const oldP = s.pairOld !== undefined ? s.pairOld : s.renOld !== undefined ? s.renOld : s.gitOld;
  const newP = s.pairNew !== undefined ? s.pairNew : s.renNew !== undefined ? s.renNew : s.gitNew;
  const isCreate = s.create || oldP === null;
  const isRemove = s.remove || newP === null;
  return (tree) => {
    if (isCreate) {
      const np = newP ?? '';
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out: string[] = [];
      let finalBr = true;
      for (const h of s.hunks) {
        let hasPlus = false;
        for (const part of h.newParts) {
          if (!('ctx' in part)) {
            out.push(part.text);
            hasPlus = true;
          }
        }
        if (hasPlus) finalBr = !h.noEolPlus;
      }
      tree.now.set(np, out.length === 0 ? '' : out.join('\n') + (finalBr ? '\n' : ''));
      return;
    }
    const op = oldP ?? '';
    if (!safe(op)) throw new Fail('unsafe', op);
    if (isRemove) {
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const np = newP ?? op;
    const isMove = np !== op;
    if (isMove && !safe(np)) throw new Fail('unsafe', np);
    const cur = tree.get(op);
    if (cur === null) throw new Fail('missing', op);
    if (isMove && tree.get(np) !== null) throw new Fail('exists', np);
    const done = applyHunks(splitFile(cur), s.hunks, strict, op);
    const text = joinFile(done);
    if (isMove) {
      tree.now.set(op, null);
      tree.now.set(np, text);
      moves.push([op, np]);
    } else {
      tree.now.set(op, text);
    }
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchNo = i + 1;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        // A SEARCH line starts a new block (SPEC.md section 7: blocks are
        // sequential, each ending at its own >>>>>>> REPLACE), so a REPLACE
        // past one belongs to that later block, not this one; without it
        // this block has no REPLACE of its own. This mirrors the =======
        // search above, which stops at a SEARCH line for the same reason.
        if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchNo}`);
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchNo}`);
      path = prevPath;
    }
    edits.push(srBlockEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

function srBlockEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const f = splitFile(cur);
    const occ = occurrences(oldLines, f.lines, 0, strict);
    if (occ === null) throw new Fail('no-match', path);
    if (occ.at.length > 1) throw new Fail('ambiguous', path);
    const chunk: BodyChunk = { oldLines, newParts: newLines.map((t) => ({ text: t })) };
    const made = resolveNew(chunk, f, occ.at[0]!, occ.tier);
    tree.now.set(path, joinFile(spliceLines(f, occ.at[0]!, oldLines.length, made, null)));
  };
}

/** One V4A section, with its raw lines and their patch line numbers. */
interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  no: number;
  raw: Array<{ text: string; no: number }>;
}

/** One V4A chunk. */
interface VChunk extends BodyChunk {
  anchor: string | null;
  endOfFile: boolean;
}

function v4aEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let cur: VSection | null = null;
  const open = (kind: 'add' | 'delete' | 'update', path: string, no: number): void => {
    if (cur !== null) sections.push(cur);
    cur = { kind, path, no, raw: [] };
  };
  for (let i = first + 1; i < last; i++) {
    const line = lines[i]!;
    const no = i + 1;
    if (line.startsWith('*** Add File: ')) open('add', line.slice(14).trim(), no);
    else if (line.startsWith('*** Delete File: ')) open('delete', line.slice(17).trim(), no);
    else if (line.startsWith('*** Update File: ')) open('update', line.slice(17).trim(), no);
    else if (cur !== null) cur.raw.push({ text: line, no });
    else if (!blank(line)) throw new Exit2(`error: parse ${no}`);
  }
  if (cur !== null) sections.push(cur);
  return sections.map((s) => v4aSectionEdit(s, strict, moves));
}

function parseV4aChunks(raw: Array<{ text: string; no: number }>, updateNo: number): { moveTo: string | null; chunks: VChunk[] } {
  let idx = 0;
  let moveTo: string | null = null;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.text.slice(13).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  let seen = false;
  const close = (): void => {
    if (cur !== null) {
      chunks.push(cur);
      cur = null;
    }
  };
  for (; idx < raw.length; idx++) {
    const { text, no } = raw[idx]!;
    if (text.startsWith('@@')) {
      close();
      const anchor = text.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, endOfFile: false, oldLines: [], newParts: [] };
      seen = true;
    } else if (text === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${no}`);
      cur.endOfFile = true;
      close();
    } else if (text === '' || text[0] === ' ' || text[0] === '-' || text[0] === '+') {
      if (cur === null) {
        if (seen) throw new Exit2(`error: parse ${no}`);
        cur = { anchor: null, endOfFile: false, oldLines: [], newParts: [] };
        seen = true;
      }
      if (text === '') pushCtx(cur, '');
      else if (text[0] === ' ') pushCtx(cur, text.slice(1));
      else if (text[0] === '-') cur.oldLines.push(text.slice(1));
      else cur.newParts.push({ text: text.slice(1) });
    } else {
      throw new Exit2(`error: parse ${no}`);
    }
  }
  close();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateNo}`);
  return { moveTo, chunks };
}

function applyV4aChunks(f: FileLines, chunks: VChunk[], strict: boolean, path: string): FileLines {
  let cur = f;
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      let found: number | null = null;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const t of tiers) {
        for (let j = cursor; j < cur.lines.length; j++) {
          if (lineEq(ch.anchor, cur.lines[j]!, t)) {
            found = j;
            break;
          }
        }
        if (found !== null) break;
      }
      if (found === null) throw new Fail('no-match', path);
      cursor = found + 1;
    }
    if (ch.oldLines.length === 0) {
      const at = ch.endOfFile ? cur.lines.length : cursor;
      const insert = ch.newParts.map((p) => ('ctx' in p ? '' : p.text));
      cur = spliceLines(cur, at, 0, insert, null);
      cursor = at + insert.length;
      continue;
    }
    const occ = occurrences(ch.oldLines, cur.lines, cursor, strict);
    let at: number | null = null;
    let tier = 0;
    if (occ !== null) {
      tier = occ.tier;
      for (const pos of occ.at) {
        if (ch.endOfFile && pos + ch.oldLines.length !== cur.lines.length) continue;
        at = pos;
        break;
      }
    }
    if (at === null) throw new Fail('no-match', path);
    const made = resolveNew(ch, cur, at, tier);
    cur = spliceLines(cur, at, ch.oldLines.length, made, null);
    cursor = at + made.length;
  }
  return cur;
}

function v4aSectionEdit(s: VSection, strict: boolean, moves: Array<[string, string]>): Edit {
  const raw = [...s.raw];
  while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
  if (s.kind === 'add') {
    const made: string[] = [];
    for (const l of raw) {
      if (l.text === '') made.push('');
      else if (l.text[0] === '+') made.push(l.text.slice(1));
      else throw new Exit2(`error: parse ${l.no}`);
    }
    const text = made.length === 0 ? '' : made.join('\n') + '\n';
    return (tree) => {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, text);
    };
  }
  if (s.kind === 'delete') {
    for (const l of raw) {
      if (!blank(l.text)) throw new Exit2(`error: parse ${l.no}`);
    }
    return (tree) => {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
    };
  }
  const { moveTo, chunks } = parseV4aChunks(raw, s.no);
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(s.path);
    if (cur === null) throw new Fail('missing', s.path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const done = applyV4aChunks(splitFile(cur), chunks, strict, s.path);
    const text = joinFile(done);
    if (moveTo !== null) {
      tree.now.set(s.path, null);
      tree.now.set(moveTo, text);
      moves.push([s.path, moveTo]);
    } else {
      tree.now.set(s.path, text);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Array<[string, string]> = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict, moves);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const entries: Array<{ key: string; line: string }> = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    entries.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [oldP, newP] of moves) {
    if (tree.original(oldP) === null || tree.get(oldP) !== null) continue;
    if (tree.original(newP) !== null || tree.get(newP) === null) continue;
    const di = entries.findIndex((e) => e.line === `D ${oldP}`);
    const ai = entries.findIndex((e) => e.line === `A ${newP}`);
    if (di < 0 || ai < 0) continue;
    entries.splice(Math.max(di, ai), 1);
    entries.splice(Math.min(di, ai), 1);
    entries.push({ key: newP, line: `R ${oldP} -> ${newP}` });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = entries.map((e) => e.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
