export type RuntimeKind = "node" | "agentos";

export function runtimeKind(value = process.env.OPENORANGE_RUNTIME ?? "node"): RuntimeKind {
	if (value === "node" || value === "agentos") return value;
	throw new Error(`--runtime must be node or agentos; received ${value}`);
}
