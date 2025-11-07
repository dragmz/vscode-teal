import * as vscode from 'vscode';

import fetch from 'node-fetch';

import { execFileSync } from 'child_process';
import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
} from 'vscode-languageclient/node';

import fs = require('fs');
import algosdk, { IntDecoding, SignedTransaction, Transaction } from 'algosdk';
import { modelsv2 } from 'algosdk';
import { sha512_256 } from 'js-sha512';

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

function convertValue(value: any): Uint8Array {
	if (typeof value === 'string') {
		if (value.startsWith('b64:')) {
			return Uint8Array.from(Buffer.from(value.slice(4), 'base64'));
		} else if (value.startsWith('0x')) {
			return Uint8Array.from(Buffer.from(value.slice(2), 'hex'));
		}

		return Uint8Array.from(Buffer.from(value, 'utf-8'));
	}

	if (typeof value === 'number' || typeof value === 'bigint') {
		return algosdk.encodeUint64(BigInt(value));
	}

	if (typeof value === 'boolean') {
		return algosdk.encodeUint64(value ? BigInt(1) : BigInt(0));
	}

	throw new Error(`Unsupported value type for conversion: ${typeof value}`);
}

function maybeConvertValuesArray(map: Map<string, any>, key: string) {
	if (map.has(key)) {
		const val = map.get(key);

		if (Array.isArray(val)) {
			map.set(key, val.map(convertValue));
		}
	}
}

async function debugCurrentDocument(client: LanguageClient, network: string) {
	// get current document content
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showErrorMessage("No active editor found.");
		return;
	}

	const url = getNetworkUrl(network);
	if (url === undefined) {
		vscode.window.showErrorMessage(`Invalid network selected: ${network}`);
		return;
	}

	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || workspaceFolders.length === 0) {
		vscode.window.showErrorMessage("No workspace folder found to save the decompiled file.");
		return;
	}

	const folder = workspaceFolders[0];

	const trace = await simulateDocumentTransactions(client, url, editor);
	if (!trace) {
		return;
	}

	const traceFilename = `debug.avm.trace.json`;
	const traceFileUri = vscode.Uri.joinPath(folder.uri, traceFilename);
	fs.writeFileSync(traceFileUri.fsPath, trace);

	const traceDoc = await vscode.workspace.openTextDocument(traceFileUri);
	await vscode.window.showTextDocument(traceDoc);

	try {
		await vscode.commands.executeCommand("extension.avmDebugger.debugOpenTraceFile");
	} catch (e) {
		vscode.window.showErrorMessage("Failed to open AVM debugger. Make sure the 'AlgoKit AVM Debugger' extension is installed.");
	}
}

async function prepareApplicationFiles(client: LanguageClient, networkUrl: string, appId: bigint) {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders || folders.length === 0) {
		vscode.window.showErrorMessage("No workspace folder found to save the sourcemap file.");
		return;
	}

	const folder = folders[0];

	const bytecodeFilename = `${appId}.bin`;
	const bytecodeUri = vscode.Uri.joinPath(folder.uri, bytecodeFilename);

	if (!fs.existsSync(bytecodeUri.fsPath)) {
		const bytecode = await download(networkUrl, appId);
		fs.writeFileSync(bytecodeUri.fsPath, bytecode);
	}

	const tealFilename = `${appId}.teal`;
	const tealUri = vscode.Uri.joinPath(folder.uri, tealFilename);

	if (!fs.existsSync(tealUri.fsPath)) {
		const bytecode = fs.readFileSync(bytecodeUri.fsPath);

		const decompiled = await decompile(client, bytecode);
		if (decompiled) {
			fs.writeFileSync(tealUri.fsPath, decompiled);
		}
	}

	const doc = await vscode.workspace.openTextDocument(tealUri);
	await vscode.window.showTextDocument(doc);

	{
		const sourcemapFilename = `${appId}.tok.map`;
		const sourcemapUri = vscode.Uri.joinPath(folder.uri, sourcemapFilename);

		if (!fs.existsSync(sourcemapUri.fsPath)) {
			const sourcemap = await generateSourcemap(client, tealUri);
			if (!sourcemap) {
				return;
			}

			fs.writeFileSync(sourcemapUri.fsPath, sourcemap);
		}

		// update .algokit/sources/sources.avm.json with the sourcemap
		/*
{
"txn-group-sources": [
{
"sourcemap-location": "../../3147789458.tok.map",
"hash": "RQW/ad094zZlyehcWgH3zS6GopTa6eytpsV2W/lfFdA="
}
]
}
*/
		const sourcesAvmUri = vscode.Uri.joinPath(folder.uri, ".algokit", "sources", "sources.avm.json");
		// read and parse existing content if exists

		let sourcesData: any;
		if (fs.existsSync(sourcesAvmUri.fsPath)) {
			const sourcesContent = fs.readFileSync(sourcesAvmUri.fsPath, 'utf-8');
			sourcesData = JSON.parse(sourcesContent);
		} else {
			sourcesData = {};
		}
		if (!sourcesData["txn-group-sources"]) {
			sourcesData["txn-group-sources"] = [];
		}
		const bytecode = fs.readFileSync(bytecodeUri.fsPath);
		const hash = sha512_256.array(Uint8Array.from(bytecode));
		const hashb64 = Buffer.from(hash).toString('base64');

		sourcesData["txn-group-sources"] = sourcesData["txn-group-sources"]
			.filter((entry: any) => entry.hash !== hashb64);

		sourcesData["txn-group-sources"].push({
			"sourcemap-location": `../../${sourcemapFilename}`,
			"hash": hashb64
		});

		fs.mkdirSync(vscode.Uri.joinPath(folder.uri, ".algokit", "sources").fsPath, { recursive: true });
		fs.writeFileSync(sourcesAvmUri.fsPath, JSON.stringify(sourcesData, null, 2));
	}
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
				case 'decompile':
					{
						const client = this._context.subscriptions.find(sub => sub instanceof LanguageClient) as LanguageClient;
						if (!client) {
							vscode.window.showErrorMessage("Language client not found.");
							return;
						}

						const url = getNetworkUrl(message.network);
						if (url === undefined) {
							vscode.window.showErrorMessage(`Invalid network selected: ${message.network}`);
							return;
						}

						await prepareApplicationFiles(client, url, BigInt(message.id));
					}
					break;
				case 'debug':
					{
						const client = this._context.subscriptions.find(sub => sub instanceof LanguageClient) as LanguageClient;
						if (!client) {
							vscode.window.showErrorMessage("Language client not found.");
							return;
						}

						await debugCurrentDocument(client, message.network);
					}
					break;
			}
		});
	}

	private async getHtmlForWebview(webview: vscode.Webview): Promise<string> {
		const htmlUri = vscode.Uri.joinPath(this._context.extensionUri, 'media', 'callbar.html');
		const htmlBuffer = await vscode.workspace.fs.readFile(htmlUri);
		return htmlBuffer.toString();
	}
}

async function generateSourcemap(client: LanguageClient, uri: vscode.Uri): Promise<any | null> {
	const response = await client.sendRequest("workspace/executeCommand", {
		command: "teal.sourcemap.generate",
		arguments: {
			uri: uri.toString(),
		}
	}) as { sourcemap: any } | null;

	if (!response) {
		vscode.window.showErrorMessage("Failed to generate source map for the current document.");
		return;
	}

	response.sourcemap.sources = [uri.fsPath];

	const content = JSON.stringify(response.sourcemap, null, 2);
	return content;
}

async function simulateDocumentTransactions(client: LanguageClient, url: string, editor: vscode.TextEditor): Promise<string | undefined> {
	const content = editor.document.getText();
	if (!content) {
		vscode.window.showErrorMessage("Current document is empty.");
		return;
	}

	let data: any;

	try {
		data = algosdk.parseJSON(content, { intDecoding: IntDecoding.BIGINT });
	} catch (e: any) {
		vscode.window.showErrorMessage(`Failed to parse current document as simulation transactions JSON - ${e.message ? e.message : String(e)}`);
		return;
	}

	if (data) {
		if (!Array.isArray(data)) {
			data = [data];
		}
	} else {
		return;
	}

	const groups: Transaction[][] = [];

	const ac = new algosdk.Algodv2("", url);
	const sp = await ac.getTransactionParams().do();

	for (let groupdata of data) {
		const group: Transaction[] = [];

		if (!Array.isArray(groupdata)) {
			groupdata = [groupdata];
		}

		for (let item of groupdata) {
			let txn: any;

			if (item.txn) {
				txn = item.txn;
			} else {
				txn = item;
			}

			if (txn.fv === undefined)
				txn.fv = sp.firstValid;
			if (txn.lv === undefined)
				txn.lv = sp.lastValid;
			if (txn.gh === undefined)
				txn.gh = sp.genesisHash;
			if (txn.gen === undefined)
				txn.gen = sp.genesisID;
			if (txn.fee === undefined)
				txn.fee = sp.minFee;

			if (typeof txn.gh === 'string') {
				txn.gh = Uint8Array.from(Buffer.from(txn.gh, 'base64'));
			}

			if (typeof txn.grp === 'string') {
				txn.grp = Uint8Array.from(Buffer.from(txn.grp, 'base64'));
			}

			const map = new Map(Object.entries(txn));
			maybeConvertValuesArray(map, "apaa");

			let tx: Transaction;

			try {
				tx = Transaction.fromEncodingData(map);
			} catch (e: any) {
				vscode.window.showErrorMessage(`Failed to decode transaction - ${e.message ? e.message : String(e)}`);
				return;
			}

			if (tx.type === algosdk.TransactionType.appl) {
				await prepareApplicationFiles(client, url, tx.applicationCall!.appIndex!);
			}

			group.push(tx);
		}

		groups.push(group);
	}

	return await simulateTransactions(url, groups);
}

async function simulateTransactions(url: string, groups: Transaction[][]): Promise<string | undefined> {
	const ac = new algosdk.Algodv2("", url);

	const simgroups = groups.map(group => algosdk.assignGroupID(group));

	const request = new modelsv2.SimulateRequest({
		txnGroups: simgroups.map(simgroup => new modelsv2.SimulateRequestTransactionGroup({
			txns: simgroup.map(txn => new SignedTransaction({ txn })),
		})),
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

async function download(url: string, id: bigint): Promise<Uint8Array> {
	const ac = new algosdk.Algodv2("", url);

	const app = await ac.getApplicationByID(id).do();
	return app.params.approvalProgram;
}

async function decompile(client: LanguageClient, bytecode: Buffer): Promise<string | null> {
	const response = await client.sendRequest("workspace/executeCommand", {
		command: "teal.decompile",
		arguments: {
			bytecode: bytecode.toString('base64'),
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

	context.subscriptions.push(vscode.commands.registerCommand("teal.transactions.create", async () => {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders || folders.length === 0) {
			vscode.window.showErrorMessage("No workspace folder found to create the transaction file.");
			return;
		}

		const folder = folders[0];
		const name = `transactions_${Date.now()}.avm.simulate.json`;
		const uri = vscode.Uri.joinPath(folder.uri, name);

		const initialContent = ``;
		fs.writeFileSync(uri.fsPath, initialContent);

		const doc = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(doc);
	}));

	context.subscriptions.push(vscode.commands.registerCommand("teal.transactions.debug", async () => {
		const network = await vscode.window.showQuickPick(["Mainnet", "Testnet", "Betanet"], {
			placeHolder: "Select the network to debug against"
		});

		if (network === undefined) {
			return;
		}

		await debugCurrentDocument(client, network);
	}));

	context.subscriptions.push(vscode.commands.registerCommand("teal.transactions.simulate", async () => {
		const url = await pickNetworkAndReturnUrl();

		if (url === undefined) {
			return;
		}

		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showErrorMessage("No active editor found.");
			return;
		}

		const trace = await simulateDocumentTransactions(client, url, editor);
		if (!trace) {
			return;
		}

		const filename = `${editor.document.fileName}.avm.trace.json`;
		const uri = vscode.Uri.file(filename);

		fs.writeFileSync(uri.fsPath, trace);

		const doc = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(doc);
	}));

	context.subscriptions.push(vscode.commands.registerCommand("teal.tools.install", async () => {
		if (custom) {
			vscode.window.showErrorMessage("TEAL Tools Update/Download not available in custom installation mode.");
			return;
		}

		await tryUpdate(context, client);
	}));

	context.subscriptions.push(vscode.commands.registerCommand("teal.sourcemap.generate", async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showErrorMessage("No active editor found.");
			return;
		}

		const content = await generateSourcemap(client, editor.document.uri);
		if (!content) {
			return;
		}

		const filename = `${editor.document.fileName}.tok.map`;
		const uri = vscode.Uri.file(filename);

		fs.writeFileSync(uri.fsPath, content);

		const doc = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(doc);
	}));

	context.subscriptions.push(vscode.commands.registerCommand("teal.download", async () => {
		const url = await pickNetworkAndReturnUrl();

		if (url === undefined) {
			return;
		}

		const id = await vscode.window.showInputBox({
			prompt: "Enter the TEAL program ID to download",
			placeHolder: "e.g. 12345678",
			validateInput: (value) => {
				const num = Number(value);
				return !isNaN(num) && num >= 0 ? null : "Invalid program ID";
			}
		});

		if (id === undefined) {
			return;
		}

		const bytecode = await download(url, BigInt(id));
		const folders = vscode.workspace.workspaceFolders;
		if (!folders || folders.length === 0) {
			vscode.window.showErrorMessage("No workspace folder found to save the downloaded file.");
			return;
		}

		const folder = folders[0];

		const uri = vscode.Uri.joinPath(folder.uri, `${id}.bin`);
		fs.writeFileSync(uri.fsPath, bytecode);

		await vscode.commands.executeCommand("vscode.openWith", uri, "hexEditor.hexedit");
	}));

	context.subscriptions.push(vscode.commands.registerCommand("teal.decompile", async () => {
		const editor = vscode.window.tabGroups.activeTabGroup.activeTab;
		if (!editor) {
			vscode.window.showErrorMessage("No active editor found.");
			return;
		}

		if (editor?.input instanceof vscode.TabInputCustom) {
			const uri = editor.input.uri;
			const bytecode = await vscode.workspace.fs.readFile(uri);

			const content = await decompile(client, Buffer.from(bytecode));
			if (!content) {
				vscode.window.showErrorMessage("Failed to decompile the TEAL bytecode.");
				return;
			}

			const tealFilename = `${uri.fsPath}.decompiled.teal`;
			const tealUri = vscode.Uri.file(tealFilename);

			fs.writeFileSync(tealUri.fsPath, content);

			const doc = await vscode.workspace.openTextDocument(tealUri);

			await vscode.window.showTextDocument(doc);
		}
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
