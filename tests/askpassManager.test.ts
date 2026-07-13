import * as path from 'path';
import * as vscode from './mocks/vscode';
jest.mock('vscode', () => vscode, { virtual: true });

import { createAskpassRequest } from '../src/askpass/askpassMain';
import { AskpassManager, AskpassRequest } from '../src/askpass/askpassManager';

describe('AskpassManager', () => {
	let manager: AskpassManager;

	beforeEach(() => {
		manager = new AskpassManager();
	});

	afterEach(() => {
		manager.dispose();
		jest.clearAllMocks();
	});

	it('Should provide HTTPS and SSH askpass environment variables', () => {
		const env = manager.getEnv();

		expect(env.GIT_ASKPASS).toBe(path.join(__dirname, '../src/askpass/askpass.sh'));
		expect(env.SSH_ASKPASS).toBe(path.join(__dirname, '../src/askpass/ssh-askpass.sh'));
		expect(env.SSH_ASKPASS_REQUIRE).toBe('force');
		expect(env.VSCODE_GIT_GRAPH_ASKPASS_HANDLE).toBeDefined();
	});

	it('Should use non-interactive fallbacks when the IPC server is unavailable', () => {
		manager['enabled'] = false;

		expect(manager.getEnv()).toStrictEqual({
			GIT_ASKPASS: path.join(__dirname, '../src/askpass/askpass-empty.sh'),
			SSH_ASKPASS: path.join(__dirname, '../src/askpass/askpass-empty.sh'),
			SSH_ASKPASS_REQUIRE: 'force'
		});
	});

	it('Should preserve HTTPS credential prompts', async () => {
		vscode.window.showInputBox.mockResolvedValueOnce('secret');
		const request: AskpassRequest = { askpassType: 'https', host: 'example.com', request: 'Password' };

		await expect(manager['handleRequest'](request)).resolves.toBe('secret');
		expect(vscode.window.showInputBox).toHaveBeenCalledWith({
			placeHolder: 'Password',
			prompt: 'Git Graph: example.com',
			password: true,
			ignoreFocusOut: true
		});
	});

	it('Should mask SSH passphrase prompts and identify the key', async () => {
		vscode.window.showInputBox.mockResolvedValueOnce('secret');
		const request: AskpassRequest = { askpassType: 'ssh', request: 'Enter passphrase for key \'/home/user/.ssh/id_ed25519\':' };

		await expect(manager['handleRequest'](request)).resolves.toBe('secret');
		expect(vscode.window.showInputBox).toHaveBeenCalledWith({
			placeHolder: 'Passphrase',
			prompt: 'Git Graph: SSH Key /home/user/.ssh/id_ed25519',
			password: true,
			ignoreFocusOut: true
		});
	});

	it('Should return an empty response when an SSH prompt is cancelled', async () => {
		vscode.window.showInputBox.mockResolvedValueOnce(undefined);
		const request: AskpassRequest = { askpassType: 'ssh', request: 'Password for git@example.com:' };

		await expect(manager['handleRequest'](request)).resolves.toBe('');
	});

	it('Should handle SSH host verification prompts', async () => {
		vscode.window.showQuickPick.mockResolvedValueOnce('yes');
		const request: AskpassRequest = {
			askpassType: 'ssh',
			request: 'The authenticity of host \'example.com (192.0.2.1)\' can\'t be established.\nED25519 key fingerprint is SHA256:abc.\nAre you sure you want to continue connecting (yes/no/[fingerprint])?'
		};

		await expect(manager['handleRequest'](request)).resolves.toBe('yes');
		expect(vscode.window.showQuickPick).toHaveBeenCalledWith(['yes', 'no'], {
			canPickMany: false,
			ignoreFocusOut: true,
			placeHolder: 'example.com (192.0.2.1) has fingerprint SHA256:abc. Continue connecting?'
		});
	});
});

describe('createAskpassRequest', () => {
	it('Should create an HTTPS request using the existing argument format', () => {
		expect(createAskpassRequest(['node', 'main', 'Username', 'for', '\'https://example.com\':'], 'https')).toStrictEqual({
			askpassType: 'https',
			request: 'Username',
			host: 'https://example.com'
		});
	});

	it('Should create an SSH request from a quoted prompt', () => {
		expect(createAskpassRequest(['node', 'main', 'Enter passphrase for key \'/home/user/.ssh/id_ed25519\':'], 'ssh')).toStrictEqual({
			askpassType: 'ssh',
			request: 'Enter passphrase for key \'/home/user/.ssh/id_ed25519\':'
		});
	});
});
