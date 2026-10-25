import toast from "components/toast";
import confirm from "dialogs/confirm";
import loader from "dialogs/loader";
import {
	quoteArg,
	runForegroundCommand,
	runQuickCommand,
} from "../installRuntime";
import { defineBundle, defineServer, installers } from "../providerUtils";
import type {
	InstallCheckResult,
	LspServerBundle,
	LspServerManifest,
} from "../types";

const LUA_BINARY = "/usr/bin/lua-language-server";
const LUA_PACKAGE = "lua-language-server";

function buildApkCommand(mode: "install" | "update" | "reinstall"): string {
	const releaseRepository = '"$COMMUNITY_REPOSITORY"';
	const edgeRepository = "https://dl-cdn.alpinelinux.org/alpine/edge/community";
	const stableInstall = `apk add --no-cache --upgrade --repository ${releaseRepository} ${quoteArg(LUA_PACKAGE)}`;
	const edgeInstall = `apk add --no-cache --upgrade --repository ${quoteArg(edgeRepository)} ${quoteArg(LUA_PACKAGE)}`;
	const packageInstall = mode === "reinstall"
		? `apk fix --reinstall --repository ${releaseRepository} ${quoteArg(LUA_PACKAGE)} || ${stableInstall} || ${edgeInstall}`
		: `${stableInstall} || ${edgeInstall}`;
	return `if ! command -v apk >/dev/null 2>&1; then echo "APK is unavailable. Install or start Acode Terminal first." >&2; exit 127; fi; ALPINE_VERSION="$(cut -d. -f1,2 /etc/alpine-release)" && COMMUNITY_REPOSITORY="https://dl-cdn.alpinelinux.org/alpine/v$ALPINE_VERSION/community" && ${packageInstall} && test -x ${quoteArg(LUA_BINARY)} && ${quoteArg(LUA_BINARY)} --version`;
}

async function getLuaVersion(): Promise<string | null> {
	const output = await runQuickCommand(`${quoteArg(LUA_BINARY)} --version`);
	return output.trim() || null;
}

export const luaServers: LspServerManifest[] = [
	defineServer({
		id: "lua",
		label: "Lua (Lua Language Server)",
		languages: ["lua"],
		command: LUA_BINARY,
		args: [],
		checkCommand: `test -x ${quoteArg(LUA_BINARY)}`,
		versionCommand: `${quoteArg(LUA_BINARY)} --version`,
		updateCommand: buildApkCommand("update"),
		uninstallCommand: `apk del ${quoteArg(LUA_PACKAGE)}`,
		installer: installers.apk({
			executable: LUA_BINARY,
			packages: [LUA_PACKAGE],
		}),
		useWorkspaceFolders: true,
		priority: 0,
		clientConfig: {
			workspaceConfiguration: {
				Lua: {
					runtime: {
						version: "Lua 5.4",
						path: ["?.lua", "?/init.lua"],
						pathStrict: false,
					},
					workspace: {
						checkThirdParty: false,
					},
					telemetry: {
						enable: false,
					},
				},
			},
		},
		enabled: true,
	}),
];

export const luaBundle: LspServerBundle = defineBundle({
	id: "builtin-lua",
	label: "Lua",
	servers: luaServers,
	hooks: {
		getExecutable: () => LUA_BINARY,
		async checkInstallation(): Promise<InstallCheckResult> {
			try {
				await runQuickCommand(`test -x ${quoteArg(LUA_BINARY)}`);
			} catch (error) {
				return {
					status: "missing",
					version: null,
					canInstall: true,
					canUpdate: true,
					message: error instanceof Error ? error.message : String(error),
				};
			}
			try {
				return {
					status: "present",
					version: await getLuaVersion(),
					canInstall: true,
					canUpdate: true,
				};
			} catch (error) {
				return {
					status: "failed",
					version: null,
					canInstall: true,
					canUpdate: true,
					message: error instanceof Error ? error.message : String(error),
				};
			}
		},
		async installServer(_, manifest, mode, options = {}): Promise<boolean> {
			const { promptConfirm = true } = options;
			const label = manifest.label || "Lua Language Server";
			const verb = mode === "update" ? "Update" : mode === "reinstall" ? "Repair" : "Install";
			if (promptConfirm) {
				const shouldContinue = await confirm(
					label,
					`${verb} ${label} from the matching Alpine community repository, with an edge fallback if unavailable?`,
				);
				if (!shouldContinue) return false;
			}
			const progressVerb = mode === "update" ? "Updating" : mode === "reinstall" ? "Repairing" : "Installing";
			const loadingDialog = loader.create(label, `${progressVerb} ${label}...`);
			try {
				loadingDialog.show();
				await runForegroundCommand(buildApkCommand(mode));
				const version = await getLuaVersion();
				toast(`${label} ${mode === "update" ? "updated" : mode === "reinstall" ? "repaired" : "installed"}${version ? ` (${version})` : ""}`);
				return true;
			} catch (error) {
				console.error(`Failed to ${verb.toLowerCase()} ${label}`, error);
				toast(error instanceof Error ? error.message : `Failed to ${verb.toLowerCase()} ${label}`);
				throw error;
			} finally {
				loadingDialog.destroy();
			}
		},
	},
});
