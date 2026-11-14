import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixturePolicyError, processIdentity, readFixturePolicy } from "./agentos-fixture-policy.js";

/** Install only grants explicitly published by this comparison's controller.
 * Acknowledgements are written after the native sidecar accepts replacement.
 */
export async function watchAgentOsFixturePolicy(
	apply: (ports: number[]) => Promise<void>,
	onError: (error: Error) => void,
): Promise<(() => Promise<void>) | undefined> {
	const path = process.env.OPENORANGE_AGENTOS_HOST_LOOPBACK_POLICY_FILE;
	if (!path) return;
	const controllerPid = Number(process.env.OPENORANGE_AGENTOS_POLICY_CONTROLLER_PID);
	if (!Number.isSafeInteger(controllerPid) || controllerPid < 1) throw fixturePolicyError("Fixture policy requires its explicit controller PID");
	const directory = `${path}.acks`;
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const ack = join(directory, `${process.pid}-${randomUUID()}.json`);
	const temporary = `${ack}.tmp`;
	const identity = processIdentity(process.pid);
	let revision = -1, stopped = false, changed = true;
	let pending: Promise<void> | undefined;
	const acknowledge = (ready: boolean) => {
		writeFileSync(temporary, JSON.stringify({ pid: process.pid, identity, controllerPid, ready, revision }), { mode: 0o600 });
		renameSync(temporary, ack);
	};
	const update = async () => {
		while (changed && !stopped) {
			changed = false;
			const policy = readFixturePolicy(path, controllerPid);
			if (policy.revision !== revision) {
				await apply(policy.ports);
				revision = policy.revision;
			}
			acknowledge(true);
		}
	};
	const schedule = () => {
		changed = true;
		if (pending || stopped) return;
		pending = update().catch(error => {
			stopped = true;
			onError(error instanceof Error ? error : new Error(String(error)));
		}).finally(() => { pending = undefined; if (changed && !stopped) schedule(); });
	};
	acknowledge(false);
	const watcher = watch(path, schedule);
	watcher.on("error", error => { stopped = true; onError(error); });
	try { pending = update(); await pending; pending = undefined; if (changed) schedule(); } catch (error) {
		watcher.close(); unlinkSync(ack); throw error;
	}
	return async () => {
		stopped = true;
		watcher.close();
		await pending;
		unlinkSync(ack);
	};
}
