import * as cp from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';

type ExecResult = {
	code: number|null; stdout: string; stderr: string;
};

function runTool(cmd: string, args: string[], cwd: string): Promise<ExecResult> {
	return new Promise((resolve) => {
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
			resolve({code, stdout, stderr});
		});
	});
}

async function collectCppFiles(folder: vscode.WorkspaceFolder, fileGlobs: string[], excludeGlobs: string[]): Promise<vscode.Uri[]> {
	const files: vscode.Uri[] = [];

	for (const pattern of fileGlobs) {
		const uris = await vscode.workspace.findFiles(pattern, excludeGlobs.join(','));
		// Только файлы внутри текущего workspaceFolder
		for (const uri of uris) {
			if (uri.fsPath.startsWith(folder.uri.fsPath)) {
				files.push(uri);
			}
		}
	}

	return files;
}

async function fixWorkspaceGoogleStyle(): Promise<void> {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders || folders.length === 0) {
		vscode.window.showErrorMessage('Нет открытого workspace: нечего форматировать.');
		return;
	}

	const config = vscode.workspace.getConfiguration('googleStyleFixer');
	const clangTidyPath = config.get<string>('clangTidyPath') || 'clang-tidy';
	const clangFormatPath = config.get<string>('clangFormatPath') || 'clang-format';
	const buildDir = config.get<string>('buildDir') || '';
	const fileGlobs = config.get<string[]>('fileGlobs') || ['**/*.{c,cc,cpp,cxx,h,hh,hpp,hxx,ixx}'];
	const excludeGlobs = config.get<string[]>('excludeGlobs') || ['**/{build,out,.git,.vscode}/**'];

	await vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: 'Google C++ Style Fixer', cancellable: false}, async (progress) => {
		let allFiles: vscode.Uri[] = [];
		for (const folder of folders) {
			const files = await collectCppFiles(folder, fileGlobs, excludeGlobs);
			allFiles = allFiles.concat(files);
		}

		if (allFiles.length === 0) {
			vscode.window.showInformationMessage('C/C++ файлов не найдено по заданным паттернам.');
			return;
		}

		const total = allFiles.length;
		let index = 0;

		for (const file of allFiles) {
			index++;
			const relative = vscode.workspace.asRelativePath(file);
			progress.report({message: `clang-tidy + clang-format: ${relative}`, increment: (index / total) * 100});

			const folder = folders.find(f => file.fsPath.startsWith(f.uri.fsPath)) || folders[0];
			const cwd = folder.uri.fsPath;

			const tidyArgs: string[] = ['-fix', '-quiet', file.fsPath];
			if (buildDir.trim().length > 0) {
				tidyArgs.splice(1, 0, `-p=${path.join(cwd, buildDir)}`);
			}

			const tidyResult = await runTool(clangTidyPath, tidyArgs, cwd);
			if (tidyResult.code !== 0) {
				const msg = `clang-tidy завершился с кодом ${tidyResult.code} для ${relative}`;
				console.error(msg, tidyResult.stderr);
				vscode.window.showWarningMessage(msg);
			}

			const formatArgs = ['-i', file.fsPath];
			const formatResult = await runTool(clangFormatPath, formatArgs, cwd);
			if (formatResult.code !== 0) {
				const msg = `clang-format завершился с кодом ${formatResult.code} для ${relative}`;
				console.error(msg, formatResult.stderr);
				vscode.window.showWarningMessage(msg);
			}
		}

		vscode.window.showInformationMessage('Google C++ Style Fixer: finished fixing.');
	});
}

export function activate(context: vscode.ExtensionContext) {
	const disposable = vscode.commands.registerCommand('googleStyleFixer.fixWorkspace', () => {
		fixWorkspaceGoogleStyle().catch((err) => {
			console.error('Ошибка при запуске Google Style Fixer', err);
			vscode.window.showErrorMessage(`Google Style Fixer: произошла ошибка, смотри консоль разработчика.`);
		});
	});

	context.subscriptions.push(disposable);
}
