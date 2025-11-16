import * as cp from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';

type ExecResult = {
	code: number|null; stdout: string; stderr: string;
};

const outputChannel = vscode.window.createOutputChannel(
	'Google C++ Style Fixer',
);

// Для всех запусков с -fix: отключаем только readability-identifier-naming,
// но наследуем остальной конфиг из .clang-tidy
const NAMING_CONFIG_OVERRIDE = '{Checks: \'-readability-identifier-naming\', InheritParentConfig: true}';

function runTool(
	cmd: string,
	args: string[],
	cwd: string,
	): Promise<ExecResult> {
	return new Promise((resolve) => {
		outputChannel.appendLine(`$ ${cmd} ${args.join(' ')}  (cwd: ${cwd})`);

		const child = cp.spawn(cmd, args, {cwd});
		let stdout = '';
		let stderr = '';

		child.stdout.on('data', (data) => {
			stdout += data.toString();
		});
		child.stderr.on('data', (data) => {
			stderr += data.toString();
		});

		child.on('close', (code) => {
			if (stdout.trim().length > 0) {
				outputChannel.appendLine(`stdout:\n${stdout}`);
			}
			if (stderr.trim().length > 0) {
				outputChannel.appendLine(`stderr:\n${stderr}`);
			}
			outputChannel.appendLine(`exit code: ${code}`);
			outputChannel.appendLine('---');
			resolve({code, stdout, stderr});
		});
	});
}

/* ======== Сбор файлов для workspace-команды ======== */

async function collectCppFiles(
	folder: vscode.WorkspaceFolder,
	fileGlobs: string[],
	excludeGlobs: string[],
	): Promise<vscode.Uri[]> {
	const files: vscode.Uri[] = [];
	for (const pattern of fileGlobs) {
		const exclude = excludeGlobs.length > 0 ? excludeGlobs.join(',') : undefined;
		const uris = await vscode.workspace.findFiles(pattern, exclude);
		for (const uri of uris) {
			if (uri.fsPath.startsWith(folder.uri.fsPath)) {
				files.push(uri);
			}
		}
	}
	return files;
}

/* ======== Добивка стандартных инклюдов для всего workspace ======== */

const REQUIRED_HEADERS: {header: string; patterns: RegExp[]}[] = [
	{
		header: 'iostream',
		patterns: [/\bstd::(cout|cerr|clog|cin)\b/],
	},
	{
		header: 'string',
		patterns: [/\bstd::string\b/],
	},
	{
		header: 'vector',
		patterns: [/\bstd::vector\b/],
	},
	{
		header: 'array',
		patterns: [/\bstd::array\b/],
	},
	{
		header: 'map',
		patterns: [/\bstd::map\b/],
	},
	{
		header: 'unordered_map',
		patterns: [/\bstd::unordered_map\b/],
	},
	{
		header: 'set',
		patterns: [/\bstd::set\b/],
	},
	{
		header: 'unordered_set',
		patterns: [/\bstd::unordered_set\b/],
	},
	{
		header: 'optional',
		patterns: [/\bstd::optional\b/],
	},
	{
		header: 'memory',
		patterns: [/\bstd::unique_ptr\b/, /\bstd::shared_ptr\b/],
	},
	{
		header: 'thread',
		patterns: [/\bstd::thread\b/],
	},
	{
		header: 'mutex',
		patterns: [/\bstd::mutex\b/],
	},
	{
		header: 'ctring',
		patterns: [/\bstd::atoi\b/],
	},
	{
		header: 'ctring',
		patterns: [/\bstd::atol\b/],
	},
];

// Вставляем недостающие #include <...> в блок системных инклюдов
async function ensureStandardIncludes(file: vscode.Uri): Promise<void> {
	const doc = await vscode.workspace.openTextDocument(file);
	const originalText = doc.getText();
	let text = originalText;

	if (text.length === 0) {
		return;
	}

	// Собираем уже существующие инклюды
	const existingStd = new Set<string>();
	const existingLocal = new Set<string>();

	const includeRe = /^\s*#\s*include\s*([<"])\s*([^>"]+)\s*[>"].*$/gm;
	let m: RegExpExecArray|null;
	while ((m = includeRe.exec(text)) !== null) {
		const kind = m[1];
		const name = m[2].trim();
		if (kind === '<') {
			existingStd.add(name);
		} else {
			existingLocal.add(name);
		}
	}

	// Определяем, какие заголовки нужны по использованию std::...
	const needed: string[] = [];
	for (const entry of REQUIRED_HEADERS) {
		const headerName = entry.header;
		if (existingStd.has(headerName)) {
			continue;
		}
		// Если хотя бы один паттерн совпал — заголовок нужен
		let found = false;
		for (const r of entry.patterns) {
			if (r.test(text)) {
				found = true;
				break;
			}
		}
		if (found) {
			needed.push(headerName);
		}
	}

	if (needed.length === 0) {
		return;
	}

	needed.sort();

	const lines = text.split(/\r?\n/);

	let firstInclude = -1;
	let lastStdInclude = -1;
	let firstLocalInclude = -1;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const m2 = /^\s*#\s*include\s*([<"])\s*([^>"]+)\s*[>"].*$/.exec(line);
		if (!m2) {
			continue;
		}
		const kind = m2[1];

		if (firstInclude === -1) {
			firstInclude = i;
		}
		if (kind === '<') {
			lastStdInclude = i;
		} else if (kind === '"') {
			if (firstLocalInclude === -1) {
				firstLocalInclude = i;
			}
		}
	}

	let insertIndex = 0;
	if (lastStdInclude >= 0) {
		// есть хотя бы один системный include: вставляем СРАЗУ после него
		insertIndex = lastStdInclude + 1;
	} else if (firstLocalInclude >= 0) {
		// нет системных, но есть локальные: вставляем ПЕРЕД первым локальным
		insertIndex = firstLocalInclude;
	} else if (firstInclude >= 0) {
		// какой-то include есть, но непонятный случай: вставляем перед ним
		insertIndex = firstInclude;
	} else {
		// вообще нет include — вставляем в начало файла
		insertIndex = 0;
	}

	const newLines = needed.map((h) => `#include <${h}>`);

	lines.splice(insertIndex, 0, ...newLines);

	const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
	const newText = lines.join(eol);

	if (newText === originalText) {
		return;
	}

	const fullRange = new vscode.Range(
		doc.positionAt(0),
		doc.positionAt(originalText.length),
	);

	const edit = new vscode.WorkspaceEdit();
	edit.replace(file, fullRange, newText);
	await vscode.workspace.applyEdit(edit);
	await doc.save();
}

/* ======== Workspace-команда: clang-tidy + includes + clang-format ======== */

async function fixFilesGoogleStyle(
	files: vscode.Uri[],
	folders: readonly vscode.WorkspaceFolder[],
	title: string,
	): Promise<void> {
	if (files.length === 0) {
		vscode.window.showInformationMessage(
			`${title}: no C/C++ files to process.`,
		);
		return;
	}

	const config = vscode.workspace.getConfiguration('googleStyleFixer');
	const clangTidyPath = config.get<string>('clangTidyPath') || 'clang-tidy';
	const clangFormatPath = config.get<string>('clangFormatPath') || 'clang-format';
	const buildDir = config.get<string>('buildDir') || '';

	outputChannel.appendLine(
		`Starting ${title} for ${files.length} file(s).`,
	);
	outputChannel.show(true);

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title,
			cancellable: false,
		},
		async (progress) => {
			const total = files.length;
			let processed = 0;

			for (const file of files) {
				processed++;
				const relative = vscode.workspace.asRelativePath(file);
				progress.report({
					message: relative,
					increment: (processed / total) * 100,
				});

				const folder = folders.find((f) => file.fsPath.startsWith(f.uri.fsPath)) || folders[0];
				const cwd = folder.uri.fsPath;

				// clang-tidy с fix-its, но с отключённым naming-чеком
				const tidyArgs: string[] = [
					'-fix',
					'-fix-errors',
				];
				if (buildDir.trim().length > 0) {
					tidyArgs.push(`-p=${path.join(cwd, buildDir)}`);
				}
				tidyArgs.push(
					`-config=${NAMING_CONFIG_OVERRIDE}`,
					'-quiet',
					file.fsPath,
					'--',
					'-std=c++20',
				);

				const tidyResult = await runTool(
					clangTidyPath,
					tidyArgs,
					cwd,
				);
				if (tidyResult.code !== 0) {
					const msg = `clang-tidy exited with code ${tidyResult.code} for ${relative}`;
					outputChannel.appendLine(msg);
					vscode.window.showWarningMessage(msg);
				}

				// Добавляем недостающие стандартные #include <...>
				await ensureStandardIncludes(file);

				// clang-format in-place
				const formatArgs = ['-i', file.fsPath];
				const formatResult = await runTool(
					clangFormatPath,
					formatArgs,
					cwd,
				);
				if (formatResult.code !== 0) {
					const msg = `clang-format exited with code ${formatResult.code} for ${relative}`;
					outputChannel.appendLine(msg);
					vscode.window.showWarningMessage(msg);
				}
			}

			vscode.window.showInformationMessage(`${title}: done.`);
		},
	);
}

async function fixWorkspaceGoogleStyle(): Promise<void> {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders || folders.length === 0) {
		vscode.window.showErrorMessage('No workspace folder is open.');
		return;
	}

	const config = vscode.workspace.getConfiguration('googleStyleFixer');
	const fileGlobs = config.get<string[]>('fileGlobs') || ['**/*.{c,cc,cpp,cxx,h,hh,hpp,hxx,ixx}'];
	const excludeGlobs = config.get<string[]>('excludeGlobs') || ['**/{build,out,.git,.vscode}/**'];

	let allFiles: vscode.Uri[] = [];
	for (const folder of folders) {
		const files = await collectCppFiles(
			folder,
			fileGlobs,
			excludeGlobs,
		);
		allFiles = allFiles.concat(files);
	}

	await fixFilesGoogleStyle(
		allFiles,
		folders,
		'Google C++ Style Fixer (Workspace)',
	);
}

/* ======== Нейминг для текущего файла (через Rename Symbol) ======== */

type NamingDiag = {
	file: string; line: number; col: number; symbol: string; kind: string;
};

function toLowerSnake(s: string): string {
	let out = s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2');
	out = out.replace(/[\s\-]+/g, '_').replace(/__+/g, '_').toLowerCase();
	return out;
}

function toPascalCase(s: string): string {
	const parts = s.split(/[_\s\-]+/).filter(Boolean);
	return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join('');
}

function toLowerCamelFromSnake(s: string): string {
	const pascal = toPascalCase(s);
	return pascal.length > 0 ? pascal.charAt(0).toLowerCase() + pascal.slice(1) : pascal;
}

// функции в PascalCase, константы в kPascalCase, переменные — в lower_snake_case
function inferTargetName(kind: string, current: string): string|null {
	const k = kind.toLowerCase();
	const baseSnake = toLowerSnake(current);

	// 1) Структуры / классы / типы → PascalCase (Int2025T, BigThing, MyType)
	if (k.includes('struct') || k.includes('class') || k.includes('type')) {
		return toPascalCase(baseSnake);
	}

	// 2) Константы (включая enum) → kPascalCase (kMaxSize, kDefaultTimeout)
	if (k.includes('enum constant') || k.includes('global constant') || k.includes('static constant') || k.includes('constant')) {
		const pascal = toPascalCase(baseSnake);									  // MaxSize
		const res = pascal.length > 0 ? 'k' + pascal.charAt(0) + pascal.slice(1)  // kMaxSize
										:
										'k';
		return res;
	}

	// 3) Функции / методы → PascalCase (Popcount, DoSomethingNice)
	if (k.includes('function') || k.includes('method')) {
		return toPascalCase(baseSnake);
	}

	// 4) Переменные / параметры / поля / namespaces → lower_snake_case
	if (k.includes('variable') || k.includes('parameter') || k.includes('private member') || k.includes('protected member') || k.includes('global variable') || k.includes('namespace')) {
		return baseSnake;  // value_count
	}

	return null;
}

function parseNamingDiagnostics(tidyOutput: string): NamingDiag[] {
	const out: NamingDiag[] = [];
	const re = /^(.+?):(\d+):(\d+):\s+warning: (.+?) \[readability-identifier-naming\]$/gm;

	for (const m of tidyOutput.matchAll(re)) {
		const file = m[1];
		const line = parseInt(m[2], 10);
		const col = parseInt(m[3], 10);
		const msg = m[4];

		const m2 = /(invalid case style for|wrong case for|not following naming convention for)\s+([a-zA-Z ]+)\s+'([^']+)'/i.exec(
			msg,
		);
		if (m2) {
			out.push({
				file,
				line,
				col,
				kind: m2[2].trim(),
				symbol: m2[3],
			});
		} else {
			out.push({
				file,
				line,
				col,
				kind: 'identifier',
				symbol: '',
			});
		}
	}
	return out;
}

async function runTidyNoFixOnFile(
	file: string,
	cwd: string,
	clangTidyPath: string,
	buildDir: string,
	): Promise<string> {
	const args: string[] = [];
	if (buildDir.trim().length > 0) {
		args.push(`-p=${path.join(cwd, buildDir)}`);
	}

	const ext = path.extname(file).toLowerCase();
	const isHeader = ['.h', '.hh', '.hpp', '.hxx', '.ixx'].includes(ext);

	// Базовые аргументы clang-tidy
	args.push(file, '--format-style=file', '--header-filter=.*', '--');

	// Аргументы компилятора: для заголовков принудительно говорим "это C++-header"
	if (isHeader) {
		args.push('-x', 'c++-header', '-std=c++20');
	} else {
		args.push('-std=c++20');
	}

	const res = await runTool(clangTidyPath, args, cwd);
	return (res.stdout || '') + '\n' + (res.stderr || '');
}

/* ======== Текущий файл: нейминг + стиль ======== */

async function fixCurrentFileGoogleStyle(): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showErrorMessage('Open a C/C++ file.');
		return;
	}

	const doc = editor.document;
	const file = doc.fileName;

	const folder = vscode.workspace.getWorkspaceFolder(doc.uri) || vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		vscode.window.showErrorMessage('No workspace folder is open.');
		return;
	}
	const cwd = folder.uri.fsPath;

	const config = vscode.workspace.getConfiguration('googleStyleFixer');
	const clangTidyPath = config.get<string>('clangTidyPath') || 'clang-tidy';
	const clangFormatPath = config.get<string>('clangFormatPath') || 'clang-format';
	const buildDir = config.get<string>('buildDir') || '';

	await doc.save();
	outputChannel.show(true);

	// 1) Собираем naming-диагностику
	const combined = await runTidyNoFixOnFile(file, cwd, clangTidyPath, buildDir);
	const diags = parseNamingDiagnostics(combined).filter(
		(d) => path.normalize(d.file) === path.normalize(file),
	);

	if (diags.length > 0) {
		// снизу вверх, один раз на символ
		diags.sort((a, b) => b.line - a.line || b.col - a.col);
		const seen = new Set<string>();
		let applied = 0;

		for (const d of diags) {
			if (!d.symbol) {
				continue;
			}
			const key = `${d.kind}::${d.symbol}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);

			const liveDoc = await vscode.workspace.openTextDocument(doc.uri);
			const liveEditor = await vscode.window.showTextDocument(liveDoc, {
				preview: false,
			});

			const pos = new vscode.Position(
				Math.max(0, d.line - 1),
				Math.max(0, d.col - 1),
			);
			const range = liveEditor.document.getWordRangeAtPosition(pos) || new vscode.Range(pos, pos.translate(0, 1));
			const currentText = liveEditor.document.getText(range) || d.symbol;
			const target = inferTargetName(d.kind, currentText);
			if (!target || target === currentText) {
				continue;
			}

			try {
				const edit = (await vscode.commands.executeCommand(
								 'vscode.executeDocumentRenameProvider',
								 liveDoc.uri,
								 range.start,
								 target,
								 )) as vscode.WorkspaceEdit |
					undefined;

				if (edit) {
					const ok = await vscode.workspace.applyEdit(edit);
					if (ok) {
						applied++;
						await liveDoc.save();
					}
				}
			} catch {
				// если язык-сервер не смог — пропускаем
			}
		}

		if (applied > 0) {
			vscode.window.showInformationMessage(
				`Applied ${applied} rename(s) via language-server rename.`,
			);
		} else {
			vscode.window.showInformationMessage('No safe renames applied.');
		}
	} else {
		vscode.window.showInformationMessage('No naming violations detected.');
	}

	// 2) clang-tidy с -fix, но с отключённым naming-чеком
	{
		const args: string[] = [
			'-fix',
			'-fix-errors',
		];
		if (buildDir.trim().length > 0) {
			args.push(`-p=${path.join(cwd, buildDir)}`);
		}

		const ext = path.extname(file).toLowerCase();
		const isHeader = ['.h', '.hh', '.hpp', '.hxx', '.ixx'].includes(ext);

		args.push(
			`-config=${NAMING_CONFIG_OVERRIDE}`,
			'-quiet',
			file,
			'--',
		);

		if (isHeader) {
			args.push('-x', 'c++-header', '-std=c++20');
		} else {
			args.push('-std=c++20');
		}

		await runTool(clangTidyPath, args, cwd);
	}

	// 3) финальный clang-format
	{
		await runTool(clangFormatPath, ['-i', file], cwd);
		const finalDoc = await vscode.workspace.openTextDocument(doc.uri);
		await finalDoc.save();
	}

	vscode.window.showInformationMessage(
		'Google C++ Style Fixer: current file formatted with naming updates.',
	);
}

/* ================== activation ================== */

export function activate(context: vscode.ExtensionContext) {
	const fixWorkspaceCmd = vscode.commands.registerCommand(
		'googleStyleFixer.fixWorkspace',
		() => {
			fixWorkspaceGoogleStyle().catch((err) => {
				outputChannel.appendLine(
					`Error in fixWorkspace: ${String(err)}`,
				);
				vscode.window.showErrorMessage(
					'Google C++ Style Fixer: error, see output channel.',
				);
			});
		},
	);

	const fixCurrentCmd = vscode.commands.registerCommand(
		'googleStyleFixer.fixAndRenameCurrentFile',
		() => {
			fixCurrentFileGoogleStyle().catch((err) => {
				outputChannel.appendLine(
					`Error in fixCurrentFile: ${String(err)}`,
				);
				vscode.window.showErrorMessage(
					'Google C++ Style Fixer (Current File): error, see output channel.',
				);
			});
		},
	);

	context.subscriptions.push(fixWorkspaceCmd, fixCurrentCmd);
}

export function deactivate() {
	// nothing special
}
