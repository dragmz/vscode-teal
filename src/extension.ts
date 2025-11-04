import * as vscode from 'vscode';

import fetch from 'node-fetch';

import { execFileSync } from 'child_process';
import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
} from 'vscode-languageclient/node';

import fs = require('fs');
import algosdk, { SignedTransaction } from 'algosdk';
import { modelsv2 } from 'algosdk';

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

function getNetworkUrl(network: string): string | undefined {
	switch (network) {
		case "Mainnet":
			return "https://mainnet-api.4160.nodely.dev";
		case "Testnet":
			return "https://testnet-api.4160.nodely.dev";
		case "Betanet":
			return "https://betanet-api.4160.nodely.dev";
		default:
			return undefined;
	}
}

function pickNetworkAndReturnUrl(): Thenable<string | undefined> {
	return vscode.window.showQuickPick(["Mainnet", "Testnet", "Betanet", "Custom"], {
		placeHolder: "Select the network"
	}).then(async (network) => {
		if (network === undefined) {
			return undefined;
		}
		if (network === "Custom") {
			return await vscode.window.showInputBox({
				prompt: "Enter the custom network node URL",
				placeHolder: "e.g. https://custom-algorand-node.com"
			});
		} else {
			return getNetworkUrl(network);
		}
	});
}

export class CallBarProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'callbarview';
	constructor(private readonly _context: vscode.ExtensionContext) { }

	public async resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		webviewView.webview.options = {
			enableScripts: true,
		};
		webviewView.webview.html = await this.getHtmlForWebview(webviewView.webview);
		webviewView.webview.onDidReceiveMessage(async message => {
			switch (message.command) {
				case 'debug':
					{
						const network = message.network;
						const id = message.id;

						const url = getNetworkUrl(network);
						if (url === undefined) {
							vscode.window.showErrorMessage(`Invalid network selected: ${network}`);
							return;
						}

						// get LanguageClient from extension context
						const client = this._context.subscriptions.find(sub => sub instanceof LanguageClient) as LanguageClient;
						if (!client) {
							vscode.window.showErrorMessage("Language client not found.");
							return;
						}

						const content = await decompile(client, url, id);
						if (!content) {
							vscode.window.showErrorMessage(`Failed to decompile program ID ${id}.`);
							return;
						}

						const filename = `App_${id}.teal`;
						// get workspace folder
						const workspaceFolders = vscode.workspace.workspaceFolders;
						if (!workspaceFolders || workspaceFolders.length === 0) {
							vscode.window.showErrorMessage("No workspace folder found to save the decompiled file.");
							return;
						}
						const folder = workspaceFolders[0];
						const fileUri = vscode.Uri.joinPath(folder.uri, filename);
						fs.writeFileSync(fileUri.fsPath, content);

						// open the file in vscode
						const doc = await vscode.workspace.openTextDocument(fileUri);
						await vscode.window.showTextDocument(doc);

						const sourcemap = await generateSourcemap(client);
						if (!sourcemap) {
							return;
						}

						const sourcemapFilename = `App_${id}.tok.map`;
						const sourcemapFileUri = vscode.Uri.joinPath(folder.uri, sourcemapFilename);
						fs.writeFileSync(sourcemapFileUri.fsPath, sourcemap);

						const trace = await call(url, id);
						if (!trace) {
							return;
						}

						const traceFilename = `App_${id}.avm.trace.json`;
						const traceFileUri = vscode.Uri.joinPath(folder.uri, traceFilename);
						fs.writeFileSync(traceFileUri.fsPath, trace);

						const traceDoc = await vscode.workspace.openTextDocument(traceFileUri);
						await vscode.window.showTextDocument(traceDoc);

						await vscode.commands.executeCommand("extension.avmDebugger.debugOpenTraceFile");
					}
			}
		});
	}

	private async getHtmlForWebview(webview: vscode.Webview): Promise<string> {
		const htmlUri = vscode.Uri.joinPath(this._context.extensionUri, 'media', 'callbar.html');
		const htmlBuffer = await vscode.workspace.fs.readFile(htmlUri);
		return htmlBuffer.toString();
	}
}

async function generateSourcemap(client: LanguageClient): Promise<any | null> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showErrorMessage("No active editor found.");
		return;
	}

	const response = await client.sendRequest("workspace/executeCommand", {
		command: "teal.sourcemap.generate",
		arguments: {
			uri: editor.document.uri.toString(),
		}
	}) as { sourcemap: any } | null;

	if (!response) {
		vscode.window.showErrorMessage("Failed to generate source map for the current document.");
		return;
	}

	response.sourcemap.sources = [editor.document.uri.fsPath];

	const content = JSON.stringify(response.sourcemap, null, 2);
	return content;
}

async function call(url: string, id: string): Promise<string | null> {
	const ac = new algosdk.Algodv2("", url);

	const appIndex = BigInt(id);
	const suggestedParams = await ac.getTransactionParams().do();
	const sender = "Y76M3MSY6DKBRHBL7C3NNDXGS5IIMQVQVUAB6MP4XEMMGVF2QWNPL226CA";

	const call_tx = algosdk.makeApplicationNoOpTxnFromObject({
		appIndex,
		sender,
		suggestedParams,
	});

	const txns = [call_tx];
	const group = algosdk.assignGroupID(txns);

	const request = new modelsv2.SimulateRequest({
		txnGroups: [
			new modelsv2.SimulateRequestTransactionGroup({
				txns: group.map(txn => new SignedTransaction({ txn })),
			})
		],
		allowEmptySignatures: true,
		allowMoreLogging: true,
		allowUnnamedResources: true,
		execTraceConfig: new modelsv2.SimulateTraceConfig({
			enable: true,
			scratchChange: true,
			stackChange: true,
			stateChange: true,
		}),
		fixSigners: true,
	});

	const sim = ac.simulateTransactions(request);
	sim.query.format = "json";

	const result = await sim.doRaw();
	const content = new TextDecoder("utf-8").decode(result);
	return content;
}

async function decompile(client: LanguageClient, url: string, id: string): Promise<string | null> {
	const ac = new algosdk.Algodv2("", url);
	const app = await ac.getApplicationByID(BigInt(id)).do();

	const response = await client.sendRequest("workspace/executeCommand", {
		command: "teal.decompile",
		arguments: {
			bytecode: Buffer.from(app.params.approvalProgram).toString('base64'),
		}
	}) as { teal: string } | null;

	if (!response) {
		return null;
	}

	return response.teal;
};

export async function activate(context: vscode.ExtensionContext) {
	const config = vscode.workspace.getConfiguration("tealsp");

	const callbarProvider = new CallBarProvider(context);

	context.subscriptions.push(vscode.window.registerWebviewViewProvider('callbarview', callbarProvider));

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

	context.subscriptions.push(vscode.commands.registerCommand("teal.sourcemap.generate", async () => {
		const content = await generateSourcemap(client);
		if (!content) {
			return;
		}

		const doc = await vscode.workspace.openTextDocument({
			content,
		});
		await vscode.window.showTextDocument(doc);
	}));

	context.subscriptions.push(vscode.commands.registerCommand("teal.call.app", async () => {
		const url = await pickNetworkAndReturnUrl();

		if (url === undefined) {
			return;
		}

		const id = await vscode.window.showInputBox({
			prompt: "Enter the smart contract application ID to call",
			placeHolder: "e.g. 12345678",
			validateInput: (value) => {
				const num = Number(value);
				return !isNaN(num) && num >= 0 ? null : "Invalid application ID";
			}
		});

		if (id === undefined) {
			return;
		}

		const content = await call(url, id);
		if (!content) {
			vscode.window.showErrorMessage(`Failed to call application ID ${id}.`);
			return;
		}

		const doc = await vscode.workspace.openTextDocument({
			content
		});

		await vscode.window.showTextDocument(doc);
	}));

	context.subscriptions.push(vscode.commands.registerCommand("teal.decompile", async () => {
		const url = await pickNetworkAndReturnUrl();

		if (url === undefined) {
			return;
		}

		const id = await vscode.window.showInputBox({
			prompt: "Enter the TEAL program ID to decompile",
			placeHolder: "e.g. 12345678",
			validateInput: (value) => {
				const num = Number(value);
				return !isNaN(num) && num >= 0 ? null : "Invalid program ID";
			}
		});

		if (id === undefined) {
			return;
		}

		const content = await decompile(client, url, id);
		if (!content) {
			vscode.window.showErrorMessage(`Failed to decompile program ID ${id}.`);
			return;
		}

		const doc = await vscode.workspace.openTextDocument({
			content,
			language: "teal"
		});

		await vscode.window.showTextDocument(doc);
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
