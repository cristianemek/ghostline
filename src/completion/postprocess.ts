export interface IndentStyle {
  insertSpaces: boolean;
  tabSize: number;
}

export interface PostprocessInput {
  /** The model's answer, untouched. */
  raw: string;
  /** Text before the cursor (the window sent in the prompt is enough). */
  prefix: string;
  /** Text after the cursor. */
  suffix: string;
  maxLines: number;
  indent: IndentStyle;
  /** Used to tell code from prose documents, where sentences are the expected completion. */
  languageId?: string;
}

/** Languages where a full sentence is ordinary content: prose, markup templates and data files. */
const PROSE_LANGUAGES = new Set([
  'markdown',
  'mdx',
  'plaintext',
  'latex',
  'tex',
  'restructuredtext',
  'asciidoc',
  'git-commit',
  'scminput',
  'html',
  'xml',
  'handlebars',
  'jinja',
  'django-html',
  'erb',
  'razor',
  'yaml',
  'json',
  'jsonc',
  'toml',
  'ini',
  'properties',
  'csv',
]);

const WORD_CHAR = /[A-Za-z0-9_$]/;
const COMMENT_START = /^(\/\/|\/\*|\*|#|--|<!--|;|"""|''')/;
const CLOSERS_ONLY = /^[)\]}]+[;,]?$/;
const OPENERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = new Set([')', ']', '}']);

/** Answers that mean "I have nothing" rather than code. Case matters: `ok` is a Go identifier. */
const EMPTY_MARKERS = new Set([
  'OK',
  'OK.',
  'Ok',
  'Ok.',
  'Okay',
  'Okay.',
  'N/A',
  '(empty)',
  '(empty string)',
  '(empty response)',
  '(none)',
  '(nothing)',
  '(no completion)',
  '<empty>',
  '<empty/>',
  '<none>',
  '<none/>',
  '[empty]',
  'No completion',
  'No completion.',
  'No suggestion',
  'No suggestion.',
]);

const CHATTER = [
  /^(here('s| is| are)\b|sure[,!.]|certainly[,!.]|of course[,!.])/i,
  /^i (can(not|'t)|do(n't| not)|am (unable|not able)|'m (unable|not able|sorry)|would need|need more)\b/i,
  /^(the|this) (completion|code|cursor|file|function|snippet|prefix|suffix|line) (is|appears|seems|looks|already|does|has)\b/i,
  /^no (good |useful |further |additional )?(completion|suggestion|changes?)\b/i,
  /^there('s| is) (no|nothing)\b/i,
  /^nothing to (add|complete|insert|suggest)\b/i,
  /^(sorry\b|as an ai\b|note:|explanation:)/i,
];

function leadingWhitespace(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? '';
}

function widthOf(whitespace: string, tabSize: number): number {
  let width = 0;
  for (const char of whitespace) width = char === '\t' ? width + tabSize - (width % tabSize) : width + 1;
  return width;
}

function makeIndent(width: number, style: IndentStyle): string {
  if (style.insertSpaces) return ' '.repeat(width);
  return '\t'.repeat(Math.floor(width / style.tabSize)) + ' '.repeat(width % style.tabSize);
}

function lastLine(text: string): string {
  return text.slice(text.lastIndexOf('\n') + 1);
}

/** The line so far ends where a value is expected, so a backtick-quoted answer may be a template literal. */
const EXPECTS_EXPRESSION = /(?:[=(,:+\-*/%<>!&|?[{]|\breturn|\bawait|\byield|\bthrow)\s*$/;

/**
 * Keeps only the code when the model wrapped its answer in a markdown fence or backticks.
 * `lineContent` is what is already typed on the current line: after "const msg = " an answer in
 * backticks is a template literal and must be left alone.
 */
export function stripCodeFences(text: string, lineContent = ''): string {
  const fenced = /```[^\n`]*\n([\s\S]*?)\n?[ \t]*```/.exec(text);
  if (fenced) return fenced[1] ?? '';
  let out = text;
  // Opening fence with no closing one (cut-off answer), or a stray closing fence.
  out = out.replace(/^\s*```[^\n`]*\n/, '');
  out = out.replace(/\n?[ \t]*```\s*$/, '');
  // `code` — and, when the code has backticks of its own, the model escapes them: `a \`b\` c`.
  const inline = /^`((?:\\`|[^`\n])+)`$/.exec(out.trim());
  if (inline) {
    const content = inline[1] ?? '';
    // Where a value is expected, backticks around an interpolation are a real template literal.
    const templateLiteral = EXPECTS_EXPRESSION.test(lineContent) && content.includes('${');
    if (!templateLiteral) return content.replace(/\\`/g, '`');
  }
  return out;
}

/** Prose as a whole (not line by line): mostly plain words. */
function mostlyWords(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length < 5) return false;
  return words.filter((word) => /^[A-Za-z][A-Za-z'’-]*[,.:;!?]?$/.test(word)).length / words.length >= 0.6;
}

/**
 * "…so the loop pushes into the array. Completion: `0;`" — the model thought out loud and put the
 * answer at the end. Keep the answer.
 */
function extractMarkedAnswer(text: string): string {
  const marked = /(?:completion|answer|output|result|insert(?:ion)?)\s*(?:is\s*)?:?\s*`((?:\\`|[^`\n])+)`\.?\s*$/i.exec(text);
  if (!marked || !mostlyWords(text.slice(0, marked.index))) return text;
  return (marked[1] ?? '').replace(/\\`/g, '`');
}

function isChatter(text: string, lineContent: string): boolean {
  const trimmed = text.trim();
  if (EMPTY_MARKERS.has(trimmed)) return true;
  // A bare empty string literal on a line of its own is the model spelling out "empty string".
  if (lineContent === '' && (trimmed === '""' || trimmed === "''" || trimmed === '``')) return true;
  // Inside a comment prose is the expected completion, so the phrase filters would be wrong there.
  if (COMMENT_START.test(lineContent)) return false;
  return CHATTER.some((pattern) => pattern.test(trimmed));
}

/**
 * The model second-guessing itself in the middle of an answer:
 * "status === 'success') day.errors++... wait — the completion should be …".
 */
const SELF_TALK = /(?:\.{3}|…)\s*wait\b|\bwait\s*[—–]|\bthe (?:completion|answer|cursor) (?:should|is|would|must|sits)\b|\bno, the\b/i;

/** Keeps what came before the model started talking to itself. */
function cutAtSelfTalk(text: string, prefix: string, lineContent: string): string {
  if (COMMENT_START.test(lineContent) || insideCommentBlock(prefix)) return text;
  const talk = SELF_TALK.exec(text);
  return talk ? text.slice(0, talk.index) : text;
}

/** An English sentence rather than code: mostly plain words, with sentence punctuation. */
function looksLikeProse(line: string): boolean {
  const trimmed = line.trim();
  if (COMMENT_START.test(trimmed)) return false;
  const words = trimmed.split(/\s+/);
  const boundary = /[.!?] [A-Z]/.test(trimmed);
  if (/^[A-Z]/.test(trimmed)) {
    if (words.length < 6 || (!/[.!?:]$/.test(trimmed) && !boundary)) return false;
  } else if (words.length < 10 || !boundary) {
    // Not capitalised ("options.push(...)? No, the loop that follows is…"): only a long line with
    // one sentence ending and another starting is taken for prose, so that English-looking code
    // (SQL, Python, shell) is not.
    return false;
  }
  const plain = words.filter((word) => /^[A-Za-z][A-Za-z'’-]*[,.:;!?]?$/.test(word)).length;
  return plain / words.length >= 0.8;
}

/** True when the cursor sits inside a block comment or a docstring, where prose is legitimate. */
function insideCommentBlock(prefix: string): boolean {
  if (prefix.lastIndexOf('/*') > prefix.lastIndexOf('*/')) return true;
  if (prefix.lastIndexOf('<!--') > prefix.lastIndexOf('-->')) return true;
  return ((prefix.match(/"""/g)?.length ?? 0) + (prefix.match(/'''/g)?.length ?? 0)) % 2 === 1;
}

/**
 * Now and then the model explains itself after (or instead of) the code. Everything from the first
 * line of prose on is dropped; in a comment, a string or a prose document sentences are left alone.
 */
function cutAtProse(text: string, prefix: string, lineContent: string, languageId: string | undefined): string {
  if (languageId && PROSE_LANGUAGES.has(languageId)) return text;
  if (insideCommentBlock(prefix)) return text;
  // Right after a tag (JSX, Vue, Svelte, PHP templates…) the text content of the element is what
  // comes next. "=>" and "->" end in the same character but are not tags.
  if (/(?<![=-])>\s*$/.test(prefix)) return text;
  const lines = text.split('\n');
  const inCommentOrString = COMMENT_START.test(lineContent) || (lineContent.match(/["'`]/g)?.length ?? 0) % 2 === 1;
  const start = inCommentOrString ? 1 : 0;
  const index = lines.findIndex((line, i) => i >= start && looksLikeProse(line));
  return index < 0 ? text : lines.slice(0, index).join('\n');
}

/** True when the text closes a bracket it never opened, i.e. one that belongs to code around the cursor. */
export function hasUnmatchedCloser(text: string): boolean {
  const stack: string[] = [];
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote || (char === '\n' && quote !== '`')) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
    } else if (char in OPENERS) {
      stack.push(OPENERS[char] as string);
    } else if (CLOSERS.has(char)) {
      if (stack.at(-1) === char) stack.pop();
      else return true;
    }
  }
  return false;
}

/**
 * The model often restates what is already typed on the current line ("const x = fo" → "foo(bar)",
 * or the whole line again). Cuts that repeated start off the first line of the completion.
 */
function removePrefixOverlap(text: string, linePrefix: string): string {
  const newline = text.indexOf('\n');
  const first = newline < 0 ? text : text.slice(0, newline);
  const head = linePrefix.trimStart();
  if (!head || !first) return text;

  // Whole current line restated.
  const firstTrimmed = first.trimStart();
  if ((WORD_CHAR.test(head) || head.length >= 3) && firstTrimmed.startsWith(head)) {
    return text.slice(first.length - firstTrimmed.length + head.length);
  }

  // Tail of the line restated: longest suffix of the line that is a prefix of the completion.
  for (let size = Math.min(linePrefix.length, first.length); size >= 1; size--) {
    const overlap = first.slice(0, size);
    if (!linePrefix.endsWith(overlap)) continue;
    const before = linePrefix[linePrefix.length - size - 1];
    const midWord = before !== undefined && WORD_CHAR.test(before) && WORD_CHAR.test(overlap[0] as string);
    if (midWord) continue;
    // A lone ")" or "}" is far more likely a second closer than a repeat, so punctuation needs length.
    if (WORD_CHAR.test(overlap) || size >= 3) return text.slice(size);
  }
  return text;
}

/**
 * Drops the start of a completion that just repeats the lines already in the file right above the
 * cursor (one line, or a whole block before getting to the new code).
 */
function removeRepeatedPreviousLines(text: string, prefix: string): string {
  const previous = prefix
    .slice(0, Math.max(0, prefix.lastIndexOf('\n')))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (previous.length === 0) return text;
  const lines = text.split('\n');
  const content = lines.flatMap((line, index) => (line.trim() ? [index] : []));
  for (let count = Math.min(content.length, previous.length, 8); count >= 1; count--) {
    const mine = content.slice(0, count).map((index) => (lines[index] as string).trim());
    const theirs = previous.slice(-count);
    // Short repeats ("}", "break;") are legitimate code.
    if (mine.join('').length < 10 || !mine.every((line, i) => line === theirs[i])) continue;
    return lines
      .slice((content[count - 1] as number) + 1)
      .join('\n')
      .replace(/^\s+/, '');
  }
  return text;
}

/** Number of brackets the text opens and leaves open. */
function unclosedOpeners(text: string): number {
  const stack: string[] = [];
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char in OPENERS) stack.push(OPENERS[char] as string);
    else if (stack.at(-1) === char) stack.pop();
  }
  return stack.length;
}

/** True when the line after this one is expected one level deeper. */
function opensBlock(line: string): boolean {
  const trimmed = line.trim();
  // "// Steps:" ends with a colon but opens nothing.
  if (COMMENT_START.test(trimmed)) return false;
  return /[{([:]$/.test(trimmed) || trimmed.endsWith('=>') || unclosedOpeners(trimmed) > 0;
}

function startsWithCloser(line: string): boolean {
  return /^[)\]}]/.test(line.trimStart());
}

/**
 * Re-bases the indentation of every line after the first on the current line. The model's absolute
 * indentation is unreliable (it was measured to be off by a level), but its relative structure is fine.
 */
function reindent(text: string, linePrefix: string, style: IndentStyle): string {
  const lines = text.split('\n');
  if (lines.length < 2) return text;
  const anchorIndex = lines.findIndex((line, index) => index >= 1 && line.trim() !== '');
  if (anchorIndex < 0) return lines[0] ?? '';

  const tabSize = Math.max(1, style.tabSize);
  const widths = lines.map((line) => widthOf(leadingWhitespace(line), tabSize));
  const anchorWidth = widths[anchorIndex] as number;

  // One indentation level as the model wrote it: the smallest step between its lines.
  const distinct = [...new Set(widths.filter((_, index) => index >= 1 && (lines[index] as string).trim() !== ''))].sort(
    (a, b) => a - b,
  );
  let modelUnit = tabSize;
  for (let i = 1; i < distinct.length; i++) {
    const step = (distinct[i] as number) - (distinct[i - 1] as number);
    if (i === 1 || step < modelUnit) modelUnit = step;
  }
  if (modelUnit < 2) modelUnit = tabSize;

  const currentLine = linePrefix + (lines[0] as string);
  const currentWidth = widthOf(leadingWhitespace(linePrefix), tabSize);
  const anchorLine = lines[anchorIndex] as string;
  const expected = Math.max(
    0,
    currentWidth + (opensBlock(currentLine) ? tabSize : 0) - (startsWithCloser(anchorLine) ? tabSize : 0),
  );

  return lines
    .map((line, index) => {
      if (index === 0) return line;
      if (line.trim() === '') return '';
      const levels = Math.round(((widths[index] as number) - anchorWidth) / modelUnit);
      return makeIndent(Math.max(0, expected + levels * tabSize), style) + line.trimStart();
    })
    .join('\n');
}

/** Cuts the end of the completion when it repeats what already follows the cursor. */
function removeSuffixOverlap(text: string, linePrefix: string, suffix: string, tabSize: number): string {
  const newline = suffix.indexOf('\n');
  const rest = (newline < 0 ? suffix : suffix.slice(0, newline)).trim();

  if (rest) {
    // Same line: `foo(|)` + "a, b)" → "a, b".
    for (let size = Math.min(rest.length, text.length); size >= 1; size--) {
      const overlap = rest.slice(0, size);
      if (!text.endsWith(overlap)) continue;
      const before = text[text.length - size - 1];
      if (before !== undefined && WORD_CHAR.test(before) && WORD_CHAR.test(overlap[0] as string)) continue;
      // "bar(a)" before ")" is a balanced call of its own: that ")" is not the one after the cursor.
      if (/^[)\]}'"`;,\s]+$/.test(overlap) && !hasUnmatchedCloser(text) && !/^['"`;,\s]+$/.test(overlap)) return text;
      return text.slice(0, text.length - size).trimEnd();
    }
    return text;
  }

  // Following lines: the completion ends with lines that are already there.
  const following = (newline < 0 ? '' : suffix.slice(newline + 1)).split('\n').filter((line) => line.trim() !== '');
  if (following.length === 0) return text;
  const lines = text.split('\n');
  const contentIndexes = lines.flatMap((line, index) => (line.trim() !== '' ? [index] : []));
  const unmatched = hasUnmatchedCloser(text);
  const indentOf = (index: number): number =>
    // The first line starts at the cursor, so its indentation is the current line's.
    widthOf(leadingWhitespace(index === 0 ? linePrefix : (lines[index] as string)), tabSize);

  for (let count = Math.min(contentIndexes.length, following.length, 8); count >= 1; count--) {
    const tail = contentIndexes.slice(-count);
    const matches = tail.every((lineIndex, i) => {
      // A first line that continues text already on the current line is a fragment, not a whole line.
      if (lineIndex === 0 && linePrefix.trim() !== '') return false;
      const mine = (lines[lineIndex] as string).trim();
      const theirs = following[i] as string;
      if (mine !== theirs.trim()) return false;
      if (!CLOSERS_ONLY.test(mine)) return true;
      // Two "}" at different depths close different blocks.
      return indentOf(lineIndex) === widthOf(leadingWhitespace(theirs), tabSize);
    });
    if (!matches) continue;
    const onlyClosers = tail.every((lineIndex) => CLOSERS_ONLY.test((lines[lineIndex] as string).trim()));
    // A balanced completion closes its own blocks; those closers are needed even if they look alike.
    if (onlyClosers && !unmatched) return text;
    return lines.slice(0, tail[0]).join('\n').trimEnd();
  }
  return text;
}

/**
 * For a suggestion that is being continued as the user types: the editor may have inserted closing
 * brackets or quotes since it was first shown, so the remainder is checked against the suffix again.
 */
export function trimAgainstSuffix(text: string, prefix: string, suffix: string, indent: IndentStyle): string {
  return removeSuffixOverlap(text, lastLine(prefix), suffix, Math.max(1, indent.tabSize));
}

/**
 * True once a streamed answer is clearly longer than anything that would be shown, so the request
 * can be cut short instead of paying for output that gets thrown away. The margin covers what the
 * post-processing may still remove (a code fence, a restated line, leading blank lines).
 */
export function exceedsUsefulLength(text: string, maxLines: number): boolean {
  return text.length > Math.max(600, maxLines * 200) || text.split('\n').length > maxLines + 3;
}

/** Whether to stop reading a streamed answer: it is long enough, or it has turned into an explanation. */
export function shouldStopEarly(
  text: string,
  context: { maxLines: number; prefix: string; languageId?: string },
): boolean {
  if (exceedsUsefulLength(text, context.maxLines)) return true;
  const normalized = text.replace(/\r\n?/g, '\n');
  const kept = cutAtProse(normalized, context.prefix, lastLine(context.prefix).trim(), context.languageId);
  return kept.length < normalized.length;
}

function limitLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  // A completion that starts on a new line spends its first (empty) slot on the current line.
  const limit = Math.max(1, maxLines) + (lines[0] === '' ? 1 : 0);
  if (lines.length <= limit) return text;
  return lines.slice(0, limit).join('\n');
}

/**
 * Turns the model's answer into the exact text to insert at the cursor, or '' when there is nothing
 * worth showing.
 */
export function postprocess(input: PostprocessInput): string {
  const { prefix, suffix, indent } = input;
  const linePrefix = lastLine(prefix);
  const lineContent = linePrefix.trim();
  const tabSize = Math.max(1, indent.tabSize);

  let text = input.raw.replace(/\r\n?/g, '\n');
  text = extractMarkedAnswer(text);
  text = stripCodeFences(text, lineContent).replace(/<cursor\s*\/>/g, '');
  // Indentation spelled out as escapes ("\s\s\s'csv',") instead of real whitespace.
  text = text.replace(/^(?:\\[st])+/, '');
  if (isChatter(text, lineContent)) return '';
  if (!(input.languageId && PROSE_LANGUAGES.has(input.languageId))) text = cutAtSelfTalk(text, prefix, lineContent);
  text = cutAtProse(text, prefix, lineContent, input.languageId).replace(/\s+$/, '');
  if (!text.trim()) return '';

  if (lineContent === '') {
    // The cursor already sits at the line's indentation.
    text = text.replace(/^\s+/, '');
    text = removeRepeatedPreviousLines(text, prefix);
  } else {
    const blankLead = /^(?:[ \t]*\n)+/.exec(text);
    if (blankLead) {
      // The model continues on a new line: exactly one line break, however many it sent.
      text = '\n' + text.slice(blankLead[0].length);
    } else {
      if (/\s$/.test(linePrefix)) text = text.replace(/^[ \t]+/, '');
      text = removePrefixOverlap(text, linePrefix);
    }
  }
  if (!text.trim()) return '';

  text = reindent(text, linePrefix, indent);
  text = removeSuffixOverlap(text, linePrefix, suffix, tabSize);
  text = limitLines(text, input.maxLines).replace(/\s+$/, '');
  if (!text.trim()) return '';

  // Exactly what already follows the cursor on this line: nothing to add.
  const newline = suffix.indexOf('\n');
  const rest = newline < 0 ? suffix : suffix.slice(0, newline);
  if (!text.includes('\n') && rest.trim() !== '' && rest.trimStart().startsWith(text.trim())) return '';

  return text;
}
