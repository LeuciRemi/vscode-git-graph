/*---------------------------------------------------------------------------------------------
 *  This code is based on the askpass implementation in the Microsoft Visual Studio Code Git Extension
 *  https://github.com/microsoft/vscode/blob/473af338e1bd9ad4d9853933da1cd9d5d9e07dc9/extensions/git/src/askpass.ts,
 *  which has the following copyright notice & license:
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See ./licenses/LICENSE_MICROSOFT for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getNonce } from '../utils';
import { Disposable, toDisposable } from '../utils/disposable';

export interface AskpassEnvironment {
	GIT_ASKPASS: string;
	SSH_ASKPASS: string;
	SSH_ASKPASS_REQUIRE: 'force';
	ELECTRON_RUN_AS_NODE?: string;
	VSCODE_GIT_GRAPH_ASKPASS_NODE?: string;
	VSCODE_GIT_GRAPH_ASKPASS_MAIN?: string;
	VSCODE_GIT_GRAPH_ASKPASS_HANDLE?: string;
}

export type AskpassType = 'https' | 'ssh';

export type AskpassRequest =
	{ askpassType: 'https'; host: string; request: string }
	| { askpassType: 'ssh'; request: string };

export class AskpassManager extends Disposable {
	private ipcHandlePath: string;
	private server: http.Server;
	private enabled = true;

	constructor() {
		super();
		this.ipcHandlePath = getIPCHandlePath(getNonce());
		this.server = http.createServer((req, res) => this.onRequest(req, res));
		try {
			this.server.listen(this.ipcHandlePath);
			this.server.on('error', () => this.enabled = false);
		} catch (err) {
			this.enabled = false;
		}
		for (const script of ['askpass.sh', 'ssh-askpass.sh', 'askpass-empty.sh']) {
			try {
				fs.chmodSync(path.join(__dirname, script), '755');
			} catch (err) { }
		}

		this.registerDisposable(
			// Close the Askpass Server
			toDisposable(() => {
				try {
					this.server.close();
					if (process.platform !== 'win32') {
						fs.unlinkSync(this.ipcHandlePath);
					}
				} catch (e) { }
			})
		);
	}

	private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
		let reqData = '';
		req.setEncoding('utf8');
		req.on('data', (d) => reqData += d);
		req.on('end', () => {
			let data: AskpassRequest;
			try {
				data = JSON.parse(reqData) as AskpassRequest;
				if (!isAskpassRequest(data)) throw new Error('Invalid askpass request');
			} catch (err) {
				res.writeHead(400);
				res.end();
				return;
			}

			this.handleRequest(data).then(result => {
				res.writeHead(200);
				res.end(JSON.stringify(result));
			}, () => {
				res.writeHead(500);
				res.end();
			});
		});
	}

	private async handleRequest(data: AskpassRequest): Promise<string> {
		if (data.askpassType === 'ssh') {
			return this.handleSshRequest(data.request);
		}

		const result = await vscode.window.showInputBox({
			placeHolder: data.request,
			prompt: 'Git Graph: ' + data.host,
			password: /password/i.test(data.request),
			ignoreFocusOut: true
		});
		return result || '';
	}

	private async handleSshRequest(request: string): Promise<string> {
		if (/continue connecting/i.test(request)) {
			const result = await vscode.window.showQuickPick(['yes', 'no'], {
				canPickMany: false,
				ignoreFocusOut: true,
				placeHolder: getHostVerificationPrompt(request)
			});
			return result || '';
		}

		const passphrase = /passphrase/i.test(request);
		const key = passphrase ? getSshKeyPath(request) : null;
		const result = await vscode.window.showInputBox({
			placeHolder: passphrase ? 'Passphrase' : request,
			prompt: key ? 'Git Graph: SSH Key ' + key : 'Git Graph: SSH',
			password: passphrase || /password/i.test(request),
			ignoreFocusOut: true
		});
		return result || '';
	}

	public getEnv(): AskpassEnvironment {
		return this.enabled
			? {
				ELECTRON_RUN_AS_NODE: '1',
				GIT_ASKPASS: path.join(__dirname, 'askpass.sh'),
				SSH_ASKPASS: path.join(__dirname, 'ssh-askpass.sh'),
				SSH_ASKPASS_REQUIRE: 'force',
				VSCODE_GIT_GRAPH_ASKPASS_NODE: process.execPath,
				VSCODE_GIT_GRAPH_ASKPASS_MAIN: path.join(__dirname, 'askpassMain.js'),
				VSCODE_GIT_GRAPH_ASKPASS_HANDLE: this.ipcHandlePath
			}
			: {
				GIT_ASKPASS: path.join(__dirname, 'askpass-empty.sh'),
				SSH_ASKPASS: path.join(__dirname, 'askpass-empty.sh'),
				SSH_ASKPASS_REQUIRE: 'force'
			};
	}
}

function isAskpassRequest(data: unknown): data is AskpassRequest {
	if (data === null || typeof data !== 'object') return false;
	const request = data as { askpassType?: unknown; host?: unknown; request?: unknown };
	return (request.askpassType === 'https' || request.askpassType === 'ssh')
		&& typeof request.request === 'string'
		&& (request.askpassType === 'ssh' || typeof request.host === 'string');
}

function getSshKeyPath(request: string): string | null {
	const match = /passphrase for (?:key )?['"]?(.+?)['"]?:?\s*$/i.exec(request);
	return match ? match[1] : null;
}

function getHostVerificationPrompt(request: string): string {
	const hostMatch = /host ['"]([^'"]+)['"]/i.exec(request);
	const fingerprintMatch = /fingerprint is ([^\r\n]+)/i.exec(request);
	if (hostMatch && fingerprintMatch) {
		return hostMatch[1] + ' has fingerprint ' + fingerprintMatch[1].replace(/\.\s*$/, '') + '. Continue connecting?';
	}
	return request;
}

function getIPCHandlePath(nonce: string): string {
	if (process.platform === 'win32') {
		return '\\\\.\\pipe\\git-graph-askpass-' + nonce + '-sock';
	} else if (process.env['XDG_RUNTIME_DIR']) {
		return path.join(process.env['XDG_RUNTIME_DIR'] as string, 'git-graph-askpass-' + nonce + '.sock');
	} else {
		return path.join(os.tmpdir(), 'git-graph-askpass-' + nonce + '.sock');
	}
}
