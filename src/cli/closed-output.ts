// A reader such as `head` or `jq` can close the pipe before the output ends. The rest of the output
// then has nowhere to go: Orange drops it, and a command that runs until it is stopped, such as
// `orange dev`, stops as for Ctrl-C. A short command finishes and exits with its usual code.
// A closed terminal is the same case: a write to it fails with EIO instead of EPIPE.

const closedStreams = new WeakSet<NodeJS.WriteStream>();
const listeners = new Set<() => void>();
let closed = false;

function markClosed(): void {
	if (closed) return;
	closed = true;
	for (const listener of listeners) listener();
}

/** Drops the output of `stream` after its reader closes the pipe or terminal, instead of crashing on EPIPE or EIO. */
export function dropOutputAfterReaderCloses(stream: NodeJS.WriteStream): void {
	stream.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code !== "EPIPE" && error.code !== "EIO") throw error;
		if (closedStreams.has(stream)) return;
		closedStreams.add(stream);
		stream.write = (...args: unknown[]): boolean => {
			const callback = args.find((arg) => typeof arg === "function");
			if (typeof callback === "function") queueMicrotask(() => callback());
			return true;
		};
		markClosed();
	});
}

/** Calls `listener` once the reader of the output is gone, at once if it already is. */
export function onOutputClosed(listener: () => void): () => void {
	if (closed) {
		listener();
		return () => undefined;
	}
	listeners.add(listener);
	return () => listeners.delete(listener);
}
