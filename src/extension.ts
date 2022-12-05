// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

import cp = require('child_process');
import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
} from 'vscode-languageclient/node';

let out = vscode.window.createOutputChannel("TEAL");

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(vscode.commands.registerCommand("teal.tools.install", () => {
		out.clear();
		out.show();
		setTimeout(() => {
			const tools = ["github.com/dragmz/teal/cmd/tealsp@latest"];
			tools.forEach(tool => {
				out.appendLine("Installing: " + tool);
				cp.execFileSync("go", ["install", "github.com/dragmz/teal/cmd/tealsp@latest"]);
			});
			out.appendLine("Done.");
		}, 100);
	}));

	let serverOptions: ServerOptions = {
		run: {
			command: "tealsp"
		},
		debug: {
			command: "tealsp",
			args: ["-debug", "tealsp_debug.log"]
		}
	};

	// Options to control the language client
	let clientOptions: LanguageClientOptions = {
		documentSelector: ['teal'],
	};

	let client = new LanguageClient("TEAL Language Server", serverOptions, clientOptions);
	client.start();

	context.subscriptions.push(client);
}

// This method is called when your extension is deactivated
export function deactivate() { }
