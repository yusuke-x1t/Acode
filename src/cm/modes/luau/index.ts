import {
	IndentContext,
	LanguageSupport,
	StreamLanguage,
	StringStream,
} from "@codemirror/language";
import { unmatchedBracketExtension } from "../unmatchedBrackets";

type Tokenizer = (stream: StringStream, state: LuauState) => string | null;

interface LuauState {
	basecol: number;
	indentDepth: number;
	cur: Tokenizer;
	stack: Tokenizer[];
	expectFunctionName: boolean;
	afterFunctionName: boolean;
	expectTypeName: boolean;
	afterTypeName: boolean;
	afterTypeIdentifier: boolean;
	inType: boolean;
	typeDepth: number;
	genericDepth: number;
	interpolationBraceDepth: number;
	afterPropertyAccess: boolean;
	propertyAccessKind: "." | ":" | null;
	typeAliasNames: Set<string>;
	typeTableDepths: number[];
	typeFieldExpected: boolean;
	typeContextKind: "alias" | "annotation" | "return" | null;
	typeLineContinues: boolean;
	lastIdentifierWasStandard: boolean;
	inFunctionParams: boolean;
	functionParamsDepth: number;
	functionGenericParams: boolean;
	docCommentExpectParamName: boolean;
	docCommentExpectType: boolean;
	forHeader: boolean;
	forHeaderExpectName: boolean;
	tableDepth: number;
	localDeclaration: boolean;
}

const controlKeywords = new Set([
	"break", "continue", "do", "else", "elseif", "end", "for", "function",
	"if", "in", "repeat", "return", "then", "type", "until", "while",
]);

const modifierKeywords = new Set(["const", "export", "local"]);
const logicalKeywords = new Set(["and", "not", "or"]);

const typePrimitives = new Set([
	"any", "boolean", "buffer", "never", "nil", "number", "string", "symbol",
	"thread", "unknown", "userdata", "vector",
]);

const standardFunctions = new Set([
	"assert", "collectgarbage", "delay", "error", "gcinfo", "getfenv", "getmetatable",
	"ipairs", "loadstring", "newproxy", "next", "pairs", "pcall", "print", "printidentity",
	"rawequal", "rawset", "require", "select", "setfenv", "setmetatable", "settings", "spawn",
	"stats", "tick", "time", "tonumber", "tostring", "type", "typeof", "unpack", "UserSettings",
	"version", "wait", "warn",
]);

const standardNamespaces = new Set([
	"bit32", "buffer", "coroutine", "debug", "math", "os", "string", "table", "task", "utf8",
	"vector", "Enum",
]);

const standardLibraryFunctions: Record<string, Set<string>> = {
	bit32: new Set([
		"arshift", "band", "bnot", "bor", "btest", "bxor", "extract", "replace",
		"lrotate", "lshift", "rrotate", "rshift",
	]),
	buffer: new Set([
		"copy", "create", "fill", "fromstring", "len", "readbits", "readf32", "readf64",
		"readi8", "readi16", "readi32", "readstring", "readu8", "readu16", "readu32",
		"tostring", "writebits", "writef32", "writef64", "writei8", "writei16", "writei32",
		"writestring", "writeu8", "writeu16", "writeu32",
	]),
	coroutine: new Set([
		"close", "create", "isyieldable", "resume", "running", "status", "wrap", "yield",
	]),
	debug: new Set(["info", "traceback"]),
	math: new Set([
		"abs", "acos", "asin", "atan", "atan2", "ceil", "clamp", "cos", "cosh", "deg",
		"exp", "floor", "fmod", "frexp", "ldexp", "log", "log10", "max", "min", "modf",
		"noise", "pow", "rad", "random", "randomseed", "round", "sign", "sin", "sinh", "sqrt",
		"tan", "tanh",
	]),
	os: new Set(["clock", "date", "difftime", "time"]),
	string: new Set([
		"byte", "char", "find", "format", "gmatch", "gsub", "len", "lower", "match", "rep",
		"reverse", "split", "sub", "upper",
	]),
	table: new Set([
		"clear", "clone", "concat", "create", "find", "freeze", "insert", "isfrozen", "maxn",
		"move", "pack", "remove", "sort", "unpack",
	]),
	task: new Set(["cancel", "defer", "delay", "desynchronize", "spawn", "synchronize", "wait"]),
	utf8: new Set(["char", "codes", "codepoint", "len", "offset"]),
	vector: new Set(["abs", "angle", "ceil", "floor", "max", "min", "sign", "zero"]),
};

const standardConstantMembers: Record<string, Set<string>> = {
	math: new Set(["huge", "pi"]),
};

function hasCompleteStandardLibraryMember(namespace: string, stream: StringStream) {
	const member = /^\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\b/.exec(
		stream.string.slice(stream.pos),
	);
	if (!member) return false;
	return !!(
		standardLibraryFunctions[namespace]?.has(member[1]) ||
		standardConstantMembers[namespace]?.has(member[1])
	);
}

const standardVariables = new Set([
	"_G", "_VERSION", "DebuggerManager", "PluginManager", "game", "plugin", "script", "shared",
	"workspace",
]);

const typeTerminators = new Set([
	"break", "const", "continue", "do", "else", "elseif", "end", "export", "for", "if", "in", "local", "repeat",
	"return", "then", "until", "while",
]);

const indentTokens = new Set(["do", "function", "if", "repeat", "(", "{"]);
const dedentTokens = new Set(["end", "until", ")", "}"]);
const dedentPartial = /^(?:end|until|else|elseif)\b|^[)}]/;

function pushTokenizer(state: LuauState, tokenizer: Tokenizer) {
	state.stack.push(state.cur);
	state.cur = tokenizer;
}

function popTokenizer(state: LuauState) {
	state.cur = state.stack.pop() || normal;
}

function enterTypeContext(
	state: LuauState,
	depth = 0,
	kind?: "alias" | "annotation" | "return",
) {
	if (!state.inType) {
		state.inType = true;
		state.typeDepth = depth;
		state.typeTableDepths = [];
		state.typeFieldExpected = false;
		state.typeContextKind = kind || "annotation";
	} else if (depth > state.typeDepth) {
		state.typeDepth = depth;
	}
	if (kind) state.typeContextKind = kind;
}

function exitTypeContext(state: LuauState) {
	state.inType = false;
	state.typeDepth = 0;
	state.genericDepth = 0;
	state.typeTableDepths = [];
	state.typeFieldExpected = false;
	state.typeContextKind = null;
	state.typeLineContinues = false;
	state.afterTypeIdentifier = false;
}

function isWordStart(char: string) {
	return /[A-Za-z_]/.test(char);
}

function isWord(char: string) {
	return /[A-Za-z0-9_]/.test(char);
}

function isUpperConstant(word: string) {
	return /^[A-Z_][A-Z0-9_]*$/.test(word) && /[A-Z]/.test(word);
}

function isReservedIdentifier(word: string) {
	return (
		controlKeywords.has(word) || modifierKeywords.has(word) || logicalKeywords.has(word) ||
		word === "true" || word === "false" || word === "nil"
	);
}

function isStandardWord(word: string) {
	return standardFunctions.has(word) || standardNamespaces.has(word) || standardVariables.has(word);
}

function isCallArgumentsText(text: string) {
	return /^\s*(?:\(|\{|["'`]|\[(?:=*)\[)/.test(text);
}

function isCallArguments(stream: StringStream) {
	return isCallArgumentsText(stream.string.slice(stream.pos));
}

function looksLikeMethodSeparator(stream: StringStream) {
	const rest = stream.string.slice(stream.pos);
	const method = /^\s*[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
	return !!method && isCallArgumentsText(rest.slice(method[0].length));
}

function looksLikeTypeAnnotationColon(stream: StringStream, state: LuauState) {
	if (state.inType || state.inFunctionParams) return true;

	const prefix = stream.string.slice(0, stream.start);
	if (/^\s*(?:export\s+)?local\s+[A-Za-z_][A-Za-z0-9_]*\s*$/.test(prefix)) return true;
	if (/\)\s*$/.test(prefix)) return true;

	const rest = stream.string.slice(stream.pos);
	if (/^\s*[{[(]/.test(rest)) return true;
	const type = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
	if (!type) return false;
	const name = type[1];
	const knownType = typePrimitives.has(name) || state.typeAliasNames.has(name) || /^[A-Z]/.test(name);
	if (!knownType) return false;
	return /^\s*(?:[?&|<>=,;)}\]]|$)/.test(rest.slice(type[0].length));
}

function isCallbackAssignment(stream: StringStream) {
	return /^\s*=\s*[A-Za-z_][A-Za-z0-9_]*(?:\s*[.:]\s*[A-Za-z_][A-Za-z0-9_]*)*\s*\(\s*function\s*\(/.test(
		stream.string.slice(stream.pos),
	);
}

function isFunctionValueAssignment(stream: StringStream) {
	return /^\s*=\s*function\b/.test(stream.string.slice(stream.pos));
}

function looksLikeMethodReceiver(stream: StringStream, state: LuauState) {
	if (state.inType || state.inFunctionParams) return false;

	const throughIdentifier = stream.string.slice(0, stream.pos);
	if (/^\s*(?:export\s+)?local\s+[A-Za-z_][A-Za-z0-9_]*\s*$/.test(throughIdentifier)) return false;

	const rest = stream.string.slice(stream.pos);
	const separator = /^\s*:(?!:)(?:\s*([A-Za-z_][A-Za-z0-9_]*))?/.exec(rest);
	if (!separator) return false;
	const methodName = separator[1];
	if (!methodName) return rest.trim() === ":";

	const afterMethod = rest.slice(separator[0].length);
	const looksLikeTypeName = typePrimitives.has(methodName) || state.typeAliasNames.has(methodName) || /^[A-Z]/.test(methodName);
	if (looksLikeTypeName && /^\s*(?:=|[,;)}\]]|$)/.test(afterMethod)) return false;
	return true;
}

function readLongBracket(stream: StringStream) {
	let level = 0;
	while (stream.eat("=")) level++;
	return stream.eat("[") ? level : -1;
}

function bracketed(level: number, style: string): Tokenizer {
	return (stream, state) => {
		let seenEquals: number | null = null;
		while (true) {
			const char = stream.next();
			if (char == null) break;
			if (seenEquals == null) {
				if (char === "]") seenEquals = 0;
			} else if (char === "=") {
				seenEquals++;
			} else if (char === "]" && seenEquals === level) {
				popTokenizer(state);
				break;
			} else {
				seenEquals = null;
			}
		}
		return style;
	};
}


function quotedString(quote: string): Tokenizer {
	return (stream, state) => {
		let escaped = false;

		while (true) {
			const char = stream.next();

			if (char == null) {
				popTokenizer(state);
				break;
			}

			if (char === quote && !escaped) {
				popTokenizer(state);
				break;
			}

			escaped = !escaped && char === "\\";
		}

		return "string";
	};
}


const interpolatedString: Tokenizer = (stream, state) => {
	while (true) {
		const char = stream.next();
		if (char == null) break;
		if (char === "\\") {
			stream.next();
			continue;
		}
		if (char === "{") {
			if (stream.pos - stream.start > 1) {
				stream.backUp(1);
				return "string";
			}
			state.interpolationBraceDepth = 0;
			pushTokenizer(state, interpolatedExpression);
			return "punctuation";
		}
		if (char === "`") {
			popTokenizer(state);
			break;
		}
	}
	return "string";
};

const interpolatedExpression: Tokenizer = (stream, state) => {
	if (stream.eatSpace()) return null;
	if (stream.peek() === "}" && state.interpolationBraceDepth === 0) {
		stream.next();
		popTokenizer(state);
		return "punctuation";
	}
	const style = normal(stream, state);
	const token = stream.current();
	if (state.cur === interpolatedExpression) {
		if (token === "{") state.interpolationBraceDepth++;
		else if (token === "}" && state.interpolationBraceDepth > 0) state.interpolationBraceDepth--;
	}
	return style;
};

const docCommentLine: Tokenizer = (stream, state) => {
	if (stream.eatSpace()) return null;
	const peek = stream.peek();
	if (!peek) {
		state.docCommentExpectParamName = false;
		state.docCommentExpectType = false;
		return null;
	}
	if (stream.match(/(?:\\|@)[A-Za-z_][A-Za-z0-9_]*/)) {
		const tag = stream.current().slice(1).toLowerCase();
		state.docCommentExpectParamName = tag === "param";
		state.docCommentExpectType = [
			"param", "return", "type", "field", "cast", "class", "alias", "enum", "overload",
			"generic", "vararg", "as",
		].includes(tag);
		return "annotation";
	}
	if (state.docCommentExpectParamName && isWordStart(peek)) {
		stream.next();
		stream.eatWhile(isWord);
		state.docCommentExpectParamName = false;
		state.docCommentExpectType = true;
		return "variableName";
	}
	if (
		state.docCommentExpectType &&
		(isWordStart(peek) || peek === "{" || peek === "(" || peek === "[" || peek === "?" || peek === "." || peek === "|")
	) {
		stream.next();
		stream.eatWhile((char) => !/\s/.test(char));
		state.docCommentExpectType = false;
		return "typeName";
	}
	stream.next();
	stream.eatWhile((char) => !/\s/.test(char));
	return "comment";
};

function readNumber(stream: StringStream, firstChar: string) {
	const next = stream.peek();
	if (firstChar === "0" && next && /[xX]/.test(next)) {
		stream.next();
		stream.eatWhile(/[0-9a-fA-F_]/);
		return;
	}
	stream.eatWhile(/[\d_]/);
	if (stream.peek() === "." && stream.string.charAt(stream.pos + 1) !== ".") {
		stream.next();
		stream.eatWhile(/[\d_]/);
	}
	const exponent = stream.peek();
	if (exponent && /[eE]/.test(exponent)) {
		stream.next();
		stream.eat(/[+-]/);
		stream.eatWhile(/[\d_]/);
	}
}

function classifyIdentifier(word: string, state: LuauState, stream: StringStream) {
	if (
		state.inType &&
		state.typeDepth === 0 &&
		(typeTerminators.has(word) || modifierKeywords.has(word) || logicalKeywords.has(word))
	) {
		exitTypeContext(state);
		state.afterPropertyAccess = false;
		state.propertyAccessKind = null;
	}
	if (state.afterPropertyAccess && isReservedIdentifier(word)) {
		state.afterPropertyAccess = false;
		state.propertyAccessKind = null;
		state.lastIdentifierWasStandard = false;
	}

	if (
		state.forHeader && word !== "in" && word !== "do" &&
		(controlKeywords.has(word) || modifierKeywords.has(word) || logicalKeywords.has(word))
	) {
		state.forHeader = false;
		state.forHeaderExpectName = false;
	}
	if (
		state.expectFunctionName &&
		(controlKeywords.has(word) || modifierKeywords.has(word) || logicalKeywords.has(word))
	) state.expectFunctionName = false;
	if (
		state.expectTypeName &&
		(word === "function" || controlKeywords.has(word) || modifierKeywords.has(word) || logicalKeywords.has(word))
	) state.expectTypeName = false;
	if (
		state.inFunctionParams &&
		(controlKeywords.has(word) || modifierKeywords.has(word) || logicalKeywords.has(word))
	) {
		state.inFunctionParams = false;
		state.functionParamsDepth = 0;
	}

	const isTypeField = state.inType && state.typeDepth > 0 && state.typeFieldExpected &&
		state.typeTableDepths[state.typeTableDepths.length - 1] === state.typeDepth;

	if (!state.afterPropertyAccess && !isTypeField && state.localDeclaration && word !== "self" &&
		!/^\s*,/.test(stream.string.slice(stream.pos))) state.localDeclaration = false;

	if (!state.afterPropertyAccess && !isTypeField && (word === "_ENV" || word === "_G")) {
		state.lastIdentifierWasStandard = false;
		state.afterFunctionName = false;
		state.afterTypeIdentifier = false;
		return "modifier";
	}
	if (!state.afterPropertyAccess && !isTypeField && word === "self") {
		const isAssignment = /^\s*=(?!=)/.test(stream.string.slice(stream.pos));
		const isLocal = state.localDeclaration;
		state.localDeclaration = false;
		state.lastIdentifierWasStandard = false;
		state.afterFunctionName = false;
		state.afterTypeIdentifier = false;
		return isLocal || isAssignment ? "variableName" : "modifier";
	}

	if (state.forHeader && word === "in") {
		state.forHeader = false;
		state.forHeaderExpectName = false;
		state.lastIdentifierWasStandard = false;
		state.afterFunctionName = false;
		state.afterTypeIdentifier = false;
		return "controlKeyword";
	}
	if (state.forHeader && word === "do") {
		state.forHeader = false;
		state.forHeaderExpectName = false;
	}
	if (
		state.forHeader && !controlKeywords.has(word) && !modifierKeywords.has(word) && !logicalKeywords.has(word)
	) {
		if (!state.forHeaderExpectName) state.forHeader = false;
		else {
			state.forHeaderExpectName = false;
			state.lastIdentifierWasStandard = false;
			state.afterFunctionName = false;
			state.afterTypeIdentifier = false;
			return "variableName.special";
		}
	}

	if (state.expectFunctionName && isWordStart(word)) {
		const rest = stream.string.slice(stream.pos);
		const isQualifiedFunctionName = /^\s*[.:]\s*[A-Za-z_]/.test(rest);
		const isMethodDefinition = /^\s*:\s*[A-Za-z_]/.test(rest);
		state.expectFunctionName = false;
		state.afterFunctionName = true;
		state.afterPropertyAccess = false;
		state.afterTypeIdentifier = false;
		state.lastIdentifierWasStandard = false;
		if (isMethodDefinition) return "className";
		if (isQualifiedFunctionName) return "variableName";
		return "variableName.function.definition";
	}

	if (state.expectTypeName && word !== "function") {
		state.expectTypeName = false;
		state.afterTypeName = true;
		state.afterTypeIdentifier = true;
		state.afterFunctionName = false;
		state.lastIdentifierWasStandard = false;
		state.typeAliasNames.add(word);
		return "variableName.definition";
	}

	if (state.afterPropertyAccess) {
		const prefix = stream.string.slice(0, stream.start);
		const parentMatch = /([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*$/.exec(prefix);
		const standardParent = state.lastIdentifierWasStandard ? parentMatch?.[1] || null : null;
		const accessKind = state.propertyAccessKind;
		const isCall = isCallArguments(stream);
		const isFunctionDefinitionName = state.afterFunctionName;
		const isMethodReceiver = looksLikeMethodReceiver(stream, state);
		state.afterPropertyAccess = false;
		state.propertyAccessKind = null;
		state.lastIdentifierWasStandard = false;
		state.afterFunctionName = isFunctionDefinitionName;
		state.afterTypeIdentifier = false;

		if (isMethodReceiver) {
			state.afterFunctionName = false;
			return "className";
		}
		if (standardParent && standardConstantMembers[standardParent]?.has(word)) {
			state.afterFunctionName = false;
			return "constant.language";
		}
		if (standardParent && standardLibraryFunctions[standardParent]?.has(word)) {
			state.afterFunctionName = false;
			return "propertyName.function.standard";
		}
		if (isFunctionValueAssignment(stream)) {
			state.afterFunctionName = false;
			return "propertyName.function.definition";
		}
		if (isFunctionDefinitionName && isCall) return "propertyName.function.definition";
		if (isCall) {
			state.afterFunctionName = false;
			return "propertyName.function";
		}
		return accessKind === ":" ? "className" : "propertyName";
	}

	if (
		state.inType &&
		state.typeDepth > 0 &&
		state.typeFieldExpected &&
		state.typeTableDepths[state.typeTableDepths.length - 1] === state.typeDepth
	) {
		state.typeFieldExpected = false;
		state.lastIdentifierWasStandard = false;
		state.afterFunctionName = false;
		state.afterTypeIdentifier = false;
		return "propertyName.definition";
	}

	if (looksLikeMethodReceiver(stream, state)) {
		state.lastIdentifierWasStandard = false;
		state.afterFunctionName = false;
		state.afterTypeIdentifier = false;
		return "className";
	}
	if (isFunctionValueAssignment(stream)) {
		state.lastIdentifierWasStandard = false;
		state.afterFunctionName = false;
		state.afterTypeIdentifier = false;
		return "variableName.function.definition";
	}
	if (state.tableDepth > 0 && /^\s*=/.test(stream.string.slice(stream.pos))) {
		state.lastIdentifierWasStandard = false;
		state.afterFunctionName = false;
		state.afterTypeIdentifier = false;
		return "variableName";
	}
	if (isCallbackAssignment(stream)) {
		state.lastIdentifierWasStandard = false;
		state.afterFunctionName = false;
		state.afterTypeIdentifier = false;
		return "variableName.special";
	}

	if (state.inType) {
		state.lastIdentifierWasStandard = false;
		state.afterFunctionName = false;
		state.afterTypeIdentifier = true;
		if (word === "typeof") return "variableName.function.standard";
		if (typePrimitives.has(word) || isUpperConstant(word)) return "typeName";
		return "typeName";
	}

	if (state.inFunctionParams) {
		state.lastIdentifierWasStandard = false;
		state.afterFunctionName = false;
		state.afterTypeIdentifier = false;
		return "variableName.special";
	}
	if (logicalKeywords.has(word)) {
		state.lastIdentifierWasStandard = false;
		state.afterFunctionName = false;
		state.afterTypeIdentifier = false;
		return "modifier";
	}
	if (modifierKeywords.has(word)) {
		if (word === "local") state.localDeclaration = true;
		state.lastIdentifierWasStandard = false;
		state.afterFunctionName = false;
		state.afterTypeIdentifier = false;
		return "modifier";
	}
	if (word === "type") {
		state.expectTypeName = true;
		state.afterTypeName = false;
		state.afterFunctionName = false;
		state.afterTypeIdentifier = false;
		state.lastIdentifierWasStandard = false;
		return "definitionKeyword";
	}
	if (word === "function") {
		if (!state.expectTypeName) state.expectFunctionName = true;
		state.afterFunctionName = false;
		state.afterTypeIdentifier = false;
		state.lastIdentifierWasStandard = false;
		return "controlKeyword";
	}
	if (word === "true" || word === "false") {
		state.lastIdentifierWasStandard = false;
		state.afterFunctionName = false;
		state.afterTypeIdentifier = false;
		return "bool";
	}
	if (word === "nil") {
		state.lastIdentifierWasStandard = false;
		state.afterFunctionName = false;
		state.afterTypeIdentifier = false;
		return "null";
	}
	if (controlKeywords.has(word)) {
		if (word === "for") {
			state.forHeader = true;
			state.forHeaderExpectName = true;
		}
		if (state.inType && state.typeDepth === 0 && typeTerminators.has(word)) exitTypeContext(state);
		state.lastIdentifierWasStandard = false;
		state.afterFunctionName = false;
		state.afterTypeIdentifier = false;
		return "controlKeyword";
	}
	if (state.inType) {
		state.lastIdentifierWasStandard = false;
		state.afterFunctionName = false;
		state.afterTypeIdentifier = true;
		if (word === "typeof") return "variableName.function.standard";
		if (typePrimitives.has(word) || isUpperConstant(word)) return "typeName";
		return "typeName";
	}
	if (standardNamespaces.has(word)) {
		state.lastIdentifierWasStandard = true;
		state.afterFunctionName = false;
		state.afterTypeIdentifier = false;
		return hasCompleteStandardLibraryMember(word, stream)
			? "namespace.standard"
			: "variableName";
	}
	if (standardVariables.has(word)) {
		state.lastIdentifierWasStandard = true;
		state.afterFunctionName = false;
		state.afterTypeIdentifier = false;
		return "variableName.standard";
	}
	if (standardFunctions.has(word)) {
		state.lastIdentifierWasStandard = false;
		state.afterFunctionName = false;
		state.afterTypeIdentifier = false;
		return "variableName.function";
	}
	if (isCallArguments(stream)) {
		state.lastIdentifierWasStandard = false;
		state.afterFunctionName = false;
		state.afterTypeIdentifier = false;
		return "variableName.function";
	}
	if (isUpperConstant(word) && state.tableDepth === 0) {
		state.lastIdentifierWasStandard = false;
		state.afterFunctionName = false;
		state.afterTypeIdentifier = false;
		return "variableName.constant";
	}
	state.lastIdentifierWasStandard = isStandardWord(word);
	state.afterFunctionName = false;
	state.afterTypeIdentifier = false;
	return "variableName";
}

const normal: Tokenizer = (stream, state) => {
	const char = stream.next();
	if (!char) return null;
	if (state.afterPropertyAccess && !isWordStart(char)) {
		state.afterPropertyAccess = false;
		state.propertyAccessKind = null;
		state.lastIdentifierWasStandard = false;
	}
	if (char === "-" && stream.eat("-")) {
		if (stream.eat("-")) {
			state.docCommentExpectParamName = false;
			state.docCommentExpectType = false;
			pushTokenizer(state, docCommentLine);
			return "comment";
		}
		if (stream.eat("[")) {
			const longBracketStart = stream.pos;
			const level = readLongBracket(stream);
			if (level >= 0) {
				pushTokenizer(state, bracketed(level, "comment"));
				return state.cur(stream, state);
			}
			stream.backUp(stream.pos - longBracketStart);
		}
		stream.skipToEnd();
		return "comment";
	}
	if (state.forHeader && char !== "," && char !== "=" && !isWordStart(char)) {
		state.forHeader = false;
		state.forHeaderExpectName = false;
	}
	if (char === '"' || char === "'") {
		pushTokenizer(state, quotedString(char));
		return state.cur(stream, state);
	}
	if (char === "`") {
		pushTokenizer(state, interpolatedString);
		return state.cur(stream, state);
	}
	if (char === "[") {
		const longBracketStart = stream.pos;
		const level = readLongBracket(stream);
		if (level >= 0) {
			pushTokenizer(state, bracketed(level, "string"));
			return state.cur(stream, state);
		}
		stream.backUp(stream.pos - longBracketStart);
	}
	if (char === "@" && isWordStart(stream.peek() || "")) {
		stream.eatWhile(isWord);
		state.lastIdentifierWasStandard = false;
		return "attributeName";
	}
	if (/\d/.test(char) || (char === "." && /\d/.test(stream.peek() || ""))) {
		readNumber(stream, char);
		state.lastIdentifierWasStandard = false;
		return "number";
	}
	if (isWordStart(char)) {
		stream.eatWhile(isWord);
		return classifyIdentifier(stream.current(), state, stream);
	}
	if (char === "." || char === ":") {
		if (char === "." && stream.eat(".")) {
			state.afterFunctionName = false;
			state.afterTypeIdentifier = false;
			if (stream.eat(".")) {
				state.lastIdentifierWasStandard = false;
				return "operator";
			}
			stream.eat("=");
			state.lastIdentifierWasStandard = false;
			return "operator";
		}
		if (char === ":" && stream.eat(":")) {
			enterTypeContext(state, 0, "annotation");
			state.afterPropertyAccess = false;
			state.propertyAccessKind = null;
			state.lastIdentifierWasStandard = false;
			return "operator";
		}
		if (
			char === ":" &&
			!state.expectFunctionName &&
			!looksLikeMethodSeparator(stream) &&
			looksLikeTypeAnnotationColon(stream, state)
		) {
			if (!state.inType) enterTypeContext(state, 0, "annotation");
			state.afterPropertyAccess = false;
			state.propertyAccessKind = null;
			state.lastIdentifierWasStandard = false;
			return "operator";
		}
		if (char === ":" && state.inType) {
			state.afterPropertyAccess = false;
			state.propertyAccessKind = null;
			state.lastIdentifierWasStandard = false;
			return "operator";
		}
		state.afterPropertyAccess = true;
		state.propertyAccessKind = char === "." ? "." : ":";
		return "punctuation";
	}
	if (char === "-" && stream.eat(">")) {
		enterTypeContext(state, 0, "return");
		state.afterFunctionName = false;
		state.afterTypeIdentifier = false;
		state.lastIdentifierWasStandard = false;
		return "operator";
	}
	if (
		char === "<" &&
		(state.afterTypeName || state.afterFunctionName || state.afterTypeIdentifier)
	) {
		if (state.afterFunctionName) state.functionGenericParams = true;
		enterTypeContext(state);
		state.genericDepth++;
		state.afterFunctionName = false;
		state.afterTypeIdentifier = false;
		state.lastIdentifierWasStandard = false;
		return "operator";
	}
	if ((char === "|" || char === "&" || char === "?") && (state.inType || char === "?")) {
		state.lastIdentifierWasStandard = false;
		return "operator";
	}
	if (
		char === "+" || char === "-" || char === "*" || char === "/" || char === "%" ||
		char === "^" || char === "#" || char === "=" || char === "<" || char === ">" ||
		char === "~" || char === "!"
	) {
		stream.eat("=");
		if (char === "=" && state.inType && state.typeDepth === 0 && !state.afterTypeName) {
			exitTypeContext(state);
		}
		if (char === "=" && state.forHeader) {
			state.forHeader = false;
			state.forHeaderExpectName = false;
		}
		if (char === ">" && state.genericDepth > 0) {
			state.genericDepth--;
			if (state.genericDepth === 0 && state.typeDepth === 0) state.inType = false;
			state.afterTypeIdentifier = true;
			state.lastIdentifierWasStandard = false;
			if (state.genericDepth === 0 && state.functionGenericParams) {
				state.functionGenericParams = false;
				state.afterFunctionName = true;
				state.afterTypeIdentifier = false;
			}
			return "operator";
		}
		if (char === "/" && stream.eat("/")) stream.eat("=");
		if (char === "=" && state.afterTypeName && state.genericDepth === 0) {
			state.afterTypeName = false;
			enterTypeContext(state, 0, "alias");
		}
		state.afterFunctionName = false;
		state.afterTypeIdentifier = false;
		state.lastIdentifierWasStandard = false;
		return "operator";
	}
	if (char === "(" || char === "{" || char === "[") {
		const startsFunctionParams = char === "(" && (state.expectFunctionName || state.afterFunctionName);
		if (startsFunctionParams) {
			state.inFunctionParams = true;
			state.functionParamsDepth = 1;
			state.expectFunctionName = false;
			state.afterFunctionName = false;
			state.lastIdentifierWasStandard = false;
		} else if (char === "(" && state.inFunctionParams) {
			state.functionParamsDepth++;
		}
		if (char === "(") state.expectTypeName = false;
		if (state.inType && char === "{") {
			state.typeTableDepths.push(state.typeDepth + 1);
			state.typeFieldExpected = true;
		}
		if (
			state.inType && char === "[" &&
			state.typeTableDepths[state.typeTableDepths.length - 1] === state.typeDepth
		) state.typeFieldExpected = false;
		if (state.inType) state.typeDepth++;
		if (char === "{") state.tableDepth++;
		state.lastIdentifierWasStandard = false;
		if (state.afterTypeName && char === "(") {
			state.afterTypeName = false;
			enterTypeContext(state, 1);
		}
		state.afterFunctionName = false;
		state.afterTypeIdentifier = false;
		return "punctuation";
	}
	if (char === ")" || char === "}" || char === "]") {
		if (char === ")" && state.inFunctionParams) {
			state.functionParamsDepth--;
			if (state.functionParamsDepth <= 0) {
				state.inFunctionParams = false;
				state.functionParamsDepth = 0;
			}
		}
		if (char === "}" && state.tableDepth > 0) state.tableDepth--;
		if (state.inType) {
			if (
				char === "}" &&
				state.typeTableDepths[state.typeTableDepths.length - 1] === state.typeDepth
			) {
				state.typeTableDepths.pop();
				state.typeFieldExpected = false;
			}
			if (state.typeDepth > 0) {
				state.typeDepth--;
				if (char === "}" && state.typeDepth === 0 && state.genericDepth === 0) exitTypeContext(state);
			} else if (char === ")" && /^\s*->/.test(stream.string.slice(stream.pos))) {
				enterTypeContext(state, 0, "return");
			} else {
				exitTypeContext(state);
			}
		}
		state.afterFunctionName = false;
		state.afterTypeIdentifier = false;
		state.lastIdentifierWasStandard = false;
		return "punctuation";
	}
	if (char === "," || char === ";") {
		if (state.forHeader && char === ",") state.forHeaderExpectName = true;
		if (char === ";") state.localDeclaration = false;
		if (
			state.inType &&
			state.typeDepth > 0 &&
			state.typeTableDepths[state.typeTableDepths.length - 1] === state.typeDepth
		) state.typeFieldExpected = true;
		if (state.inType && state.typeDepth === 0) exitTypeContext(state);
		state.afterFunctionName = false;
		state.afterTypeIdentifier = false;
		state.lastIdentifierWasStandard = false;
		return "punctuation";
	}
	state.afterFunctionName = false;
	state.afterTypeIdentifier = false;
	state.lastIdentifierWasStandard = false;
	return null;
};

const luauLanguage = StreamLanguage.define<LuauState>({
	name: "luau",
	startState() {
		return {
			basecol: 0,
			indentDepth: 0,
			cur: normal,
			stack: [],
			expectFunctionName: false,
			afterFunctionName: false,
			expectTypeName: false,
			afterTypeName: false,
			afterTypeIdentifier: false,
			inType: false,
			typeDepth: 0,
			genericDepth: 0,
			interpolationBraceDepth: 0,
			afterPropertyAccess: false,
			propertyAccessKind: null,
			typeAliasNames: new Set(),
			typeTableDepths: [],
			typeFieldExpected: false,
			typeContextKind: null,
			typeLineContinues: false,
			lastIdentifierWasStandard: false,
			inFunctionParams: false,
			functionParamsDepth: 0,
			functionGenericParams: false,
			docCommentExpectParamName: false,
			docCommentExpectType: false,
			forHeader: false,
			forHeaderExpectName: false,
			tableDepth: 0,
			localDeclaration: false,
		};
	},
	copyState(state) {
		return {
			...state,
			stack: state.stack.slice(),
			typeAliasNames: new Set(state.typeAliasNames),
			typeTableDepths: state.typeTableDepths.slice(),
		};
	},
	token(stream, state) {
		if (stream.sol()) {
			if (
				state.inType &&
				state.typeDepth === 0 &&
				!state.inFunctionParams &&
				!state.typeLineContinues &&
				state.typeContextKind
			) exitTypeContext(state);
			state.typeLineContinues = false;
			if (state.cur === docCommentLine) {
				popTokenizer(state);
				state.docCommentExpectParamName = false;
				state.docCommentExpectType = false;
			}
			if (state.indentDepth === 0) state.basecol = stream.indentation();
		}
		if (stream.eatSpace()) {
			if (stream.pos >= stream.string.length) {
				const end = stream.string.trimEnd();
				state.typeLineContinues = /(?:->|[|&<,=:?])$/.test(end);
			}
			return null;
		}
		const style = state.cur(stream, state);
		const word = stream.current();
		if (style !== "comment" && style !== "string") {
			if (indentTokens.has(word)) state.indentDepth++;
			if (dedentTokens.has(word)) state.indentDepth = Math.max(0, state.indentDepth - 1);
		}
		if (stream.pos >= stream.string.length) {
			const end = stream.string.trimEnd();
			state.typeLineContinues = /(?:->|[|&<,=:?])$/.test(end);
		}
		return style;
	},
	indent(state, textAfter, context: IndentContext) {
		const closing = dedentPartial.test(textAfter);
		const depth = Math.max(0, state.indentDepth - (closing ? 1 : 0));
		return state.basecol + context.unit * depth;
	},
	languageData: {
		commentTokens: {
			line: "--",
			block: { open: "--[[", close: "]]" },
		},
		closeBrackets: { brackets: ["(", "[", "{", '"', "'", "`"] },
		indentOnInput: /^\s*(?:end|until|else|elseif|\)|\})$/,
	},
});

export function luau() {
	return new LanguageSupport(luauLanguage, unmatchedBracketExtension);
}

export { luauLanguage };