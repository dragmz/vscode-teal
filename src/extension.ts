import * as vscode from 'vscode';

import fetch from 'node-fetch';

import { execFileSync } from 'child_process';
import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
} from 'vscode-languageclient/node';

import fs = require('fs');

const ext = process.platform === "win32" ? ".exe" : "";

async function download(path: vscode.Uri) {
	const name = `tealsp_${process.platform}_${process.arch}${ext}`;
	const url = `https://github.com/dragmz/teal/releases/download/dev/${name}`;

	const resp = await fetch(url);
	const buff = await resp.buffer();
	const data = new Uint8Array(buff);

	if (data) {
		const exists = await (async () => {
			try {
				await vscode.workspace.fs.stat(path);
				return true;
			} catch {
				return false;
			}
		})();

		if (exists) {
			await vscode.workspace.fs.delete(path);
		}

		await vscode.workspace.fs.writeFile(path, data);

		const stat = fs.statSync(path.fsPath);
		const modePlusX = stat.mode | fs.constants.S_IXUSR | fs.constants.S_IXGRP | fs.constants.S_IXOTH;

		fs.chmodSync(path.fsPath, modePlusX);
	}
}

export async function activate(context: vscode.ExtensionContext) {
	await vscode.workspace.fs.createDirectory(context.globalStorageUri);

	const clientOptions: LanguageClientOptions = {
		documentSelector: ['teal']
	};

	const dev = context.extensionMode !== vscode.ExtensionMode.Production;
	const uri = vscode.Uri.joinPath(context.globalStorageUri, `tealsp${ext}`);

	let path = "tealsp";
	let custom = true;

	await (async () => {
		try {
			if (dev) {
				try {
					execFileSync(path, ["-help"]);
					return;
				}
				catch {
					// ignored
				}
			}

			path = uri.fsPath;
			custom = false;

			execFileSync(path, ["-help"]);
		}
		catch {
			try {
				await download(uri);
			}
			catch (e) {
				console.error(e);
				vscode.window.showErrorMessage("Failed to install TEAL Tools. Please install manually and restart.");
				throw e;
			}
			vscode.window.showInformationMessage("TEAL Tools installed successfully.");
		}
	})();

	const serverOptions: ServerOptions = {
		run: {
			command: path
		},
		debug: {
			command: path,
			args: ["-debug", vscode.Uri.joinPath(context.globalStorageUri, "tealsp_debug.log").fsPath]
		}
	};

	let client = new LanguageClient("TEAL Language Server", serverOptions, clientOptions);
	context.subscriptions.push(client);

	await client.start();

	context.subscriptions.push(vscode.commands.registerCommand("teal.tools.install", async () => {
		if (custom) {
			vscode.window.showErrorMessage("TEAL Tools Update/Download not available in custom installation mode.");
			return;
		}

		try {
			await client.stop();
		} catch {
			// ignored
		}

		try {
			await download(uri);
		} catch (e) {
			console.error(e);
			vscode.window.showErrorMessage(`Failed to update TEAL Tools; make sure another tealsp process instance isn't already running or delete the file manually and retry - file path: ${uri.fsPath}, error details: ${e}`);
			return;
		}

		await client.start();
		vscode.window.showInformationMessage("TEAL Tools updated successfully.");
	}));
}

// This method is called when your extension is deactivated
export function deactivate() { }
