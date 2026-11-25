import * as vscode from 'vscode';

const SHOWN_MS = 15_000;
const INLINE_CHARS = 110;

export class NoteHint {
  private readonly style: vscode.TextEditorDecorationType;
  private shown: { editor: vscode.TextEditor; line: number } | null = null;
  private timer: NodeJS.Timeout | undefined;

  constructor(extensionUri: vscode.Uri) {
    this.style = vscode.window.createTextEditorDecorationType({
      before: {
        contentIconPath: vscode.Uri.joinPath(extensionUri, 'resources', 'note.svg'),
        margin: '0 0.4em 0 2.5em',
        textDecoration: 'none; vertical-align: middle',
      },
      after: {
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
        fontStyle: 'italic',
      },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
  }

  get text(): string | undefined {
    return this.shown ? this.current : undefined;
  }

  private current = '';

  show(document: vscode.TextDocument, position: vscode.Position, note: string): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== document || editor.selection.active.line !== position.line) return;
    this.clear();
    const end = document.lineAt(position.line).range.end;
    const hover = new vscode.MarkdownString();
    hover.appendText(note);
    const inline = note.length > INLINE_CHARS ? `${note.slice(0, INLINE_CHARS - 1).trimEnd()}…` : note;
    editor.setDecorations(this.style, [
      { range: new vscode.Range(end, end), hoverMessage: hover, renderOptions: { after: { contentText: inline } } },
    ]);
    this.shown = { editor, line: position.line };
    this.current = note;
    this.timer = setTimeout(() => this.clear(), SHOWN_MS);
    this.timer.unref();
  }

  documentChanged(document: vscode.TextDocument): void {
    if (this.shown?.editor.document === document) this.clear();
  }

  selectionChanged(editor: vscode.TextEditor): void {
    if (this.shown && this.shown.editor === editor && editor.selection.active.line !== this.shown.line) this.clear();
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.shown?.editor.setDecorations(this.style, []);
    this.shown = null;
  }

  dispose(): void {
    this.clear();
    this.style.dispose();
  }
}
