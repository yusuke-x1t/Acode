import { quoteArg, runQuickCommand } from "cm/lsp/installRuntime";
import serverRegistry from "cm/lsp/serverRegistry";
import appSettings from "lib/settings";

const STYLUA_ID = "stylua";
const STYLUA_BINARY = "/usr/bin/stylua";
const MAX_EXECUTOR_RETRIES = 30;
const HIDDEN_SETTING_KEYS = [
	"startup_timeout",
	"edit_init_options",
	"view_init_options",
	"ext_hover",
	"ext_completion",
	"ext_signature",
	"ext_diagnostics",
	"ext_inlayHints",
	"ext_formatting",
];

let retryTimer = null;
let retryCount = 0;
let activeAcode = null;
let syncPromise = null;

function installStyLuaSettingsStyle() {
	if (
		typeof document === "undefined" ||
		document.getElementById("acode-stylua-management-style")
	) {
		return;
	}

	const style = document.createElement("style");
	style.id = "acode-stylua-management-style";
	style.textContent = HIDDEN_SETTING_KEYS.map(
		(key) => `.detail-settings-list[data-lsp-server-id="stylua"] [data-key="${key}"]{display:none!important}`,
	).join("\n");
	document.head?.appendChild(style);
}

function isStyLuaEnabled() {
	const server = serverRegistry.getServer(STYLUA_ID);
	const override = appSettings.value?.lsp?.servers?.[STYLUA_ID];
	return (override?.enabled ?? server?.enabled ?? true) !== false;
}

function isRegistered(acode) {
	return acode.formatters.some(({ id }) => id === STYLUA_ID);
}

function unregisterIfPresent(acode) {
	if (isRegistered(acode)) acode.unregisterFormatter(STYLUA_ID);
}

function clearRetry() {
	if (retryTimer !== null) {
		clearTimeout(retryTimer);
		retryTimer = null;
	}
}

function scheduleRetry(acode) {
	if (retryTimer !== null || retryCount >= MAX_EXECUTOR_RETRIES) return;
	retryCount += 1;
	retryTimer = setTimeout(() => {
		retryTimer = null;
		void syncStyLuaFormatter(acode || window?.acode);
	}, 1000);
}

function isExecutorUnavailable(error) {
	const message = error instanceof Error ? error.message : String(error);
	return /executor plugin is not available/i.test(message);
}

async function detectStyLua() {
	if (typeof globalThis.Executor === "undefined") {
		const error = new Error("Executor plugin is not available");
		error.name = "ExecutorUnavailableError";
		throw error;
	}

	await runQuickCommand(
		`test -x ${quoteArg(STYLUA_BINARY)} && ${quoteArg(STYLUA_BINARY)} --version`,
	);
	return true;
}

export async function syncStyLuaFormatter(acode = window?.acode) {
	activeAcode = acode || activeAcode;
	installStyLuaSettingsStyle();

	if (!activeAcode) {
		scheduleRetry(null);
		return;
	}
	if (syncPromise) return syncPromise;

	syncPromise = (async () => {
		let installed = false;
		try {
			await detectStyLua();
			installed = true;
			retryCount = 0;
			clearRetry();
		} catch (error) {
			if (isExecutorUnavailable(error)) {
				scheduleRetry(activeAcode);
				return;
			}
		}

		if (!installed || !isStyLuaEnabled()) {
			unregisterIfPresent(activeAcode);
			return;
		}
		if (isRegistered(activeAcode)) return;

		activeAcode.registerFormatter(
			STYLUA_ID,
			["lua", "luau"],
			async () => {
				if (!isStyLuaEnabled()) return false;
				const { formatActiveFileWithStyLua } = await import("lib/styluaFormatter");
				return formatActiveFileWithStyLua();
			},
			"StyLua",
		);
	})().finally(() => {
		syncPromise = null;
	});

	return syncPromise;
}

function resyncStyLuaFormatter() {
	retryCount = 0;
	clearRetry();
	void syncStyLuaFormatter(window?.acode || activeAcode);
}

appSettings.on("update:lsp", resyncStyLuaFormatter);

if (typeof window !== "undefined") {
	window.addEventListener("acode-stylua-installation-changed", resyncStyLuaFormatter);
	window.addEventListener("online", resyncStyLuaFormatter);
	window.addEventListener("offline", resyncStyLuaFormatter);
}

export async function registerStyLuaFormatter(acode = window?.acode) {
	await syncStyLuaFormatter(acode);
}
