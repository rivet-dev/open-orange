export interface SandboxVmCommand {
	operation:
		| "create"
		| "connect"
		| "destroy"
		| "exec-start"
		| "exec-read"
		| "exec-cancel"
		| "read-start"
		| "read-chunk"
		| "read-close"
		| "write-start"
		| "write-chunk"
		| "write-finish"
		| "write-close"
		| "mkdir"
		| "exists"
		| "remove"
		| "move"
		| "stat"
		| "list"
		| "preview";
	owner: string;
	id?: string;
	job?: string;
	path?: string;
	to?: string;
	data?: string;
	offset?: number;
	size?: number;
	recursive?: boolean;
	follow?: boolean;
	command?: string;
	cwd?: string;
	env?: Record<string, string>;
	timeoutMs?: number;
	port?: number;
}
export interface SandboxFileInfo {
	type: "file" | "directory" | "symlink";
	size: number;
	mode: number;
	uid: number;
	gid: number;
	atimeMs: number;
	mtimeMs: number;
	ctimeMs: number;
}
export interface SandboxVmReply {
	pending?: boolean;
	id?: string;
	exists?: boolean;
	job?: string;
	size?: number;
	data?: string;
	stream?: "stdout" | "stderr";
	exitCode?: number;
	error?: { code: string; message: string };
	info?: SandboxFileInfo;
	entries?: { name: string; isDirectory: boolean; size: number; modifiedAt: string }[];
	preview?: { origin: string; token: string; id: string; port: number };
}
export interface SandboxVmBridge {
	sandboxVmCommand(input: SandboxVmCommand): Promise<SandboxVmReply>;
}
