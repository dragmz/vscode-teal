import * as vscode from 'vscode';

import fetch from 'node-fetch';

import { execFileSync } from 'child_process';
import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
} from 'vscode-languageclient/node';

import fs = require('fs');

const versionFileName = "version";

const ext = process.platform === "win32" ? ".exe" : "";

function makeTealspPath(dir: vscode.Uri): vscode.Uri {
	return vscode.Uri.joinPath(dir, `tealsp${ext}`);
}

function makeVersionPath(dir: vscode.Uri): vscode.Uri {
	return vscode.Uri.joinPath(dir, `version`);
}

async function get(url: string): Promise<Buffer> {
	const resp = await fetch(url);
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

async function upgradable(dir: vscode.Uri): Promise<boolean> {
	try {
		const path = makeVersionPath(dir);

		if (!await exists(path)) {
			return true;
		}

		const localbuf = await vscode.workspace.fs.readFile(path);
		const local = localbuf.toString();

		const url = `https://github.com/dragmz/teal/releases/download/dev/${versionFileName}`;
		const remote = (await get(url)).toString();

		const result = local !== remote;
		return result;
	} catch (e) {
		console.error(`TEAL tools update check failed: ${e}`);
		return false;
	}
}

async function update(dir: vscode.Uri) {
	const name = `tealsp_${process.platform}_${process.arch}${ext}`;
	const url = `https://github.com/dragmz/teal/releases/download/dev/${name}`;

	const tealspPath = makeTealspPath(dir);
	const data = new Uint8Array(await get(url));

	if (data) {
		const versionPath = makeVersionPath(dir);
		const version = await get(`https://github.com/dragmz/teal/releases/download/dev/version`);

		if (await exists(tealspPath)) {
			await vscode.workspace.fs.delete(tealspPath);
		}

		await vscode.workspace.fs.writeFile(tealspPath, data);

		if (await exists(versionPath)) {
			await vscode.workspace.fs.delete(versionPath);
		}

		await vscode.workspace.fs.writeFile(versionPath, version);

		const stat = fs.statSync(tealspPath.fsPath);
		const modePlusX = stat.mode | fs.constants.S_IXUSR | fs.constants.S_IXGRP | fs.constants.S_IXOTH;

		fs.chmodSync(tealspPath.fsPath, modePlusX);
	}
}

async function tryUpdate(client: LanguageClient, uri: vscode.Uri) {
	vscode.window.showInformationMessage("Updating TEAL Tools..");

	try {
		await client.stop();
	} catch {
		// ignored
	}

	try {
		await update(uri);
		await client.start();
		vscode.window.showInformationMessage("TEAL Tools updated successfully.");
	} catch (e) {
		console.error(e);
		vscode.window.showErrorMessage(`Failed to update TEAL Tools; make sure another tealsp process instance isn't already running or delete the file manually and retry - file path: ${uri.fsPath}, error details: ${e}`);
	}
}

class DebugAdapterExecutableFactory implements vscode.DebugAdapterDescriptorFactory {
	context: vscode.ExtensionContext;
	path: string;

	constructor(context: vscode.ExtensionContext, path: string) {
		this.context = context;
		this.path = path;
	}

	createDebugAdapterDescriptor(_session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
		const config = _session.configuration.config ?? "";

		let args = ["dbg"];
		if (config) {
			args = args.concat(["-config"]);
			const root = vscode.workspace.workspaceFolders?.[0].uri;
			if (root) {
				args = args.concat(vscode.Uri.joinPath(root, config).fsPath);
			}
		}

		const algod = _session.configuration.algod ?? "";

		if (algod) {
			args = args.concat(["-algod", algod]);
		}

		const algodToken = _session.configuration.algodToken ?? "";

		if (algodToken) {
			args = args.concat(["-algod-token", algodToken]);
		}

		// resolve config into absolute path
		return new vscode.DebugAdapterExecutable(this.path, args);
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
				await update(context.globalStorageUri);
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

		await tryUpdate(client, context.globalStorageUri);
	}));

	if (!custom) {
		if (await upgradable(context.globalStorageUri)) {
			const udpateMsg = "Update";
			const answer = await vscode.window.showInformationMessage("A new version of TEAL Tools is available.", udpateMsg);
			if (answer === udpateMsg) {
				await tryUpdate(client, context.globalStorageUri);
			}
		}
	}

	vscode.debug.registerDebugAdapterDescriptorFactory("teal", new DebugAdapterExecutableFactory(context, path));
}

// This method is called when your extension is deactivated
export function deactivate() { }
