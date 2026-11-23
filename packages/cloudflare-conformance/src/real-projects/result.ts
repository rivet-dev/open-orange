import type { CorpusOrigin, ProjectChange } from "./corpus.js";
import type { StepKind, StepResult } from "./scenario.js";

/**
 * - `works`: every step passed, and at least one step exercised a Durable Object or a dynamic Worker.
 * - `partial`: it runs, and at least one step passed and one failed.
 * - `fails`: install, build, or boot failed, or no step passed.
 * - `needs-secrets`: nothing failed, but a flow needs a real credential that this run does not have.
 * - `not-run`: not exercised. `notRun` says why.
 */
export const realProjectStatuses = ["works", "partial", "fails", "needs-secrets", "not-run"] as const;
export type RealProjectStatus = (typeof realProjectStatuses)[number];

/** Step kinds that prove more than a boot: a Durable Object or a dynamic Worker ran. */
const provingStepKinds: readonly StepKind[] = ["do-state", "websocket", "alarm", "sleep", "restart", "worker-loader"];

/**
 * What `waitForSleep` accepts as asleep.
 * - `strict`: the Rivet actor stopped.
 * - `emulated`: also an object that Orange soft-hibernated. Orange dropped the object and kept its
 *   sockets open, and the Rivet actor still runs. This is not Cloudflare's hibernation.
 */
export type SleepGate = "strict" | "emulated";

export interface PhaseResult {
	ok: boolean;
	seconds: number;
	command?: string;
	/** The exact error of a failed phase. */
	error?: string;
}

/** One saved run of one project: `real-projects/<id>/result.json`. */
export interface RealProjectResult {
	schemaVersion: 1;
	id: string;
	repo: string;
	commit: string;
	stars: number;
	origin: CorpusOrigin;
	/** The Worker's directory in the repository. */
	directory: string;
	/** When the run started (UTC). */
	ranAt: string;
	orange: { sha: string; dirty: boolean | null };
	rivetkit: string;
	/** What ran the project. `workerd` is `wrangler dev`, the baseline for probes. */
	runtime: "orange" | "workerd";
	/** Set on a run under the emulated sleep gate: `real-projects/<id>/result.emulated.json`. */
	sleepGate?: "emulated";
	node: string;
	status: RealProjectStatus;
	install: PhaseResult | null;
	build: PhaseResult | null;
	boot: PhaseResult | null;
	steps: StepResult[];
	changes: ProjectChange[];
	/** Why it did not run. */
	notRun?: string;
	durableObjects: { classes: string[]; file: string; uses: string[] };
}

export function deriveStatus(
	phases: readonly (PhaseResult | null)[],
	steps: readonly StepResult[],
): RealProjectStatus {
	if (phases.some((phase) => phase?.ok === false)) return "fails";
	const passed = steps.filter((step) => step.status === "pass");
	const failed = steps.filter((step) => step.status === "fail");
	const needsSecrets = steps.filter((step) => step.status === "needs-secrets");
	if (failed.length > 0) return passed.length > 0 ? "partial" : "fails";
	if (needsSecrets.length > 0) return "needs-secrets";
	if (!passed.some((step) => provingStepKinds.includes(step.kind))) return "not-run";
	return "works";
}
