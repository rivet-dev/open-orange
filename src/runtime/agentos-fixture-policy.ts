import { constants, closeSync, fstatSync, openSync, readSync, readFileSync } from "node:fs";

// This is an explicit trusted-controller protocol. Nothing discovers listeners
// or grants ports on behalf of guest code.
export function fixturePolicyError(message: string): Error {
	return Object.assign(new Error(message), { code: "ERR_OPENORANGE_FIXTURE_POLICY" });
}

export function fixturePolicyLimit(name: string, fallback: number): number {
	const value = Number(process.env[name] ?? fallback);
	if (!Number.isSafeInteger(value) || value < 1) throw fixturePolicyError(`${name} must be a positive safe integer`);
	return value;
}

export function processIdentity(pid: number): string | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		return fields[0] === "Z" ? undefined : fields[19];
	} catch (error) {
		if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
		throw error;
	}
}

export function readFixturePolicy(path: string, controllerPid: number): { revision: number; ports: number[] } {
	const maxBytes = fixturePolicyLimit("OPENORANGE_COMPARISON_MAX_POLICY_BYTES", 1024 * 1024);
	const maxPorts = fixturePolicyLimit("OPENORANGE_AGENTOS_MAX_HOST_LOOPBACK_PORTS", 128);
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.uid !== process.getuid?.()) throw fixturePolicyError("Fixture policy must be an owned regular file");
		if (stat.size > maxBytes) throw fixturePolicyError(`Fixture policy exceeds ${maxBytes} bytes; raise OPENORANGE_COMPARISON_MAX_POLICY_BYTES`);
		const bytes = Buffer.alloc(stat.size);
		let read = 0;
		while (read < bytes.length) {
			const count = readSync(fd, bytes, read, bytes.length - read, read);
			if (!count) throw fixturePolicyError("Fixture policy was truncated while reading");
			read += count;
		}
		const end = bytes.lastIndexOf(10) + 1;
		const listeners = new Map<string, number>();
		for (const line of bytes.subarray(0, end).toString("utf8").split("\n")) {
			if (!line) continue;
			const record = JSON.parse(line);
			if (record.controllerPid !== controllerPid || typeof record.id !== "string" || record.id.length > 128 || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535) throw fixturePolicyError("Invalid explicit fixture policy record");
			if (record.kind === "fixture-listener-granted") listeners.set(record.id, record.port);
			else if (record.kind === "fixture-listener-retired") listeners.delete(record.id);
			else throw fixturePolicyError("Unknown fixture policy operation");
			if (listeners.size > maxPorts) throw fixturePolicyError(`Fixture listeners exceed ${maxPorts}; raise OPENORANGE_AGENTOS_MAX_HOST_LOOPBACK_PORTS`);
		}
		return { revision: end, ports: [...new Set(listeners.values())] };
	} finally { closeSync(fd); }
}
