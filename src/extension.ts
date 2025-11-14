import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as yaml from 'yaml';

const execFileAsync = promisify(execFile);
const diags = vscode.languages.createDiagnosticCollection('gcs-tidy');

export function activate(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.commands.registerCommand('gcs.writeClangFormat', writeClangFormat),
    vscode.commands.registerCommand('gcs.writeClangTidy', writeClangTidy),
    vscode.commands.registerCommand('gcs.formatCurrent', formatCurrent),
    vscode.commands.registerCommand('gcs.enforceStyleCurrent', enforceStyleCurrent),
    diags
  );
}

export function deactivate() {}

async function ws(): Promise<vscode.WorkspaceFolder> {
  const ws = vscode.workspace.workspaceFolders;
  if (!ws || ws.length === 0) throw new Error('Open a folder workspace.');
  return ws[0];
}
function cfg(w: vscode.WorkspaceFolder) { return vscode.workspace.getConfiguration('gcs', w); }
function tmp(suffix: string) { return path.join(os.tmpdir(), `gcs-${crypto.randomBytes(6).toString('hex')}-${suffix}`); }

async function writeClangFormat() {
  const w = await ws();
  const uri = vscode.Uri.joinPath(w.uri, '.clang-format');
  const content = Buffer.from(
`BasedOnStyle: Google
IndentWidth: 2
TabWidth: 2
UseTab: Never
ColumnLimit: 80
DerivePointerAlignment: false
PointerAlignment: Left
SortIncludes: true
IncludeBlocks: Regroup
FixNamespaceComments: true
SpacesInParentheses: false
SpacesInAngles: false
AllowShortIfStatementsOnASingleLine: false
AllowShortLoopsOnASingleLine: false
BreakBeforeBraces: Attach
`);
  await vscode.workspace.fs.writeFile(uri, content);
  await vscode.window.showTextDocument(uri);
  vscode.window.showInformationMessage('.clang-format (Google) written.');
}

async function writeClangTidy() {
  const w = await ws();
  const uri = vscode.Uri.joinPath(w.uri, '.clang-tidy');
  const content = Buffer.from(
`Checks: >
  -readability-braces-around-statements,
  -readability-identifier-naming
WarningsAsErrors: ''
HeaderFilterRegex: ''
FormatStyle: none
CheckOptions:
  - key: readability-braces-around-statements.ShortStatementLines
    value: '0'
  - key: readability-identifier-naming.NamespaceCase
    value: lower_case
  - key: readability-identifier-naming.ClassCase
    value: CamelCase
  - key: readability-identifier-naming.StructCase
    value: CamelCase
  - key: readability-identifier-naming.EnumCase
    value: CamelCase
  - key: readability-identifier-naming.EnumConstantCase
    value: kCamelCase
  - key: readability-identifier-naming.FunctionCase
    value: CamelCase
  - key: readability-identifier-naming.MethodCase
    value: CamelCase
  - key: readability-identifier-naming.VariableCase
    value: lower_case
  - key: readability-identifier-naming.PrivateMemberCase
    value: lower_case
  - key: readability-identifier-naming.ProtectedMemberCase
    value: lower_case
  - key: readability-identifier-naming.MemberPrefix
    value: ''
  - key: readability-identifier-naming.ConstexprVariableCase
    value: kCamelCase
  - key: readability-identifier-naming.ConstantCase
    value: kCamelCase
  - key: readability-identifier-naming.StaticConstantCase
    value: kCamelCase
  - key: readability-identifier-naming.GlobalConstantCase
    value: kCamelCase
  - key: readability-identifier-naming.GlobalVariableCase
    value: lower_case
  - key: readability-identifier-naming.ParameterCase
    value: lower_case
  - key: readability-identifier-naming.MacroDefinitionCase
    value: UPPER_CASE
  - key: readability-identifier-naming.IgnoreMainLikeFunctions
    value: 'true'
`);
  await vscode.workspace.fs.writeFile(uri, content);
  await vscode.window.showTextDocument(uri);
  vscode.window.showInformationMessage('.clang-tidy (Google naming + braces) written.');
}

async function formatCurrent() {
  const w = await ws();
  const ed = vscode.window.activeTextEditor;
  if (!ed) { vscode.window.showErrorMessage('Open a C/C++ file.'); return; }
  if (ed.document.isDirty) await ed.document.save();

  const bin = cfg(w).get<string>('format.path', 'clang-format')!;
  const stylePath = cfg(w).get<string>('format.stylePath', '');
  const styleArg = stylePath ? `file:${stylePath}` : 'file';  // falls back to nearest .clang-format

  const { stdout } = await execFileAsync(bin, ['-style', styleArg, ed.document.fileName], { maxBuffer: 20 * 1024 * 1024 });
  const full = new vscode.Range(0, 0, ed.document.lineCount, 0);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(ed.document.uri, full, stdout);
  await vscode.workspace.applyEdit(edit);
  vscode.window.showInformationMessage('clang-format applied.');
}

async function enforceStyleCurrent() {
  const w = await ws();
  const ed = vscode.window.activeTextEditor;
  if (!ed) { vscode.window.showErrorMessage('Open a C/C++ file.'); return; }
  if (ed.document.languageId !== 'cpp' && ed.document.languageId !== 'c') {
    vscode.window.showErrorMessage('Not a C/C++ file.');
    return;
  }
  if (ed.document.isDirty) await ed.document.save();

  // 1) run clang-format first (pure layout changes)
  await formatCurrent();

  // 2) run clang-tidy for braces + naming only, then preview/apply fixes
  const tidy = cfg(w).get<string>('tidy.path', 'clang-tidy')!;
  const compileDbRel = cfg(w).get<string>('compileCommandsPath', 'build/compile_commands.json')!;
  const compileDb = path.isAbsolute(compileDbRel) ? compileDbRel : path.join(w.uri.fsPath, compileDbRel);
  const fixesPath = tmp('fixes.yaml');

  const args: string[] = [];
  if (fs.existsSync(compileDb)) args.push('-p', path.dirname(compileDb));
  args.push(
    ed.document.fileName,
    '-checks=readability-braces-around-statements,readability-identifier-naming',
    '--export-fixes=' + fixesPath,
    '--',
    '-std=c++20'
  );

  const term = vscode.window.createTerminal({ name: 'GCS: clang-tidy' });
  term.show(true);
  term.sendText([tidy, ...args].join(' '));

  const { stdout, stderr } = await execFileAsync(tidy, args, { maxBuffer: 20 * 1024 * 1024 });
  publishDiagnostics(ed.document.uri, stderr || stdout);

  if (!fs.existsSync(fixesPath)) {
    vscode.window.showInformationMessage('No clang-tidy style fixes to apply.');
    return;
  }

  const ok = await previewAndApplyFixes(fixesPath, ed.document.uri);
  if (ok) vscode.window.showInformationMessage('Google style fixes applied (naming + braces).');
  else vscode.window.showInformationMessage('No fixes applied.');
}

function publishDiagnostics(uri: vscode.Uri, text: string) {
  const out: vscode.Diagnostic[] = [];
  const re = /^(.+?):(\d+):(\d+):\s+(warning|error|note):\s+(.+?)(?:\s+\[([^\]]+)\])?$/gm;
  for (const m of text.matchAll(re)) {
    const line = Math.max(0, parseInt(m[2], 10) - 1);
    const col = Math.max(0, parseInt(m[3], 10) - 1);
    const sev = m[4] === 'error' ? vscode.DiagnosticSeverity.Error :
                m[4] === 'warning' ? vscode.DiagnosticSeverity.Warning :
                vscode.DiagnosticSeverity.Information;
    const msg = m[5].trim() + (m[6] ? ` [${m[6]}]` : '');
    out.push(new vscode.Diagnostic(new vscode.Range(line, col, line, col + 1), msg, sev));
  }
  diags.set(uri, out);
}

type Replacement = { FilePath: string; Offset: number; Length: number; ReplacementText: string; };
type TidyFix = { Diagnostics: Array<{ Replacements?: Replacement[] }> };

async function previewAndApplyFixes(fixesYamlPath: string, target: vscode.Uri): Promise<boolean> {
  const raw = fs.readFileSync(fixesYamlPath, 'utf8');
  const doc = yaml.parse(raw) as TidyFix | undefined;
  if (!doc || !doc.Diagnostics) return false;

  const reps: Replacement[] = [];
  for (const d of doc.Diagnostics) {
    for (const r of d.Replacements ?? []) {
      if (vscode.Uri.file(r.FilePath).fsPath === target.fsPath) reps.push(r);
    }
  }
  if (reps.length === 0) return false;

  // Show a quick summary before applying
  const count = reps.length;
  const choice = await vscode.window.showQuickPick(
    [
      { label: `Apply ${count} style edits (naming + braces)`, apply: true },
      { label: 'Cancel', apply: false }
    ],
    { placeHolder: 'Google Style Guard: apply clang-tidy style fixes?' }
  );
  if (!choice || !choice.apply) return false;

  const docText = (await vscode.workspace.openTextDocument(target)).getText();
  reps.sort((a, b) => b.Offset - a.Offset);

  const edit = new vscode.WorkspaceEdit();
  for (const r of reps) {
    const start = posFromOffset(docText, r.Offset);
    const end = posFromOffset(docText, r.Offset + r.Length);
    edit.replace(target, new vscode.Range(start, end), r.ReplacementText ?? '');
  }
  return vscode.workspace.applyEdit(edit);
}

function posFromOffset(text: string, offset: number): vscode.Position {
  let line = 0, col = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) { line++; col = 0; } else { col++; }
  }
  return new vscode.Position(line, col);
}
