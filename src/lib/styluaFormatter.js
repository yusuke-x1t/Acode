import externalFs from "fileSystem/externalFs";
import toast from "components/toast";
import { quoteArg, runQuickCommand } from "cm/lsp/installRuntime";
import Uri from "utils/Uri";

const STYLUA_BINARY = "/usr/bin/stylua";
const LUA_FILE_RE = /\.(lua|luau)$/i;

function decodePath(value) {
	if (typeof value !== "string") return "";
	let path = value.trim();
	if (!path) return "";

	if (/^file:\/\//i.test(path)) {
		try {
			path = decodeURIComponent(new URL(path).pathname);
		} catch {
			return "";
		}
	}

	if (/^(?:content|ftp|sftp):/i.test(path)) return "";
	return path.startsWith("/") && LUA_FILE_RE.test(path) ? path : "";
}

function decodeDocId(value) {
	try {
		return decodeURIComponent(String(value || "")).replace(/\\/g, "/");
	} catch {
		return String(value || "").replace(/\\/g, "/");
	}
}

function filenameFromUri(uri, fallback = "") {
	try {
		const leaf = new URL(uri).pathname.split("/").filter(Boolean).pop();
		if (leaf) return decodeURIComponent(leaf);
	} catch {}
	return fallback || "untitled.lua";
}

function safRelativePath(rootUri, fileUri) {
	try {
		const root = Uri.parse(rootUri);
		const file = Uri.parse(fileUri);
		if (!root?.docId || !file?.docId || root.rootUri !== file.rootUri) return "";

		const rootId = decodeDocId(root.docId).replace(/\/+$/, "");
		const fileId = decodeDocId(file.docId);
		if (fileId === rootId) return "";
		if (fileId.startsWith(`${rootId}/`)) {
			return fileId.slice(rootId.length + 1).replace(/^\/+/, "");
		}
	} catch {}
	return "";
}

async function getActualPath(rootUri, relativePath) {
	if (!rootUri || !relativePath) return "";
	try {
		const actual = await externalFs.getPath(rootUri, relativePath);
		return decodePath(String(actual || ""));
	} catch {
		return "";
	}
}

async function resolveStyLuaFilepath(file, mode) {
	const uri = String(file.uri || "");
	const directPath = decodePath(uri);
	if (directPath) return directPath;

	const filename = String(file.filename || filenameFromUri(uri, `untitled.${mode}`));
	const roots = Array.isArray(globalThis.addedFolder) ? globalThis.addedFolder : [];
	const contentRoots = roots
		.filter((item) => typeof item?.url === "string" && /^content:/i.test(item.url))
		.sort((a, b) => String(b.url).length - String(a.url).length);

	// Storage Access Framework URIs are virtual paths. Resolve the file relative
	// to the opened workspace directory; passing a file URI as getPath's root
	// does not work because that API expects a directory URI.
	for (const root of contentRoots) {
		const relativePath = safRelativePath(root.url, uri);
		if (!relativePath || !LUA_FILE_RE.test(relativePath)) continue;
		const actualPath = await getActualPath(root.url, relativePath);
		if (actualPath) return actualPath;
	}

	// If the file is not under an added workspace, attempt the SAF document's
	// own tree URI as the root and use its document ID as the relative path.
	if (/^content:/i.test(uri)) {
		try {
			const parsed = Uri.parse(uri);
			const rootUri = parsed?.rootUri;
			const fileDocId = decodeDocId(parsed?.docId);
			let relativePath = fileDocId;
			try {
				const rootParsed = Uri.parse(rootUri);
				const rootDocId = decodeDocId(rootParsed?.docId).replace(/\/+$/, "");
				if (rootDocId && relativePath.startsWith(`${rootDocId}/`)) {
					relativePath = relativePath.slice(rootDocId.length + 1);
				}
			} catch {}
			const actualPath = await getActualPath(rootUri, relativePath);
			if (actualPath) return actualPath;
		} catch (error) {
			console.warn("Could not resolve SAF path for StyLua:", error);
		}
	}

	const location = String(file.location || "");
	const locationPath = decodePath(location);
	if (locationPath && LUA_FILE_RE.test(locationPath)) {
		return locationPath;
	}

	throw new Error(
		`StyLua could not resolve an absolute filesystem path for ${filename}. Open this file through its workspace folder so StyLua can find .stylua.toml or stylua.toml.`,
	);
}

export async function formatActiveFileWithStyLua() {
	const manager = window.editorManager;
	const file = manager?.activeFile;
	const editor = manager?.editor;

	if (!file || file.type !== "editor" || !editor) return false;

	const mode = String(file.currentMode || "").toLowerCase();
	if (mode !== "lua" && mode !== "luau") {
		toast("StyLua only formats Lua and Luau files");
		return false;
	}

	const state = editor.state;
	const source = state.doc.toString();

	try {
		const filepath = await resolveStyLuaFilepath(file, mode);
		const command = `test -x ${quoteArg(STYLUA_BINARY)} && printf %s ${quoteArg(source)} | ${quoteArg(STYLUA_BINARY)} --search-parent-directories --stdin-filepath ${quoteArg(filepath)} -`;
		const formatted = await runQuickCommand(command);

		if (formatted === source) return true;

		const selection = state.selection.main;
		editor.dispatch({
			changes: {
				from: 0,
				to: state.doc.length,
				insert: formatted,
			},
			selection: {
				anchor: Math.min(selection.anchor, formatted.length),
				head: Math.min(selection.head, formatted.length),
			},
		});

		file.session = editor.state;
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		toast(message || "StyLua failed to format this file");
		return false;
	}
}
