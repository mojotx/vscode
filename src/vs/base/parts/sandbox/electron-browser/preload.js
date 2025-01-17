/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-check
(function () {
	'use strict';

	const { ipcRenderer, webFrame, contextBridge } = require('electron');

	/**
	 * @typedef {import('../common/sandboxTypes').ISandboxConfiguration} ISandboxConfiguration
	 */

	//#region Utilities

	/**
	 * @param {string} channel
	 * @returns {true | never}
	 */
	function validateIPC(channel) {
		if (!channel || !channel.startsWith('vscode:')) {
			throw new Error(`Unsupported event IPC channel '${channel}'`);
		}

		return true;
	}

	/**
	 * @param {string} type
	 * @returns {type is 'uncaughtException'}
	 */
	function validateProcessEventType(type) {
		if (type !== 'uncaughtException') {
			throw new Error(`Unsupported process event '${type}'`);
		}

		return true;
	}

	/**
	 * @param {string} key the name of the process argument to parse
	 * @returns {string | undefined}
	 */
	function parseArgv(key) {
		for (const arg of process.argv) {
			if (arg.indexOf(`--${key}=`) === 0) {
				return arg.split('=')[1];
			}
		}

		return undefined;
	}

	/**
	 * @param {string} channel
	 * @param {number} retryDelay
	 * @returns {Promise<ISandboxConfiguration>}
	 */
	async function invokeWithRetry(channel, retryDelay) {
		let timeoutHandle;

		// A timeout promise that resolves after `retryDelay`
		const timeout = new Promise(resolve => {
			timeoutHandle = setTimeout(() => {
				resolve();
			}, retryDelay);
		});

		// A first `invoke` call that clears the timeout
		const firstInvoke = ((async () => {
			try {
				return await ipcRenderer.invoke(channel);
			} finally {
				clearTimeout(timeoutHandle);
			}
		})());

		// Race the `invoke` to the `setTimeout`
		const result = await Promise.race([
			firstInvoke,
			timeout
		]);

		// If we have a result, return immediately
		if (result) {
			return result;
		}

		console.warn(`[preload] ipcRenderer.invoke(${channel}) did not return after ${retryDelay}ms. Retrying once...`);

		// Otherwise, we retry once on the same channel
		return ipcRenderer.invoke(channel);
	}

	//#endregion

	//#region Resolve Configuration

	/** @type {ISandboxConfiguration | undefined} */
	let configuration = undefined;

	/** @type {Promise<ISandboxConfiguration>} */
	const resolveConfiguration = (async () => {
		const windowConfigIpcChannel = parseArgv('vscode-window-config');
		if (!windowConfigIpcChannel) {
			throw new Error('Preload: did not find expected vscode-window-config in renderer process arguments list.');
		}

		try {
			if (validateIPC(windowConfigIpcChannel)) {

				// Resolve configuration from electron-main
				//
				// TODO@electron there seems to be a condition where an early
				// `ipcRenderer.invoke` call does not return when running in
				// smoke tests where a debugger is attached. The workaround
				// here is to retry the call, but the underlying reasons are
				// not yet understood.
				// (https://github.com/microsoft/vscode/issues/146785)
				configuration = await invokeWithRetry(windowConfigIpcChannel, 5000);

				// Apply `userEnv` directly
				Object.assign(process.env, configuration.userEnv);

				// Apply zoom level early before even building the
				// window DOM elements to avoid UI flicker. We always
				// have to set the zoom level from within the window
				// because Chrome has it's own way of remembering zoom
				// settings per origin (if vscode-file:// is used) and
				// we want to ensure that the user configuration wins.
				webFrame.setZoomLevel(configuration.zoomLevel ?? 0);

				return configuration;
			}
		} catch (error) {
			throw new Error(`Preload: unable to fetch vscode-window-config: ${error}`);
		}
	})();

	//#endregion

	//#region Resolve Shell Environment

	/**
	 * If VSCode is not run from a terminal, we should resolve additional
	 * shell specific environment from the OS shell to ensure we are seeing
	 * all development related environment variables. We do this from the
	 * main process because it may involve spawning a shell.
	 *
	 * @type {Promise<typeof process.env>}
	 */
	const resolveShellEnv = (async () => {

		// Resolve `userEnv` from configuration and
		// `shellEnv` from the main side
		const [userEnv, shellEnv] = await Promise.all([
			(async () => (await resolveConfiguration).userEnv)(),
			ipcRenderer.invoke('vscode:fetchShellEnv')
		]);

		return { ...process.env, ...shellEnv, ...userEnv };
	})();

	//#endregion

	//#region Globals Definition

	// #######################################################################
	// ###                                                                 ###
	// ###       !!! DO NOT USE GET/SET PROPERTIES ANYWHERE HERE !!!       ###
	// ###       !!!  UNLESS THE ACCESS IS WITHOUT SIDE EFFECTS  !!!       ###
	// ###       (https://github.com/electron/electron/issues/25516)       ###
	// ###                                                                 ###
	// #######################################################################

	/**
	 * @type {import('../electron-sandbox/globals')}
	 */
	const globals = {

		/**
		 * A minimal set of methods exposed from Electron's `ipcRenderer`
		 * to support communication to main process.
		 *
		 * @typedef {import('../electron-sandbox/electronTypes').IpcRenderer} IpcRenderer
		 * @typedef {import('electron').IpcRendererEvent} IpcRendererEvent
		 *
		 * @type {IpcRenderer}
		 */

		ipcRenderer: {

			/**
			 * @param {string} channel
			 * @param {any[]} args
			 */
			send(channel, ...args) {
				if (validateIPC(channel)) {
					ipcRenderer.send(channel, ...args);
				}
			},

			/**
			 * @param {string} channel
			 * @param {any[]} args
			 * @returns {Promise<any> | undefined}
			 */
			invoke(channel, ...args) {
				if (validateIPC(channel)) {
					return ipcRenderer.invoke(channel, ...args);
				}
			},

			/**
			 * @param {string} channel
			 * @param {(event: IpcRendererEvent, ...args: any[]) => void} listener
			 * @returns {IpcRenderer}
			 */
			on(channel, listener) {
				if (validateIPC(channel)) {
					ipcRenderer.on(channel, listener);

					return this;
				}
			},

			/**
			 * @param {string} channel
			 * @param {(event: IpcRendererEvent, ...args: any[]) => void} listener
			 * @returns {IpcRenderer}
			 */
			once(channel, listener) {
				if (validateIPC(channel)) {
					ipcRenderer.once(channel, listener);

					return this;
				}
			},

			/**
			 * @param {string} channel
			 * @param {(event: IpcRendererEvent, ...args: any[]) => void} listener
			 * @returns {IpcRenderer}
			 */
			removeListener(channel, listener) {
				if (validateIPC(channel)) {
					ipcRenderer.removeListener(channel, listener);

					return this;
				}
			}
		},

		/**
		 * @type {import('../electron-sandbox/globals').IpcMessagePort}
		 */
		ipcMessagePort: {

			/**
			 * @param {string} responseChannel
			 * @param {string} nonce
			 */
			acquire(responseChannel, nonce) {
				if (validateIPC(responseChannel)) {
					const responseListener = (/** @type {IpcRendererEvent} */ e, /** @type {string} */ responseNonce) => {
						// validate that the nonce from the response is the same
						// as when requested. and if so, use `postMessage` to
						// send the `MessagePort` safely over, even when context
						// isolation is enabled
						if (nonce === responseNonce) {
							ipcRenderer.off(responseChannel, responseListener);
							window.postMessage(nonce, '*', e.ports);
						}
					};

					// handle reply from main
					ipcRenderer.on(responseChannel, responseListener);
				}
			}
		},

		/**
		 * Support for subset of methods of Electron's `webFrame` type.
		 *
		 * @type {import('../electron-sandbox/electronTypes').WebFrame}
		 */
		webFrame: {

			/**
			 * @param {number} level
			 */
			setZoomLevel(level) {
				if (typeof level === 'number') {
					webFrame.setZoomLevel(level);
				}
			}
		},

		/**
		 * Support for a subset of access to node.js global `process`.
		 *
		 * Note: when `sandbox` is enabled, the only properties available
		 * are https://github.com/electron/electron/blob/master/docs/api/process.md#sandbox
		 *
		 * @typedef {import('../electron-sandbox/globals').ISandboxNodeProcess} ISandboxNodeProcess
		 *
		 * @type {ISandboxNodeProcess}
		 */
		process: {
			get platform() { return process.platform; },
			get arch() { return process.arch; },
			get env() { return { ...process.env }; },
			get versions() { return process.versions; },
			get type() { return 'renderer'; },
			get execPath() { return process.execPath; },
			get sandboxed() { return process.sandboxed; },

			/**
			 * @returns {string}
			 */
			cwd() {
				return process.env['VSCODE_CWD'] || process.execPath.substr(0, process.execPath.lastIndexOf(process.platform === 'win32' ? '\\' : '/'));
			},

			/**
			 * @returns {Promise<typeof process.env>}
			 */
			shellEnv() {
				return resolveShellEnv;
			},

			/**
			 * @returns {Promise<import('electron').ProcessMemoryInfo>}
			 */
			getProcessMemoryInfo() {
				return process.getProcessMemoryInfo();
			},

			/**
			 * @param {string} type
			 * @param {Function} callback
			 * @returns {ISandboxNodeProcess}
			 */
			on(type, callback) {
				if (validateProcessEventType(type)) {
					// @ts-ignore
					process.on(type, callback);

					return this;
				}
			}
		},

		/**
		 * Some information about the context we are running in.
		 *
		 * @type {import('../electron-sandbox/globals').ISandboxContext}
		 */
		context: {

			/**
			 * A configuration object made accessible from the main side
			 * to configure the sandbox browser window.
			 *
			 * Note: intentionally not using a getter here because the
			 * actual value will be set after `resolveConfiguration`
			 * has finished.
			 *
			 * @returns {ISandboxConfiguration | undefined}
			 */
			configuration() {
				return configuration;
			},

			/**
			 * Allows to await the resolution of the configuration object.
			 *
			 * @returns {Promise<ISandboxConfiguration>}
			 */
			async resolveConfiguration() {
				return resolveConfiguration;
			}
		}
	};

	// Use `contextBridge` APIs to expose globals to VSCode
	// only if context isolation is enabled, otherwise just
	// add to the DOM global.
	if (process.contextIsolated) {
		try {
			contextBridge.exposeInMainWorld('vscode', globals);
		} catch (error) {
			console.error(error);
		}
	} else {
		// @ts-ignore
		window.vscode = globals;
	}
}());
