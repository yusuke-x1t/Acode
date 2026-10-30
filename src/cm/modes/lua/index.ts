import {
	IndentContext,
	LanguageSupport,
	StreamLanguage,
	StringStream,
} from "@codemirror/language";
import { unmatchedBracketExtension } from "../unmatchedBrackets";

type Tokenizer = (stream: StringStream, state: LuaState) => string | null;
type DocExpectation =
	| "none"
	| "paramName"
	| "paramType"
	| "fieldName"
	| "fieldType"
	| "castVariable"
	| "castType"
	| "type"
	| "class"
	| "generic"
	| "alias";

interface LuaState {
	basecol: number;
	indentDepth: number;
	cur: Tokenizer;
	stack: Tokenizer[];
	expectFunctionName: boolean;
	afterFunctionName: boolean;
	expectLabel: boolean;
	afterPropertyAccess: boolean;
	propertyAccessKind: "." | ":" | null;
	lastStandardNamespace: string | null;
	inFunctionParams: boolean;
	functionParamsDepth: number;
	forHeader: boolean;
	forHeaderExpectName: boolean;
	tableDepth: number;
	localDeclaration: boolean;
	docLine: boolean;
	docExpectation: DocExpectation;
}

const controlKeywords = new Set([
	"break", "do", "else", "elseif", "end", "for", "function", "goto",
	"if", "in", "repeat", "return", "then", "until", "while",
]);

const logicalKeywords = new Set(["and", "not", "or"]);
const modifierKeywords = new Set(["const", "local"]);

const standardFunctions = new Set([
	"assert", "collectgarbage", "dofile", "error", "getfenv", "getmetatable", "ipairs",
	"load", "loadfile", "loadstring", "module", "next", "pairs", "pcall", "print",
	"rawequal", "rawget", "rawlen", "rawset", "require", "select", "setfenv", "setmetatable",
	"tonumber", "tostring", "type", "unpack", "warn", "xpcall",
]);

const standardNamespaces = new Set([
	"bit32", "coroutine", "debug", "io", "math", "os", "package", "string",
	"table", "utf8",
]);

const standardLibraryFunctions: Record<string, Set<string>> = {
	bit32: new Set([
		"arshift", "band", "bnot", "bor", "btest", "bxor", "extract", "replace",
		"lrotate", "lshift", "rrotate", "rshift",
	]),
	coroutine: new Set([
		"close", "create", "isyieldable", "resume", "running", "status", "wrap", "yield",
	]),
	debug: new Set([
		"debug", "getfenv", "gethook", "getinfo", "getlocal", "getmetatable",
		"getregistry", "getupvalue", "getuservalue", "setfenv", "sethook", "setlocal",
		"setmetatable", "setupvalue", "setuservalue", "setstacklimit", "traceback",
		"upvalueid", "upvaluejoin",
	]),
	io: new Set([
		"close", "flush", "input", "lines", "open", "output", "popen", "read",
		"tmpfile", "type", "write",
	]),
	math: new Set([
		"abs", "acos", "asin", "atan", "atan2", "ceil", "cos", "cosh", "deg", "exp",
		"floor", "fmod", "frexp", "ldexp", "log", "log10", "max", "min", "modf",
		"pow", "rad", "random", "randomseed", "sin", "sinh", "sqrt", "tan", "tanh",
		"tointeger", "type", "ult",
	]),
	os: new Set([
		"clock", "date", "difftime", "execute", "exit", "getenv", "remove", "rename",
		"setlocale", "time", "tmpname",
	]),
	package: new Set(["loadlib", "searchpath", "seeall"]),
	string: new Set([
		"byte", "char", "dump", "find", "format", "gmatch", "gsub", "len", "lower",
		"match", "pack", "packsize", "rep", "reverse", "sub", "unpack", "upper",
	]),
	table: new Set([
		"concat", "create", "insert", "maxn", "move", "pack", "remove", "sort", "unpack",
	]),
	utf8: new Set(["char", "codes", "codepoint", "len", "offset"]),
};

const standardVariables = new Set(["_G", "_VERSION", "_ENV"]);

const standardConstantMembers: Record<string, Set<string>> = {
	math: new Set(["pi", "huge", "maxinteger", "mininteger"]),
	utf8: new Set(["charpattern"]),
	io: new Set(["stdin", "stdout", "stderr"]),
	package: new Set([
		"config", "cpath", "loaded", "loaders", "path", "preload", "searchers",
	]),
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

const constantLanguage = new Set(["_ENV", "_G", "_VERSION", "..."]);

const annotationTags = new Set([
	"@alias", "@as", "@async", "@cast", "@class", "@diagnostic", "@deprecated",
	"@enum", "@field", "@generic", "@meta", "@module", "@nodiscard", "@operator",
	"@overload", "@package", "@param", "@return", "@see", "@source", "@type",
	"@using", "@vararg", "@version",
]);

const parameterAnnotations = new Set(["@param"]);
const fieldAnnotations = new Set(["@field"]);
const castAnnotations = new Set(["@cast"]);
const typeAnnotations = new Set([
	"@type", "@return", "@class", "@alias", "@enum", "@overload", "@generic",
]);
const docModifiers = new Set(["private", "protected", "public", "package"]);
const indentTokens = new Set(["do", "function", "if", "repeat", "(", "{"]);
const dedentTokens = new Set(["end", "until", ")", "}"]);
const dedentPartial = /^(?:end|until|else|elseif)\b|^[)}]/;

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
		controlKeywords.has(word) || logicalKeywords.has(word) ||
		modifierKeywords.has(word) || word === "true" || word === "false" || word === "nil"
	);
}

function isCallbackAssignment(stream: StringStream) {
	return /^\s*=\s*[A-Za-z_][A-Za-z0-9_]*(?:\s*[.:]\s*[A-Za-z_][A-Za-z0-9_]*)*\s*\(\s*function\s*\(/.test(
		stream.string.slice(stream.pos),
	);
}

function isFunctionValueAssignment(stream: StringStream) {
	return /^\s*=\s*function\b/.test(stream.string.slice(stream.pos));
}

function isCallArgumentsText(text: string) {
	return /^\s*(?:\(|\{|["']|\[(?:=*)\[)/.test(text);
}

function isCallArguments(stream: StringStream) {
	return isCallArgumentsText(stream.string.slice(stream.pos));
}

function looksLikeMethodReceiver(stream: StringStream) {
	const rest = stream.string.slice(stream.pos);
	const separator = /^\s*:(?!:)(?:\s*([A-Za-z_][A-Za-z0-9_]*))?/.exec(rest);
	if (!separator) return false;
	return !!separator[1] || rest.trim() === ":";
}

function pushTokenizer(state: LuaState, tokenizer: Tokenizer) {
	state.stack.push(state.cur);
	state.cur = tokenizer;
}

function popTokenizer(state: LuaState) {
	state.cur = state.stack.pop() || normal;
}

function readLongBracket(stream: StringStream) {
	let level = 0;
	while (stream.eat("=")) level++;
	return stream.eat("[") ? level : -1;
}

function bracketed(level: number, style: string): Tokenizer {
	return (stream, state) => {
		let equalsSeen: number | null = null;
		while (true) {
			const char = stream.next();
			if (char == null) break;
			if (equalsSeen == null) {
				if (char === "]") equalsSeen = 0;
			} else if (char === "=") {
				equalsSeen++;
			} else if (char === "]" && equalsSeen === level) {
				popTokenizer(state);
				break;
			} else {
				equalsSeen = null;
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


function readNumber(stream: StringStream, firstChar: string) {
	if (firstChar === "0" && /[xX]/.test(stream.peek() || "")) {
		stream.next();
		stream.eatWhile(/[\da-fA-F_]/);
		if (stream.peek() === "." && stream.string.charAt(stream.pos + 1) !== ".") {
			stream.next();
			stream.eatWhile(/[\da-fA-F_]/);
		}
		if (/[pP]/.test(stream.peek() || "")) {
			stream.next();
			stream.eat(/[+-]/);
			stream.eatWhile(/[\d_]/);
		}
		return;
	}
	stream.eatWhile(/[\d_]/);
	if (stream.peek() === "." && stream.string.charAt(stream.pos + 1) !== ".") {
		stream.next();
		stream.eatWhile(/[\d_]/);
	}
	if (/[eE]/.test(stream.peek() || "")) {
		stream.next();
		stream.eat(/[+-]/);
		stream.eatWhile(/[\d_]/);
	}
}

function resetDocState(state: LuaState) {
	state.docLine = false;
	state.docExpectation = "none";
}

function tokenDocComment(stream: StringStream, state: LuaState) {
	if (stream.eatSpace()) return null;
	if (stream.match("---")) return "comment";
	if (stream.match(/@[A-Za-z_][A-Za-z0-9_]*/)) {
		const tag = stream.current();
		if (!annotationTags.has(tag)) {
			state.docExpectation = "none";
			return "comment";
		}
		if (parameterAnnotations.has(tag)) {
			state.docExpectation = "paramName";
			return "annotation";
		}
		if (fieldAnnotations.has(tag)) {
			state.docExpectation = "fieldName";
			return "annotation";
		}
		if (castAnnotations.has(tag)) {
			state.docExpectation = "castVariable";
			return "annotation";
		}
		if (tag === "@class") {
			state.docExpectation = "class";
			return "annotation";
		}
		if (tag === "@alias") {
			state.docExpectation = "alias";
			return "annotation";
		}
		if (tag === "@generic") {
			state.docExpectation = "generic";
			return "annotation";
		}
		if (typeAnnotations.has(tag)) {
			state.docExpectation = "type";
			return "annotation";
		}
		state.docExpectation = "none";
		return "annotation";
	}

	const peek = stream.peek() || "";
	if (state.docExpectation === "paramName" && isWordStart(peek)) {
		stream.next();
		stream.eatWhile(isWord);
		state.docExpectation = "paramType";
		return "variableName";
	}
	if (state.docExpectation === "paramName" && peek === "." && stream.match("...")) {
		state.docExpectation = "paramType";
		return "variableName";
	}
	if (state.docExpectation === "fieldName" && isWordStart(peek)) {
		stream.next();
		stream.eatWhile(isWord);
		const word = stream.current();
		if (docModifiers.has(word)) return "modifier";
		state.docExpectation = "fieldType";
		return "propertyName";
	}
	if (state.docExpectation === "castVariable" && isWordStart(peek)) {
		stream.next();
		stream.eatWhile(isWord);
		state.docExpectation = "castType";
		return "variableName";
	}
	if (
		["paramType", "fieldType", "castType", "type", "class", "generic", "alias"].includes(state.docExpectation) &&
		(peek === "?" || peek === "{" || peek === "(" || peek === "[" || peek === "`" ||
			peek === "'" || peek === '"' || peek === "|" || peek === "." || isWordStart(peek))
	) {
		stream.next();
		stream.eatWhile((char) => !/\s/.test(char));
		state.docExpectation = "none";
		return "typeName";
	}
	stream.skipToEnd();
	state.docExpectation = "none";
	return "comment";
}

function classifyIdentifier(word: string, state: LuaState, stream: StringStream) {
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
		state.inFunctionParams &&
		(controlKeywords.has(word) || modifierKeywords.has(word) || logicalKeywords.has(word))
	) {
		state.inFunctionParams = false;
		state.functionParamsDepth = 0;
	}

	if (state.expectLabel) {
		state.expectLabel = false;
		if (!isReservedIdentifier(word)) {
			state.afterFunctionName = false;
			state.afterPropertyAccess = false;
			state.lastStandardNamespace = null;
			return "labelName";
		}
	}

	if (!state.afterPropertyAccess && state.localDeclaration && word !== "self" &&
		!/^\s*,/.test(stream.string.slice(stream.pos))) state.localDeclaration = false;

	if (!state.afterPropertyAccess && (word === "_ENV" || word === "_G")) {
		state.afterFunctionName = false;
		state.lastStandardNamespace = null;
		return "modifier";
	}
	if (!state.afterPropertyAccess && word === "self") {
		const isAssignment = /^\s*=(?!=)/.test(stream.string.slice(stream.pos));
		const isLocal = state.localDeclaration;
		state.localDeclaration = false;
		state.afterFunctionName = false;
		state.lastStandardNamespace = null;
		return isLocal || isAssignment ? "variableName" : "modifier";
	}

	if (state.expectFunctionName) {
		const rest = stream.string.slice(stream.pos);
		const isQualifiedFunctionName = /^\s*[.:]\s*[A-Za-z_]/.test(rest);
		const isMethodDefinition = /^\s*:\s*[A-Za-z_]/.test(rest);
		state.expectFunctionName = false;
		state.afterFunctionName = true;
		state.afterPropertyAccess = false;
		state.lastStandardNamespace = null;
		if (isMethodDefinition) return "className";
		return isQualifiedFunctionName ? "variableName" : "variableName.function.definition";
	}

	if (state.afterPropertyAccess && isReservedIdentifier(word)) {
		state.afterPropertyAccess = false;
		state.propertyAccessKind = null;
		state.lastStandardNamespace = null;
	}
	if (state.afterPropertyAccess) {
		const standardParent = state.lastStandardNamespace;
		const accessKind = state.propertyAccessKind;
		const isFunctionDefinition = state.afterFunctionName;
		const isCall = isCallArguments(stream);
		const isMethodReceiver = looksLikeMethodReceiver(stream);
		state.afterPropertyAccess = false;
		state.propertyAccessKind = null;
		state.lastStandardNamespace = null;
		state.afterFunctionName = isFunctionDefinition;
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
		if (isFunctionDefinition && isCall) return "propertyName.function.definition";
		if (isCall) {
			state.afterFunctionName = false;
			return "propertyName.function";
		}
		return accessKind === ":" ? "className" : "propertyName";
	}

	if (state.forHeader && word === "in") {
		state.forHeader = false;
		state.forHeaderExpectName = false;
		state.afterFunctionName = false;
		state.lastStandardNamespace = null;
		return "controlKeyword";
	}
	if (state.forHeader && !controlKeywords.has(word) && !modifierKeywords.has(word) && !logicalKeywords.has(word)) {
		if (!state.forHeaderExpectName) {
			state.forHeader = false;
		} else {
			state.forHeaderExpectName = false;
			state.afterFunctionName = false;
			state.lastStandardNamespace = null;
			return "variableName.special";
		}
	}

	if (looksLikeMethodReceiver(stream)) {
		state.afterFunctionName = false;
		state.lastStandardNamespace = null;
		return "className";
	}
	if (isFunctionValueAssignment(stream)) {
		state.afterFunctionName = false;
		state.lastStandardNamespace = null;
		return "variableName.function.definition";
	}
	if (state.tableDepth > 0 && /^\s*=/.test(stream.string.slice(stream.pos))) {
		state.afterFunctionName = false;
		state.lastStandardNamespace = null;
		return "variableName";
	}
	if (isCallbackAssignment(stream)) {
		state.afterFunctionName = false;
		state.lastStandardNamespace = null;
		return "variableName.special";
	}
	if (state.inFunctionParams) {
		state.afterFunctionName = false;
		state.lastStandardNamespace = null;
		return "variableName.special";
	}

	if (logicalKeywords.has(word) || modifierKeywords.has(word)) {
		if (word === "local") state.localDeclaration = true;
		state.afterFunctionName = false;
		state.lastStandardNamespace = null;
		return "modifier";
	}
	if (word === "function") {
		state.expectFunctionName = true;
		state.afterFunctionName = false;
		state.lastStandardNamespace = null;
		return "controlKeyword";
	}
	if (word === "goto") {
		state.expectLabel = true;
		state.afterFunctionName = false;
		state.lastStandardNamespace = null;
		return "controlKeyword";
	}
	if (word === "true" || word === "false") {
		state.afterFunctionName = false;
		state.lastStandardNamespace = null;
		return "bool";
	}
	if (word === "nil") {
		state.afterFunctionName = false;
		state.lastStandardNamespace = null;
		return "null";
	}
	if (controlKeywords.has(word)) {
		if (word === "for") {
			state.forHeader = true;
			state.forHeaderExpectName = true;
		}
		if (word === "do" || word === "in") {
			state.forHeader = false;
			state.forHeaderExpectName = false;
		}
		state.afterFunctionName = false;
		state.lastStandardNamespace = null;
		return "controlKeyword";
	}
	if (constantLanguage.has(word)) {
		state.afterFunctionName = false;
		state.lastStandardNamespace = null;
		return "constant.language";
	}
	if (standardNamespaces.has(word)) {
		state.afterFunctionName = false;
		state.lastStandardNamespace = word;
		return hasCompleteStandardLibraryMember(word, stream)
			? "namespace.standard"
			: "variableName";
	}
	if (standardVariables.has(word)) {
		state.afterFunctionName = false;
		state.lastStandardNamespace = null;
		return "constant.language";
	}
	if (standardFunctions.has(word)) {
		state.afterFunctionName = false;
		state.lastStandardNamespace = null;
		return "variableName.function";
	}
	if (isCallArguments(stream)) {
		state.afterFunctionName = false;
		state.lastStandardNamespace = null;
		return "variableName.function";
	}
	if (isUpperConstant(word) && state.tableDepth === 0) {
		state.afterFunctionName = false;
		state.lastStandardNamespace = null;
		return "variableName.constant";
	}
	state.afterFunctionName = false;
	state.lastStandardNamespace = null;
	return "variableName";
}

const normal: Tokenizer = (stream, state) => {
	const char = stream.next();
	if (!char) return null;
	if (state.afterPropertyAccess && !isWordStart(char)) {
		state.afterPropertyAccess = false;
		state.propertyAccessKind = null;
		state.lastStandardNamespace = null;
	}
	if (char === "-" && stream.eat("-")) {
		if (stream.eat("[")) {
			const level = readLongBracket(stream);
			if (level >= 0) {
				pushTokenizer(state, bracketed(level, "comment"));
				return state.cur(stream, state);
			}
		}
		stream.skipToEnd();
		return "comment";
	}
	if (state.forHeader && char !== "," && char !== "=" && !isWordStart(char)) {
		state.forHeader = false;
		state.forHeaderExpectName = false;
	}
	if (char === "'" || char === '"') {
		pushTokenizer(state, quotedString(char));
		return state.cur(stream, state);
	}
	if (char === "[") {
		const level = readLongBracket(stream);
		if (level >= 0) {
			pushTokenizer(state, bracketed(level, "string"));
			return state.cur(stream, state);
		}
		stream.backUp(stream.pos - stream.start);
		stream.next();
		state.afterPropertyAccess = false;
		state.afterFunctionName = false;
		state.lastStandardNamespace = null;
		return "punctuation";
	}
	if (/[\d]/.test(char) || (char === "." && /\d/.test(stream.peek() || ""))) {
		readNumber(stream, char);
		state.afterPropertyAccess = false;
		state.lastStandardNamespace = null;
		state.afterFunctionName = false;
		return "number";
	}
	if (isWordStart(char)) {
		stream.eatWhile(isWord);
		return classifyIdentifier(stream.current(), state, stream);
	}
	if (char === ".") {
		if (stream.eat(".")) {
			if (stream.eat(".")) {
				state.afterPropertyAccess = false;
				state.afterFunctionName = false;
				state.lastStandardNamespace = null;
				return "operator";
			}
			stream.eat("=");
			state.afterPropertyAccess = false;
			state.afterFunctionName = false;
			state.lastStandardNamespace = null;
			return "operator";
		}
		state.afterPropertyAccess = true;
		state.propertyAccessKind = ".";
		return "operator";
	}
	if (char === ":") {
		if (stream.eat(":")) {
			state.expectLabel = false;
			state.afterPropertyAccess = false;
			state.propertyAccessKind = null;
			state.afterFunctionName = false;
			state.lastStandardNamespace = null;
			return "punctuation";
		}
		state.afterPropertyAccess = true;
		state.propertyAccessKind = ":";
		state.lastStandardNamespace = null;
		return "operator";
	}
	if (
		char === "+" || char === "-" || char === "*" || char === "/" || char === "%" ||
		char === "^" || char === "#" || char === "=" || char === "<" || char === ">" || char === "~"
	) {
		if (char === "-" && stream.eat(">")) {
			state.afterPropertyAccess = false;
			state.afterFunctionName = false;
			state.lastStandardNamespace = null;
			return "operator";
		}
		stream.eat("=");
		if (char === "/" && stream.eat("/")) stream.eat("=");
		if (char === "=" && state.forHeader) {
			state.forHeader = false;
			state.forHeaderExpectName = false;
		}
		state.afterPropertyAccess = false;
		state.afterFunctionName = false;
		state.lastStandardNamespace = null;
		return "operator";
	}
	if (char === "(" || char === "{" || char === "[") {
		const startsFunctionParams = char === "(" && (state.expectFunctionName || state.afterFunctionName);
		if (startsFunctionParams) {
			state.expectFunctionName = false;
			state.afterFunctionName = false;
			state.inFunctionParams = true;
			state.functionParamsDepth = 1;
		} else if (char === "(" && state.inFunctionParams) {
			state.functionParamsDepth++;
		}
		if (char === "{") state.tableDepth++;
		state.afterPropertyAccess = false;
		state.lastStandardNamespace = null;
		state.afterFunctionName = false;
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
		state.afterPropertyAccess = false;
		state.afterFunctionName = false;
		state.lastStandardNamespace = null;
		return "punctuation";
	}
	if (char === "," || char === ";") {
		if (state.forHeader && char === ",") state.forHeaderExpectName = true;
		if (char === ";") state.localDeclaration = false;
		state.afterPropertyAccess = false;
		state.afterFunctionName = false;
		state.lastStandardNamespace = null;
		return "punctuation";
	}
	state.afterPropertyAccess = false;
	state.afterFunctionName = false;
	state.lastStandardNamespace = null;
	return null;
};

const luaLanguage = StreamLanguage.define<LuaState>({
	name: "lua",
	startState() {
		return {
			basecol: 0,
			indentDepth: 0,
			cur: normal,
			stack: [],
			expectFunctionName: false,
			afterFunctionName: false,
			expectLabel: false,
			afterPropertyAccess: false,
			propertyAccessKind: null,
			lastStandardNamespace: null,
			inFunctionParams: false,
			functionParamsDepth: 0,
			forHeader: false,
			forHeaderExpectName: false,
			tableDepth: 0,
			localDeclaration: false,
			docLine: false,
			docExpectation: "none",
		};
	},
	copyState(state) {
		return { ...state, stack: state.stack.slice() };
	},
	token(stream, state) {
		if (stream.sol() && state.cur === normal) {
			resetDocState(state);
			if (/^\s*---/.test(stream.string.slice(stream.pos))) state.docLine = true;
			if (state.indentDepth === 0) state.basecol = stream.indentation();
		}
		if (state.cur === normal && state.docLine) {
			if (stream.eatSpace()) return null;
			return tokenDocComment(stream, state);
		}
		if (state.cur === normal && stream.eatSpace()) return null;
		const style = state.cur(stream, state);
		const token = stream.current();
		if (style !== "comment" && style !== "string") {
			if (indentTokens.has(token)) state.indentDepth++;
			if (dedentTokens.has(token)) state.indentDepth = Math.max(0, state.indentDepth - 1);
		}
		if (style === "comment" || style === "string" || style === "number") {
			state.afterPropertyAccess = false;
			state.afterFunctionName = false;
			state.lastStandardNamespace = null;
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
		closeBrackets: { brackets: ["(", "[", "{", '"', "'"] },
		indentOnInput: /^\s*(?:end|until|else|elseif|\)|\})$/,
	},
});

export function lua() {
	return new LanguageSupport(luaLanguage, unmatchedBracketExtension);
}

export { luaLanguage };