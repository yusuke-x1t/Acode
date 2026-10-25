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
	if (/^content:/i.test(uri)) {
		try {
			const docId = decodeDocId(Uri.parse(uri)?.docId);
			const leaf = docId.split("/").filter(Boolean).pop();
			if (leaf) return leaf.split(":").pop() || leaf;
		} catch {}
	}

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

		// SAF volume roots often end in "primary:". Child IDs then continue
		// immediately after the colon, without a slash (primary:folder/file.lua).
		const prefix = rootId.endsWith(":") ? rootId : `${rootId}/`;
		if (fileId.startsWith(prefix)) {
			return fileId.slice(prefix.length).replace(/^\/+/, "");
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

function makeFallbackPath(filename, mode) {
	const leaf = String(filename || `untitled.${mode}`)
		.split(/[\\/]/)
		.pop()
		.replace(/[^A-Za-z0-9_.-]/g, "_");
	return `/tmp/${leaf && LUA_FILE_RE.test(leaf) ? leaf : `untitled.${mode}`}`;
}

async function resolveStyLuaFilepath(file, mode) {
	const uri = String(file.uri || "");
	const directPath = decodePath(uri);
	if (directPath) return { path: directPath, resolved: true };

	const filename = String(file.filename || filenameFromUri(uri, `untitled.${mode}`));
	const roots = Array.isArray(globalThis.addedFolder) ? globalThis.addedFolder : [];
	const contentRoots = roots
		.filter((item) => typeof item?.url === "string" && /^content:/i.test(item.url))
		.sort((a, b) => String(b.url).length - String(a.url).length);

	// Resolve a SAF document from its containing workspace directory. Passing a
	// file URI as getPath's root is invalid: that API expects a directory URI
	// and a path relative to that directory.
	for (const root of contentRoots) {
		const relativePath = safRelativePath(root.url, uri);
		if (!relativePath || !LUA_FILE_RE.test(relativePath)) continue;
		const actualPath = await getActualPath(root.url, relativePath);
		if (actualPath) return { path: actualPath, resolved: true };
	}

	// Also try the document's SAF tree URI if the file is outside an added
	// workspace folder.
	if (/^content:/i.test(uri)) {
		try {
			const parsed = Uri.parse(uri);
			const rootUri = parsed?.rootUri;
			const fileDocId = decodeDocId(parsed?.docId);
			let relativePath = fileDocId;
			try {
				const rootParsed = Uri.parse(rootUri);
				const rootDocId = decodeDocId(rootParsed?.docId).replace(/\/+$/, "");
				if (rootDocId) {
					const prefix = rootDocId.endsWith(":") ? rootDocId : `${rootDocId}/`;
					if (relativePath.startsWith(prefix)) {
						relativePath = relativePath.slice(prefix.length).replace(/^\/+/, "");
					}
				}
			} catch {}
			const actualPath = await getActualPath(rootUri, relativePath);
			if (actualPath) return { path: actualPath, resolved: true };
		} catch (error) {
			console.warn("Could not resolve SAF path for StyLua:", error);
		}
	}

	const locationPath = decodePath(String(file.location || ""));
	if (locationPath) return { path: locationPath, resolved: true };

	// A config file is optional. If Acode cannot expose an absolute OS path
	// (for example, an unsupported SAF provider), format with StyLua defaults
	// instead of blocking formatting or showing a misleading TOML error.
	return { path: makeFallbackPath(filename, mode), resolved: false };
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
		const resolved = await resolveStyLuaFilepath(file, mode);
		const searchParentDirectories = resolved.resolved ? "--search-parent-directories " : "";
		const command = `test -x ${quoteArg(STYLUA_BINARY)} && printf %s ${quoteArg(source)} | ${quoteArg(STYLUA_BINARY)} ${searchParentDirectories}--stdin-filepath ${quoteArg(resolved.path)} -`;
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
