import { SourceMap, type SourceMapPayload } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Present guest Worker frames using the same inline map as a Node dev runner. */
export function guestStackMapper(code: string, bundlePath: string): (stack: string) => string {
	const encoded = code.match(/\/\/# sourceMappingURL=data:application\/json(?:;charset=[^;,]+)?;base64,([^\s]+)/)?.[1];
	if (!encoded) return stack => stack;
	let map: SourceMap;
	try { map = new SourceMap(JSON.parse(Buffer.from(encoded, "base64").toString()) as SourceMapPayload); }
	catch { return stack => stack; }
	return stack => stack.replace(/(?:file:\/\/)?\/tmp\/bundle-[^/\s)]+\/worker:(\d+):(\d+)/g, (location, line, column) => {
		const entry = map.findEntry(Number(line) - 1, Number(column) - 1);
		if (!("originalSource" in entry) || typeof entry.originalSource !== "string") return location;
		const source = entry.originalSource.startsWith("file:") ? fileURLToPath(entry.originalSource) : resolve(dirname(bundlePath), entry.originalSource);
		return `${source}:${entry.originalLine + 1}:${entry.originalColumn + 1}`;
	});
}
