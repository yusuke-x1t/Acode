import ajax from "lib/ajax";
import { decode } from "utils/encodings";
import Url from "utils/Url";
import externalFs from "./externalFs";
import Ftp from "./ftp";
import internalFs from "./internalFs";
import Sftp from "./sftp";

const fsList = [];
const registrationListeners = new Set();
const REMOTE_METADATA_TIMEOUT = 1500;
const REMOTE_READ_TIMEOUT = 4000;
const REMOTE_WRITE_TIMEOUT = 6000;
const REMOTE_FAILURE_COOLDOWN = 15000;
const remoteFailureUntil = new Map();

function isRemoteUri(url) {
	return /^(?:ftp|sftp):/i.test(String(url || ""));
}

function isBrowserOffline() {
	return typeof navigator !== "undefined" && navigator.onLine === false;
}

function createRemoteUnavailableError(url, operation, cause) {
	const error = new Error(
		`Remote ${operation} unavailable for ${safeRemoteName(url)}. The connection is unavailable. Acode recovery data is left untouched; remote changes were not uploaded.`,
	);
	error.code = "ACODE_REMOTE_OFFLINE";
	error.cause = cause;
	return error;
}

function safeRemoteName(url) {
	try {
		return Url.basename(String(url || "")) || String(url || "remote file");
	} catch {
		return String(url || "remote file");
	}
}

function withTimeout(promise, milliseconds, message) {
	let timer;
	return Promise.race([
		Promise.resolve(promise),
		new Promise((_, reject) => {
			timer = setTimeout(() => {
				const error = new Error(message || "Remote filesystem request timed out");
				error.code = "ACODE_REMOTE_TIMEOUT";
				reject(error);
			}, milliseconds);
		}),
	]).finally(() => clearTimeout(timer));
}

function isRemoteNetworkError(error) {
	if (error?.code === "ACODE_REMOTE_TIMEOUT" || error?.code === "ACODE_REMOTE_OFFLINE") {
		return true;
	}
	if (isBrowserOffline()) return true;
	const message = error instanceof Error ? error.message : String(error ?? "");
	return /timeout|timed out|network|connection|socket|unreachable|host|dns|resolve|refused|reset|econn|enet|ehost|offline/i.test(message);
}

function rememberRemoteFailure(url) {
	remoteFailureUntil.set(String(url), Date.now() + REMOTE_FAILURE_COOLDOWN);
}

function remoteIsCoolingDown(url) {
	const key = String(url);
	const expiresAt = remoteFailureUntil.get(key);
	if (!expiresAt) return false;
	if (expiresAt <= Date.now()) {
		remoteFailureUntil.delete(key);
		return false;
	}
	return true;
}

function getRemoteCacheUris(url, remoteFs) {
	const candidates = [];
	try {
		if (typeof remoteFs?.localName === "string" && remoteFs.localName) {
			candidates.push(remoteFs.localName);
		}
	} catch {}

	// EditorFile uses CACHE_STORAGE/<uri.hashCode()> as its recovery file.
	// It is a second fallback if the transfer cache has not been created.
	try {
		if (typeof CACHE_STORAGE !== "undefined" && typeof url?.hashCode === "function") {
			candidates.push(Url.join(CACHE_STORAGE, url.hashCode()));
		}
	} catch {}

	return Array.from(new Set(candidates.filter((item) => typeof item === "string" && item && item !== url)));
}

async function findRemoteCache(url, remoteFs) {
	for (const cacheUri of getRemoteCacheUris(url, remoteFs)) {
		try {
			const cacheFs = fsOperation(cacheUri);
			if (!cacheFs || typeof cacheFs.exists !== "function") continue;
			const exists = await withTimeout(
				cacheFs.exists(),
				750,
				"Local cache lookup timed out",
			);
			if (exists) return { uri: cacheUri, fs: cacheFs };
		} catch {}
	}
	return null;
}

async function getCachedRemoteStat(url, remoteFs) {
	const cached = await findRemoteCache(url, remoteFs);
	if (!cached) return null;

	let cachedStat = null;
	try {
		cachedStat = await withTimeout(
			cached.fs.stat(),
			750,
			"Local cache metadata lookup timed out",
		);
	} catch {}

	return {
		...(cachedStat || {}),
		name: safeRemoteName(url),
		url,
		isFile: true,
		isDirectory: false,
		isLink: false,
		canRead: true,
		canWrite: true,
		size: Number(cachedStat?.size || 0),
		modifiedDate: cachedStat?.modifiedDate ?? null,
		offlineCache: true,
	};
}

async function readFromRemoteCache(url, remoteFs, args) {
	const cached = await findRemoteCache(url, remoteFs);
	if (!cached) throw createRemoteUnavailableError(url, "read", null);
	return cached.fs.readFile(...args);
}

async function invokeRemote(url, remoteFs, method, args, options = {}) {
	const { timeout = REMOTE_METADATA_TIMEOUT, fallback } = options;
	const skipRemote = isBrowserOffline() || remoteIsCoolingDown(url);

	if (skipRemote) {
		if (fallback) return fallback();
		throw createRemoteUnavailableError(url, method, null);
	}

	try {
		const operation = remoteFs?.[method];
		if (typeof operation !== "function") {
			throw new Error(`Remote filesystem does not support ${method}`);
		}
		const result = await withTimeout(
			operation.apply(remoteFs, args),
			timeout,
			`Remote ${method} timed out`,
		);
		remoteFailureUntil.delete(String(url));
		return result;
	} catch (error) {
		if (!isRemoteNetworkError(error)) throw error;
		rememberRemoteFailure(url);
		if (fallback) return fallback(error);
		throw createRemoteUnavailableError(url, method, error);
	}
}

function createRemoteFs(url, remoteFs) {
	const unavailableFolderListing = async () => [];
	const cachedRead = (...args) => readFromRemoteCache(url, remoteFs, args);
	const cachedStat = async () => {
		const stat = await getCachedRemoteStat(url, remoteFs);
		if (!stat) throw createRemoteUnavailableError(url, "stat", null);
		return stat;
	};
	const cachedExists = async () => {
		const cached = await findRemoteCache(url, remoteFs);
		return !!cached;
	};
	const noRemoteWrite = (operation = "write") =>
		Promise.reject(createRemoteUnavailableError(url, operation, null));

	const wrapped = {
		lsDir(...args) {
			// A networkless remote workspace cannot return a live directory listing.
			// Finish immediately instead of allowing the file tree to retry for many seconds.
			if (isBrowserOffline() || remoteIsCoolingDown(url)) return unavailableFolderListing();
			return invokeRemote(url, remoteFs, "lsDir", args, {
				timeout: REMOTE_METADATA_TIMEOUT,
				fallback: unavailableFolderListing,
			});
		},
		stat(...args) {
			return invokeRemote(url, remoteFs, "stat", args, {
				timeout: REMOTE_METADATA_TIMEOUT,
				fallback: cachedStat,
			});
		},
		exists(...args) {
			return invokeRemote(url, remoteFs, "exists", args, {
				timeout: REMOTE_METADATA_TIMEOUT,
				fallback: cachedExists,
			});
		},
		readFile(...args) {
			return invokeRemote(url, remoteFs, "readFile", args, {
				timeout: REMOTE_READ_TIMEOUT,
				fallback: cachedRead,
			});
		},
		writeFile(...args) {
			if (isBrowserOffline() || remoteIsCoolingDown(url)) return noRemoteWrite("write");
			return invokeRemote(url, remoteFs, "writeFile", args, {
				timeout: REMOTE_WRITE_TIMEOUT,
			});
		},
		createFile(...args) {
			if (isBrowserOffline() || remoteIsCoolingDown(url)) return noRemoteWrite("create file");
			return invokeRemote(url, remoteFs, "createFile", args, { timeout: REMOTE_WRITE_TIMEOUT });
		},
		createDirectory(...args) {
			if (isBrowserOffline() || remoteIsCoolingDown(url)) return noRemoteWrite("create directory");
			return invokeRemote(url, remoteFs, "createDirectory", args, { timeout: REMOTE_WRITE_TIMEOUT });
		},
		delete(...args) {
			if (isBrowserOffline() || remoteIsCoolingDown(url)) return noRemoteWrite("delete");
			return invokeRemote(url, remoteFs, "delete", args, { timeout: REMOTE_WRITE_TIMEOUT });
		},
		copyTo(...args) {
			if (isBrowserOffline() || remoteIsCoolingDown(url)) return noRemoteWrite("copy");
			return invokeRemote(url, remoteFs, "copyTo", args, { timeout: REMOTE_WRITE_TIMEOUT });
		},
		moveTo(...args) {
			if (isBrowserOffline() || remoteIsCoolingDown(url)) return noRemoteWrite("move");
			return invokeRemote(url, remoteFs, "moveTo", args, { timeout: REMOTE_WRITE_TIMEOUT });
		},
		renameTo(...args) {
			if (isBrowserOffline() || remoteIsCoolingDown(url)) return noRemoteWrite("rename");
			return invokeRemote(url, remoteFs, "renameTo", args, { timeout: REMOTE_WRITE_TIMEOUT });
		},
		get localName() {
			return remoteFs.localName;
		},
	};

	// Keep provider-specific helpers such as FTP's working-directory API while
	// routing normal filesystem calls through the offline-aware wrappers.
	return new Proxy(remoteFs, {
		get(target, property) {
			if (Object.prototype.hasOwnProperty.call(wrapped, property)) {
				return wrapped[property];
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

if (typeof window !== "undefined") {
	window.addEventListener("online", () => remoteFailureUntil.clear());
}

// Internal notification; plugins keep using fsOperation.extend as before.
export function onProviderRegistered(listener) {
	registrationListeners.add(listener);
	return () => registrationListeners.delete(listener);
}

/**
 * @typedef {Object} Stat
 * @property {string} name
 * @property {string} url
 * @property {string} uri - deprecated
 * @property {boolean} isFile
 * @property {boolean} isDirectory
 * @property {boolean} isLink
 * @property {number} size
 * @property {number} modifiedDate
 * @property {boolean} canRead
 * @property {boolean} canWrite
 */

/**
 * @typedef {Object} File
 * @property {string} name
 * @property {string} url
 * @property {boolean} isFile
 * @property {boolean} isDirectory
 * @property {boolean} isLink
 */

/**
 * @typedef {string|Blob|ArrayBuffer} FileContent
 * @typedef {Object} FileSystem
 * @property {() => Promise<File[]>} lsDir List directory
 * @property {() => Promise<void>} delete Delete file or directory
 * @property {() => Promise<boolean>} exists Check if file or directory exists
 * @property {() => Promise<Stat>} stat Get file or directory stat
 * @property {(encoding:string) => Promise<FileContent>} readFile Read file
 * @property {(data:FileContent, encoding: string) => Promise<void>} writeFile Write file content
 * @property {(name:string, data:FileContent) => Promise<string>} createFile Create file and return url of the created file
 * @property {(name:string) => Promise<string>} createDirectory Create directory and return url of the created directory
 * @property {(dest:string) => Promise<string>} copyTo Copy file or directory to destination
 * @property {(dest:string) => Promise<string>} moveTo Move file or directory to destination
 * @property {(newname:string) => Promise<string>} renameTo Rename file or directory
 */

/**
 * Create a file system object from a url
 * @param {...string} url
 * @returns {FileSystem}
 */
export default function fsOperation(...url) {
	if (url.length > 1) {
		url = Url.join(...url);
	} else {
		url = url[0];
	}
	const provider = fsList.find((item) => item.test(url));
	if (!provider) return undefined;
	const fs = provider.fs(url);
	return isRemoteUri(url) ? createRemoteFs(url, fs) : fs;
}

// Check registration without constructing a transport or opening a file.
export function hasProvider(url) {
	return fsList.some((fs) => fs.test(url));
}

fsOperation.extend = (test, fs) => {
	fsList.push({ test, fs });
	for (const listener of registrationListeners) {
		Promise.resolve()
			.then(() => listener(test))
			.catch(console.error);
	}
};

fsOperation.remove = (test) => {
	const index = fsList.findIndex((fs) => fs.test === test);
	if (index !== -1) fsList.splice(index, 1);
};

fsOperation.extend(Sftp.test, Sftp.fromUrl);
fsOperation.extend(Ftp.test, Ftp.fromUrl);
fsOperation.extend(internalFs.test, (url) => internalFs.createFs(url));
fsOperation.extend(externalFs.test, (url) => externalFs.createFs(url));

fsOperation.extend(
	(url) => /^https?:/.test(url),
	(url) => ({
		async readFile(encoding, progress) {
			const data = await ajax.get(url, {
				responseType: "arraybuffer",
				contentType: "application/x-www-form-urlencoded",
				onprogress: progress,
			});
			if (encoding) return decode(data, encoding);
			return data;
		},
		async writeFile(content, progress) {
			return ajax.post(url, {
				data: content,
				contentType: "application/x-www-form-urlencoded",
				onprogress: progress,
			});
		},
	}),
);
