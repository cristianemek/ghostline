export interface IndentStyle {
  insertSpaces: boolean;
  tabSize: number;
}

export interface PostprocessInput {
  raw: string;
  prefix: string;
  suffix: string;
  maxLines: number;
  indent: IndentStyle;
  languageId?: string;
}

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
const SPACED_END = /(?:,|\s(?::=|=>|[-+*/%&|^<>!=]?=))$/;
const OPENERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = new Set([')', ']', '}']);

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

const PROMPT_ECHO = /<\/?(?:prefix|suffix|symbols|accepted)>|<file path=/;
const MARKUP_LANGUAGES = new Set([
  'html',
  'xml',
  'xsl',
  'svg',
  'vue',
  'svelte',
  'astro',
  'php',
  'javascriptreact',
  'typescriptreact',
  'handlebars',
  'jinja',
  'django-html',
  'erb',
  'razor',
  'markdown',
  'mdx',
]);

const END_TOKEN = /<\|(?:endoftext|im_end|eot_id|end)\|>|<eos>|\[\/INST\]|<\/(?:prefix|suffix|symbols|accepted)>/;
const FORMAT_TAG = new RegExp(`${END_TOKEN.source}|</(?:s|parameter|invoke|function_calls|answer|completion|output|response|result|line|file|region|fix|note)>`);

function cutAtFormatTag(text: string, languageId: string | undefined): string {
  const found = (languageId && MARKUP_LANGUAGES.has(languageId) ? END_TOKEN : FORMAT_TAG).exec(text);
  return found ? text.slice(0, found.index) : text;
}

function removeStrayClosingTag(text: string, languageId: string | undefined): string {
  if (languageId && MARKUP_LANGUAGES.has(languageId)) return text;
  const stray = /<\/([A-Za-z][\w-]*)>\s*$/.exec(text);
  if (!stray || text.includes(`<${stray[1] as string}`)) return text;
  return text.slice(0, stray.index);
}

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

const EXPECTS_EXPRESSION = /(?:[=(,:+\-*/%<>!&|?[{]|\breturn|\bawait|\byield|\bthrow)\s*$/;

export function stripCodeFences(text: string, lineContent = ''): string {
  const fenced = /```[^\n`]*\n([\s\S]*?)\n?[ \t]*```/.exec(text);
  if (fenced) return fenced[1] ?? '';
  let out = text;
  out = out.replace(/^\s*```[^\n`]*\n/, '');
  out = out.replace(/\n?[ \t]*```\s*$/, '');
  const inline = /^`((?:\\`|[^`\n])+)`$/.exec(out.trim());
  if (inline) {
    const content = inline[1] ?? '';
    const templateLiteral = EXPECTS_EXPRESSION.test(lineContent) && content.includes('${');
    if (!templateLiteral) return content.replace(/\\`/g, '`');
  }
  const block = /^`([^`]+)`$/.exec(out.trim());
  if (block?.[1]?.includes('\n') && !EXPECTS_EXPRESSION.test(lineContent)) return block[1];
  return out;
}

const GO_NAMED_LITERAL = /(?:^|[^\w\][.*])[A-Za-z_][\w.]*\{$/;

function removeRestatedOpener(text: string, linePrefix: string, languageId: string | undefined): string {
  if (languageId !== 'go' || !text.startsWith('{') || !GO_NAMED_LITERAL.test(linePrefix)) return text;
  return text.slice(1);
}

function mostlyWords(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length < 5) return false;
  return words.filter((word) => /^[A-Za-z][A-Za-z'’-]*[,.:;!?]?$/.test(word)).length / words.length >= 0.6;
}

function extractMarkedAnswer(text: string): string {
  const marked = /(?:completion|answer|output|result|insert(?:ion)?)\s*(?:is\s*)?:?\s*`((?:\\`|[^`\n])+)`\.?\s*$/i.exec(text);
  if (!marked || !mostlyWords(text.slice(0, marked.index))) return text;
  return (marked[1] ?? '').replace(/\\`/g, '`');
}

function isChatter(text: string, lineContent: string): boolean {
  const trimmed = text.trim();
  if (EMPTY_MARKERS.has(trimmed)) return true;
  if (lineContent === '' && (trimmed === '""' || trimmed === "''" || trimmed === '``')) return true;
  if (COMMENT_START.test(lineContent)) return false;
  return CHATTER.some((pattern) => pattern.test(trimmed));
}

const SELF_TALK = new RegExp(
  [
    String.raw`(?:\.{3}|…)\s*(?:wait|no|actually|hmm|hold on|sorry|oops|scratch that)\b`,
    String.raw`(?:\.{3}|…)\s+[a-z]+[;,:]?\s+[a-z]+\s+[a-z]+`,
    String.raw`\bwait\s*[—–]`,
    String.raw`\?\s*no\b\s*[—–.;]`,
    String.raw`\bno\s*[—–]`,
    String.raw`\bno[,;] the\b`,
    String.raw`(?:^|\n)[ \t]*(?:wait|actually|hmm+|hold on|sorry|oops|correction|scratch that)\b\s*[,.:;!—–]`,
  ].join('|'),
  'i',
);
const AFTERTHOUGHT = /\bthe (?:completion|answer|cursor) (?:should|is|would|must|sits)\b/i;

function cutAtSelfTalk(text: string, prefix: string, lineContent: string): string {
  if (COMMENT_START.test(lineContent) || insideCommentBlock(prefix)) return text;
  const outsideString = (index: number): boolean => (text.slice(0, index).match(/["'`]/g)?.length ?? 0) % 2 === 0;
  const doubt = SELF_TALK.exec(text);
  if (doubt && outsideString(doubt.index)) return '';
  const afterthought = AFTERTHOUGHT.exec(text);
  return afterthought && outsideString(afterthought.index) ? text.slice(0, afterthought.index) : text;
}

const FUNCTION_WORD = /^(?:the|a|an|is|are|was|but|and|or|on|in|to|of|that|this|it|so|be|not|with|for|from|as|at|by|already|should|must|will|would|can|after|before)[,.:;]?$/;

function looksLikeProse(line: string): boolean {
  const trimmed = line.trim();
  if (COMMENT_START.test(trimmed)) return false;
  const words = trimmed.split(/\s+/).map((word) => word.replace(/`/g, ''));
  const boundary = /[.!?] [A-Z]/.test(trimmed);
  const sentence = /^[A-Z]/.test(trimmed) && words.length >= 8 && words.filter((word) => FUNCTION_WORD.test(word)).length >= 2;
  if (/^[A-Z]/.test(trimmed)) {
    if (words.length < 6 || (!/[.!?:]$/.test(trimmed) && !boundary && !sentence)) return false;
  } else if (words.length < 10 || !boundary) {
    return false;
  }
  const plain = words.filter((word) => /^[A-Za-z][A-Za-z'’-]*[,.:;!?]?$/.test(word)).length;
  return plain / words.length >= 0.8;
}

function insideCommentBlock(prefix: string): boolean {
  if (prefix.lastIndexOf('/*') > prefix.lastIndexOf('*/')) return true;
  if (prefix.lastIndexOf('<!--') > prefix.lastIndexOf('-->')) return true;
  return ((prefix.match(/"""/g)?.length ?? 0) + (prefix.match(/'''/g)?.length ?? 0)) % 2 === 1;
}

function cutAtProse(text: string, prefix: string, lineContent: string, languageId: string | undefined): string {
  if (languageId && PROSE_LANGUAGES.has(languageId)) return text;
  if (insideCommentBlock(prefix)) return text;
  if (/(?<![=-])>\s*$/.test(prefix)) return text;
  const lines = text.split('\n');
  const inCommentOrString = COMMENT_START.test(lineContent) || (lineContent.match(/["'`]/g)?.length ?? 0) % 2 === 1;
  const start = inCommentOrString ? 1 : 0;
  const index = lines.findIndex((line, i) => i >= start && looksLikeProse(line));
  return index < 0 ? text : lines.slice(0, index).join('\n');
}

function unmatchedCloserIndex(text: string): number {
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
      else return i;
    }
  }
  return -1;
}

export function hasUnmatchedCloser(text: string): boolean {
  return unmatchedCloserIndex(text) >= 0;
}

function removePrefixOverlap(text: string, linePrefix: string): string {
  const newline = text.indexOf('\n');
  const first = newline < 0 ? text : text.slice(0, newline);
  const head = linePrefix.trimStart();
  if (!head || !first) return text;

  const firstTrimmed = first.trimStart();
  if ((WORD_CHAR.test(head) || head.length >= 3) && firstTrimmed.startsWith(head)) {
    return text.slice(first.length - firstTrimmed.length + head.length);
  }

  for (let size = Math.min(linePrefix.length, first.length); size >= 1; size--) {
    const overlap = first.slice(0, size);
    if (!linePrefix.endsWith(overlap)) continue;
    const before = linePrefix[linePrefix.length - size - 1];
    const midWord = before !== undefined && WORD_CHAR.test(before) && WORD_CHAR.test(overlap[0] as string);
    if (midWord) continue;
    if (WORD_CHAR.test(overlap) || size >= 3) return text.slice(size);
  }
  return text;
}

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
    if (mine.join('').length < 10 || !mine.every((line, i) => line === theirs[i])) continue;
    return lines
      .slice((content[count - 1] as number) + 1)
      .join('\n')
      .replace(/^\s+/, '');
  }
  return text;
}

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

const ELEMENT_LANGUAGES = new Set([...MARKUP_LANGUAGES, 'javascript', 'blade', 'twig', 'jinja-html']);
const VOID_TAG = /^(?:area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)$/i;

function hasMarkup(languageId: string | undefined): boolean {
  return languageId === undefined || ELEMENT_LANGUAGES.has(languageId);
}

function opensTag(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.endsWith('>') || /[/=-]>$/.test(trimmed)) return false;
  const tag = /^<([A-Za-z][\w.:-]*)/.exec(trimmed.slice(trimmed.lastIndexOf('<')));
  return tag !== null && !VOID_TAG.test(tag[1] as string);
}

function opensBlock(line: string, markup: boolean): boolean {
  const trimmed = line.trim();
  if (COMMENT_START.test(trimmed)) return false;
  return /[{([:]$/.test(trimmed) || trimmed.endsWith('=>') || unclosedOpeners(trimmed) > 0 || (markup && opensTag(trimmed));
}

function startsWithCloser(line: string, markup: boolean): boolean {
  const trimmed = line.trimStart();
  return /^[)\]}]/.test(trimmed) || (markup && trimmed.startsWith('</'));
}

function reindent(text: string, linePrefix: string, style: IndentStyle, markup: boolean): string {
  const lines = text.split('\n');
  if (lines.length < 2) return text;
  const anchorIndex = lines.findIndex((line, index) => index >= 1 && line.trim() !== '');
  if (anchorIndex < 0) return lines[0] ?? '';

  const tabSize = Math.max(1, style.tabSize);
  const widths = lines.map((line) => widthOf(leadingWhitespace(line), tabSize));
  const anchorWidth = widths[anchorIndex] as number;

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
    currentWidth + (opensBlock(currentLine, markup) ? tabSize : 0) - (startsWithCloser(anchorLine, markup) ? tabSize : 0),
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

function removeSuffixOverlap(text: string, linePrefix: string, suffix: string, tabSize: number): string {
  const newline = suffix.indexOf('\n');
  const rest = (newline < 0 ? suffix : suffix.slice(0, newline)).trim();

  if (rest) {
    const closes = unmatchedCloserIndex(text);
    if (closes >= 0 && text[closes] === rest[0]) {
      const beyond = text.slice(closes + 1) + rest;
      if (hasUnmatchedCloser(beyond) || unclosedOpeners(beyond) > 0) return text.slice(0, closes).trimEnd();
    }
    for (let size = Math.min(rest.length, text.length); size >= 1; size--) {
      const overlap = rest.slice(0, size);
      if (!text.endsWith(overlap)) continue;
      const before = text[text.length - size - 1];
      if (before !== undefined && WORD_CHAR.test(before) && WORD_CHAR.test(overlap[0] as string)) continue;
      if (/^[)\]}'"`;,\s]+$/.test(overlap) && !hasUnmatchedCloser(text) && !/^['"`;,\s]+$/.test(overlap)) return text;
      return text.slice(0, text.length - size).trimEnd();
    }
    return text;
  }

  const following = (newline < 0 ? '' : suffix.slice(newline + 1)).split('\n').filter((line) => line.trim() !== '');
  if (following.length === 0) return text;
  const lines = text.split('\n');
  const contentIndexes = lines.flatMap((line, index) => (line.trim() !== '' ? [index] : []));
  const unmatched = hasUnmatchedCloser(text);
  const indentOf = (index: number): number =>
    widthOf(leadingWhitespace(index === 0 ? linePrefix : (lines[index] as string)), tabSize);

  for (let count = Math.min(contentIndexes.length, following.length, 8); count >= 1; count--) {
    const tail = contentIndexes.slice(-count);
    const matches = tail.every((lineIndex, i) => {
      if (lineIndex === 0 && linePrefix.trim() !== '') return false;
      const mine = (lines[lineIndex] as string).trim();
      const theirs = following[i] as string;
      if (mine !== theirs.trim()) return false;
      if (!CLOSERS_ONLY.test(mine)) return true;
      return indentOf(lineIndex) === widthOf(leadingWhitespace(theirs), tabSize);
    });
    if (!matches) continue;
    const onlyClosers = tail.every((lineIndex) => CLOSERS_ONLY.test((lines[lineIndex] as string).trim()));
    if (onlyClosers && !unmatched) return text;
    return lines.slice(0, tail[0]).join('\n').trimEnd();
  }
  return text;
}

export function trimAgainstSuffix(text: string, prefix: string, suffix: string, indent: IndentStyle): string {
  return removeSuffixOverlap(text, lastLine(prefix), suffix, Math.max(1, indent.tabSize));
}

export function cleanBlock(raw: string, languageId?: string): string {
  let text = stripCodeFences(raw.replace(/\r\n?/g, '\n'));
  const wrapped = /^\s*<region>\n?([\s\S]*?)\n?<\/region>\s*$/.exec(text);
  if (wrapped) text = wrapped[1] ?? '';
  if (PROMPT_ECHO.test(text) || isChatter(text, '')) return '';
  if (!(languageId && PROSE_LANGUAGES.has(languageId))) text = cutAtSelfTalk(text, '', '');
  text = cutAtProse(text, '', '', languageId);
  return text.replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');
}

function headEnd(line: string, head: string): number | 'partial' | null {
  let i = 0;
  let j = 0;
  while (j < head.length) {
    if (i < line.length && line[i] === head[j]) {
      i++;
      j++;
    } else if (/\s/.test(head[j] as string)) {
      j++;
    } else if (i < line.length && /\s/.test(line[i] as string)) {
      i++;
    } else {
      return i >= line.length ? 'partial' : null;
    }
  }
  return i;
}

const reversed = (text: string): string => [...text].reverse().join('');

export function insertionFromLine(answer: string, before: string, after: string): string {
  const line = firstLine(answer);
  const head = before.trimStart();
  const tail = after.trimEnd();
  if (line.length > head.length + tail.length && line.startsWith(head) && line.endsWith(tail)) {
    return line.slice(head.length, line.length - tail.length);
  }
  const start = headEnd(line, head);
  const fromEnd = headEnd(reversed(line), reversed(tail));
  if (typeof start !== 'number' || typeof fromEnd !== 'number' || start + fromEnd >= line.length) return '';
  const insertion = line.slice(start, line.length - fromEnd);
  return insertion.trim() ? insertion : '';
}

function firstLine(answer: string): string {
  const cleaned = stripCodeFences(answer.replace(/\r\n?/g, '\n')).replace(/▮/g, '');
  return (cleaned.split('\n').find((candidate) => candidate.trim() !== '') ?? '').trim();
}

export function insertionSoFar(partial: string, before: string): string | null {
  const line = firstLine(partial);
  const head = before.trimStart();
  if (line.startsWith(head)) return line.slice(head.length);
  if (head.startsWith(line)) return '';
  const start = headEnd(line, head);
  return start === 'partial' ? '' : start === null ? null : line.slice(start);
}

export function bareInsertion(answer: string, before: string, after: string): string {
  const candidate = cutAtFormatTag(firstLine(answer), undefined).trim();
  const head = before.trimStart();
  if (!candidate || candidate.length > 40 || EMPTY_MARKERS.has(candidate)) return '';
  const tail = after.trim();
  if (tail.length >= 3 && candidate.includes(tail)) return '';
  const words = candidate.match(/[A-Za-z_$][\w$]{2,}/g) ?? [];
  return words.some((word) => head.includes(word)) ? '' : candidate;
}

export function exceedsUsefulLength(text: string, maxLines: number): boolean {
  return text.length > Math.max(600, maxLines * 200) || text.split('\n').length > maxLines + 3;
}

const NOTE = /<note>\s*([\s\S]*?)\s*<\/note>/i;
const ASIDE = /^\s*<(note|change)\b/i;
const MAX_NOTE_CHARS = 180;
const MAX_CHANGE_CHARS = 3000;

const OWN_TAG_LANGUAGES = new Set(['xml', 'xsl', 'xaml', 'svg']);

export function isAside(text: string, languageId?: string): boolean {
  return ASIDE.test(text) && !(languageId && OWN_TAG_LANGUAGES.has(languageId));
}

export function shouldStopEarly(
  text: string,
  context: { maxLines: number; prefix: string; languageId?: string },
): boolean {
  const aside = isAside(text, context.languageId) ? ASIDE.exec(text)?.[1]?.toLowerCase() : undefined;
  if (aside) return text.toLowerCase().includes(`</${aside}>`) || text.length > (aside === 'note' ? MAX_NOTE_CHARS * 3 : MAX_CHANGE_CHARS);
  if (exceedsUsefulLength(text, context.maxLines)) return true;
  const normalized = text.replace(/\r\n?/g, '\n');
  const kept = cutAtProse(normalized, context.prefix, lastLine(context.prefix).trim(), context.languageId);
  return kept.length < normalized.length;
}

const COLON_OPENS_BLOCK = new Set(['python', 'yaml', 'coffeescript', 'nim', 'gdscript']);

function startsOnNextLine(text: string, linePrefix: string, suffix: string, input: PostprocessInput): boolean {
  const newline = suffix.indexOf('\n');
  if ((newline < 0 ? suffix : suffix.slice(0, newline)).trim() !== '') return false;
  const lead = leadingWhitespace(text);
  if (lead.includes('\t')) return true;
  if (!input.indent.insertSpaces || lead.length < 2) return false;
  if (/[=,+\-*/%<>!&|?]\s*$/.test(linePrefix)) return false;
  if (/:\s*$/.test(linePrefix) && !(input.languageId && COLON_OPENS_BLOCK.has(input.languageId))) return false;
  return lead.length >= leadingWhitespace(linePrefix).length;
}

export function noteFrom(raw: string, prefix: string, languageId?: string): string | undefined {
  const text = raw.replace(/\r\n?/g, '\n').trim();
  if (languageId && OWN_TAG_LANGUAGES.has(languageId)) return undefined;
  const explicit = NOTE.exec(text)?.[1];
  const clip = (note: string): string | undefined => {
    const flat = note.replace(/\s+/g, ' ').trim();
    if (!flat) return undefined;
    return flat.length > MAX_NOTE_CHARS ? `${flat.slice(0, MAX_NOTE_CHARS - 1).trimEnd()}…` : flat;
  };
  if (explicit !== undefined) return clip(explicit);

  const lineContent = lastLine(prefix).trim();
  if ((languageId && PROSE_LANGUAGES.has(languageId)) || COMMENT_START.test(lineContent) || insideCommentBlock(prefix)) return undefined;
  if ((lineContent.match(/["'`]/g)?.length ?? 0) % 2 === 1) return undefined;
  const first = text.split('\n')[0] ?? '';
  if (!looksLikeProse(first) || isChatter(first, lineContent) || SELF_TALK.test(first)) return undefined;
  if (!/`[^`]+`/.test(first)) return undefined;
  const sentence = /^(.+?)(?:[.;:](?:\s|$)|$)/.exec(first)?.[1] ?? first;
  return clip(sentence);
}

const CLOSER_LINE = /^\s*[)\]}]+[;,]?\s*$/;

function limitLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  let limit = Math.max(1, maxLines) + (lines[0] === '' ? 1 : 0);
  if (lines.length <= limit) return text;
  let kept = lines.slice(0, limit).join('\n');
  while (limit < lines.length && CLOSER_LINE.test(lines[limit] as string) && unclosedOpeners(kept) > 0) {
    kept += `\n${lines[limit]}`;
    limit++;
  }
  return kept;
}

export function postprocess(input: PostprocessInput): string {
  const { prefix, suffix, indent } = input;
  const linePrefix = lastLine(prefix);
  const lineContent = linePrefix.trim();
  const tabSize = Math.max(1, indent.tabSize);

  let text = input.raw.replace(/\r\n?/g, '\n');
  if (isAside(text, input.languageId)) return '';
  text = extractMarkedAnswer(text);
  text = stripCodeFences(text, lineContent).replace(/<cursor\s*\/>/g, '');
  text = cutAtFormatTag(text, input.languageId);
  if (PROMPT_ECHO.test(text)) return '';
  text = removeStrayClosingTag(text, input.languageId);
  text = text.replace(/^(?:\\[st])+/, '');
  if (isChatter(text, lineContent)) return '';
  if (!(input.languageId && PROSE_LANGUAGES.has(input.languageId))) text = cutAtSelfTalk(text, prefix, lineContent);
  text = cutAtProse(text, prefix, lineContent, input.languageId);
  let spaceAtEnd = /\S[ \t]+$/.test(text);
  text = text.replace(/\s+$/, '');
  if (!text.trim()) return '';

  if (lineContent === '') {
    text = text.replace(/^\s+/, '');
    text = removeRepeatedPreviousLines(text, prefix);
  } else {
    const blankLead = /^(?:[ \t]*\n)+/.exec(text);
    if (blankLead) {
      text = '\n' + text.slice(blankLead[0].length);
    } else if (startsOnNextLine(text, linePrefix, suffix, input)) {
      text = '\n' + text;
    } else {
      text = /\s$/.test(linePrefix) ? text.replace(/^[ \t]+/, '') : text.replace(/^\t+/, '');
      text = removePrefixOverlap(text, linePrefix);
      text = removeRestatedOpener(text, linePrefix, input.languageId);
    }
  }
  if (!text.trim()) return '';

  const reindented = reindent(text, linePrefix, indent, hasMarkup(input.languageId));
  text = removeSuffixOverlap(reindented, linePrefix, suffix, tabSize);
  if (text.length < reindented.length && /[ \t]/.test(reindented[text.length] ?? '')) spaceAtEnd = true;
  text = limitLines(text, input.maxLines).replace(/\s+$/, '');
  if (!text.trim()) return '';

  const newline = suffix.indexOf('\n');
  const rest = newline < 0 ? suffix : suffix.slice(0, newline);
  if (!text.includes('\n') && rest.trim() !== '' && rest.trimStart().startsWith(text.trim())) return '';

  const codeFollows = !text.includes('\n') && rest !== '' && !/^[\s)\]}.,;:]/.test(rest);
  if (codeFollows && (spaceAtEnd || SPACED_END.test(linePrefix + text))) return text + ' ';

  return text;
}
