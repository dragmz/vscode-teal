import * as vscode from 'vscode';

import { execFileSync } from 'child_process';
import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
} from 'vscode-languageclient/node';

async function install(direct: boolean) {
	let env = {};

	if (direct) {
		// eslint-disable-next-line @typescript-eslint/naming-convention
		env = Object.assign(process.env, { GOPROXY: "direct" });
	} else {
		env = process.env;
	}

	const tools = ["github.com/dragmz/teal/cmd/tealsp@latest"];
	for (const tool of tools) {
		execFileSync("go", ["install", tool], {
			env: env
		});
	}
}

export async function activate(context: vscode.ExtensionContext) {
	const serverOptions: ServerOptions = {
		run: {
			command: "tealsp"
		},
		debug: {
			command: "tealsp",
			args: ["-debug", "tealsp_debug.log"]
		}
	};

	const clientOptions: LanguageClientOptions = {
		documentSelector: ['teal']
	};

	let client = new LanguageClient("TEAL Language Server", serverOptions, clientOptions);
	context.subscriptions.push(client);

	try {
		execFileSync("tealsp", ["-help"]);
	} catch (e) {
		try {
			await install(false);
		}
		catch(e) {
			try {
				await install(true);
			} catch (e) {
				console.error(e);
				vscode.window.showErrorMessage("Failed to install TEAL Tools. Please install manually and restart.");
				throw e;
			}
			vscode.window.showInformationMessage("TEAL Tools installed successfully.");
		}
	}

	await client.start();

	context.subscriptions.push(vscode.commands.registerCommand("teal.tools.install", async () => {
		try {
			await client.stop();
		} catch {
			// ignored
		}

		try {
			install(true);
		} catch(e) {
			console.error(e);
			vscode.window.showErrorMessage("Failed to update TEAL Tools.");
		}

		await client.start();
		vscode.window.showInformationMessage("TEAL Tools updated successfully.");
	}));
}

// This method is called when your extension is deactivated
export function deactivate() { }
