// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
} from 'vscode-languageclient/node';

export function activate(context: vscode.ExtensionContext) {
	let serverOptions: ServerOptions = {
		command: "tealsp"
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
