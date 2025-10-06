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

function getChannelUrl(context: vscode.ExtensionContext): string {
	const version = context.extension.packageJSON.version;
	const minor = parseInt(version.split(".")[1]);
	const isPreRelease = minor % 2 === 1;

	const config = vscode.workspace.getConfiguration("tealsp");
	const channel = config.get<string>("tealsp.channel", isPreRelease ? "dev" : "stable");

	return `https://github.com/dragmz/tealsp/releases/download/${channel}`;
}

function getVersionUrl(context: vscode.ExtensionContext): string {
	const versionFileName = `version_${process.platform}_${process.arch}`;
	const versionUrl = `${getChannelUrl(context)}/${versionFileName}`;

	return versionUrl;
}

function makeTealspPath(dir: vscode.Uri): vscode.Uri {
	return vscode.Uri.joinPath(dir, `tealsp${ext}`);
}

function makeVersionPath(dir: vscode.Uri): vscode.Uri {
	return vscode.Uri.joinPath(dir, `version`);
}

async function get(url: string): Promise<Buffer> {
	const resp = await fetch(url);
	if (!resp.ok) {
		throw new Error(`Failed to fetch ${url}: ${resp.status} ${resp.statusText}`);
	}
	const buff = await resp.buffer();

	return buff;
}

async function exists(path: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(path);
		return true;
	} catch {
		return false;
	}
}

async function upgradable(context: vscode.ExtensionContext): Promise<boolean> {
	const dir = context.globalStorageUri;

	try {
		const path = makeVersionPath(dir);

		if (!await exists(path)) {
			return true;
		}

		const localbuf = await vscode.workspace.fs.readFile(path);
		const local = localbuf.toString();

		const remote = (await get(getVersionUrl(context))).toString();

		const result = local !== remote;
		return result;
	} catch (e) {
		console.error(`TEAL tools update check failed: ${e}`);
		return false;
	}
}

async function update(context: vscode.ExtensionContext) {
	const dir = context.globalStorageUri;
	const name = `tealsp_${process.platform}_${process.arch}${ext}`;
	const url = `${getChannelUrl(context)}/${name}`;

	const tealspPath = makeTealspPath(dir);
	const data = new Uint8Array(await get(url));

	if (data) {
		const versionPath = makeVersionPath(dir);
		const version = await get(getVersionUrl(context));

		if (await exists(tealspPath)) {
			await vscode.workspace.fs.delete(tealspPath);
		}

		await vscode.workspace.fs.writeFile(tealspPath, data);

		if (await exists(versionPath)) {
			await vscode.workspace.fs.delete(versionPath);
		}

		await vscode.workspace.fs.writeFile(versionPath, Uint8Array.from(version));

		const stat = fs.statSync(tealspPath.fsPath);
		const modePlusX = stat.mode | fs.constants.S_IXUSR | fs.constants.S_IXGRP | fs.constants.S_IXOTH;

		fs.chmodSync(tealspPath.fsPath, modePlusX);
	}
}

async function tryUpdate(context: vscode.ExtensionContext, client: LanguageClient) {
	const uri = context.globalStorageUri;
	vscode.window.showInformationMessage("Updating TEAL Tools..");

	try {
		await client.stop();
	} catch {
		// ignored
	}

	try {
		await update(context);
		await client.start();
		vscode.window.showInformationMessage("TEAL Tools updated successfully.");
	} catch (e) {
		console.error(e);
		vscode.window.showErrorMessage(`Failed to update TEAL Tools; make sure another tealsp process instance isn't already running or delete the file manually and retry - file path: ${uri.fsPath}, error details: ${e}`);
	}
}

export async function activate(context: vscode.ExtensionContext) {
	const config = vscode.workspace.getConfiguration("tealsp");

	await vscode.workspace.fs.createDirectory(context.globalStorageUri);

	const clientOptions: LanguageClientOptions = {
		documentSelector: ['teal'],
		initializationOptions: {
			"semanticTokens": config["ui.semanticTokens"],
			"inlayNamed": config["ui.inlayHints.named"],
			"inlayDecoded": config["ui.inlayHints.decoded"],
			"pcLens": config["ui.pc.lens"],
			"pcInlay": config["ui.pc.inlay"],
			"programSize": config["ui.programSize"],
		}
	};

	const dev = context.extensionMode !== vscode.ExtensionMode.Production;
	const uri = makeTealspPath(context.globalStorageUri);

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
				vscode.window.showInformationMessage("Installing TEAL Tools..");
				await update(context);
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

	const client = new LanguageClient("TEAL Language Server", serverOptions, clientOptions);
	context.subscriptions.push(client);

	await client.start();

	context.subscriptions.push(vscode.commands.registerCommand("teal.tools.install", async () => {
		if (custom) {
			vscode.window.showErrorMessage("TEAL Tools Update/Download not available in custom installation mode.");
			return;
		}

		await tryUpdate(context, client);
	}));

	context.subscriptions.push(vscode.commands.registerCommand("teal.goto.pc", async () => {
		// ask for a PC value
		const pcStr = await vscode.window.showInputBox({
			prompt: "Enter the TEAL program counter (PC) value to go to",
			placeHolder: "e.g. 42",
			validateInput: (value) => {
				const num = Number(value);
				return !isNaN(num) && num >= 0 ? null : "Invalid PC value";
			}
		});

		if (pcStr === undefined) {
			return;
		}

		const pc = Number(pcStr);

		const response = await client.sendRequest("workspace/executeCommand", {
			command: "teal.pc.resolve",
			arguments: {
				uri: vscode.window.activeTextEditor?.document.uri.toString(),
				pc: pc
			}
		}) as { line: number, character: number } | null;

		if (!response) {
			vscode.window.showErrorMessage(`PC value ${pc} not found in the current document.`);
			return;
		}

		const position = new vscode.Position(response.line, response.character);
		const editor = vscode.window.activeTextEditor;

		if (editor) {
			editor.selection = new vscode.Selection(position, position);
			editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
		}
	}));

	if (!custom) {
		if (await upgradable(context)) {
			const udpateMsg = "Update";
			const answer = await vscode.window.showInformationMessage("A new version of TEAL Tools is available.", udpateMsg);
			if (answer === udpateMsg) {
				await tryUpdate(context, client);
			}
		}
	}
}

// This method is called when your extension is deactivated
export function deactivate() { }
