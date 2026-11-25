import { withoutStructuralTags } from '../completion/promptBuilder';

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  diff: string;
}

export interface CommitPromptInput {
  files: readonly ChangedFile[];
  excluded: number;
  recent: readonly string[];
  maxChars?: number;
}

export const MAX_DIFF_CHARS = 14_000;
export const MAX_FILE_CHARS = 4_000;
const MAX_RECENT = 10;
const MAX_SUBJECT_CHARS = 120;

function attribute(value: string): string {
  return value.replace(/["<>\r\n]/g, ' ').trim();
}

function clip(diff: string, room: number): string {
  const text = withoutStructuralTags(diff.replace(/\r\n?/g, '\n')).replace(/<\/?(?:changes?|recent)\b[^>]*>/gi, '').trimEnd();
  if (text.length <= room) return text;
  const cut = text.slice(0, room);
  const lastLine = cut.lastIndexOf('\n');
  return `${lastLine > room / 2 ? cut.slice(0, lastLine) : cut}\n…`;
}

export function buildCommitPrompt(input: CommitPromptInput): { text: string; shown: number; listed: number } {
  let room = input.maxChars ?? MAX_DIFF_CHARS;
  const shown: string[] = [];
  const listed: string[] = [];
  for (const file of input.files) {
    const head = `<change path="${attribute(file.path)}" status="${file.status}">`;
    if (file.diff.trim() === '' || room < 200) {
      listed.push(`${head}</change>`);
      continue;
    }
    const body = clip(file.diff, Math.min(MAX_FILE_CHARS, room));
    room -= body.length;
    shown.push(`${head}\n${body}\n</change>`);
  }
  const recent = input.recent
    .map((subject) => clip(subject.split('\n')[0] ?? '', MAX_SUBJECT_CHARS).trim())
    .filter(Boolean)
    .slice(0, MAX_RECENT);
  const parts = [
    recent.length > 0 ? `<recent>\n${recent.join('\n')}\n</recent>` : '',
    `<changes>\n${[...shown, ...listed].join('\n')}\n</changes>`,
    input.excluded > 0 ? `${input.excluded} more file(s) changed whose content is private and not shown.` : '',
  ];
  return { text: parts.filter(Boolean).join('\n'), shown: shown.length, listed: listed.length };
}

const LABEL = /^(?:here(?:'s| is)[^\n:]*:|(?:commit )?message:|subject:)\s*/i;
const MAX_MESSAGE_LINES = 24;
const BODY_WIDTH = 72;

function wrap(line: string): string {
  if (line.length <= BODY_WIDTH) return line;
  const lead = /^\s*(?:[-*]\s+|\d+\.\s+)?/.exec(line)?.[0] ?? '';
  const hang = ' '.repeat(lead.length);
  const rows: string[] = [];
  let row = '';
  for (const word of line.slice(lead.length).split(/\s+/).filter(Boolean)) {
    const start = rows.length === 0 ? lead : hang;
    if (row && start.length + row.length + 1 + word.length > BODY_WIDTH) {
      rows.push(start + row);
      row = word;
    } else {
      row = row ? `${row} ${word}` : word;
    }
  }
  if (row) rows.push((rows.length === 0 ? lead : hang) + row);
  return rows.join('\n');
}

export function cleanCommitMessage(raw: string): string {
  let text = raw.replace(/\r\n?/g, '\n').trim();
  const fenced = /```[^\n`]*\n([\s\S]*?)\n?```/.exec(text);
  if (fenced) text = (fenced[1] ?? '').trim();
  text = text.replace(LABEL, '').trim();
  const quoted = /^(["'`])([\s\S]*)\1$/.exec(text);
  if (quoted && !(quoted[2] ?? '').includes('\n')) text = (quoted[2] ?? '').trim();
  const lines = text.split('\n').map((line) => line.trimEnd());
  const subject = (lines[0] ?? '').replace(/^#+\s*/, '').replace(/^\*\*(.+)\*\*$/, '$1').trim();
  if (!subject || /^<none\/?>$/i.test(subject)) return '';
  const body = lines.slice(1, MAX_MESSAGE_LINES).map(wrap).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return body ? `${subject}\n\n${body}` : subject;
}
