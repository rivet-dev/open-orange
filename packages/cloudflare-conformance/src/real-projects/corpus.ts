import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** How a project entered the corpus. */
export const corpusOrigins = ["official", "named", "awesome-list", "search", "probe"] as const;
export type CorpusOrigin = (typeof corpusOrigins)[number];

export const changeKinds = ["config", "code"] as const;

/**
 * One change the project needed to run. All changes of a project are in its `changes.patch`.
 * `config` adds or edits a Wrangler config. `code` touches anything else.
 */
export interface ProjectChange {
	kind: (typeof changeKinds)[number];
	what: string;
	why: string;
}

/** Who a failed step belongs to, after looking at it. It never changes a project's status. */
export const failureOwners = [
	"orange",
	"rivetkit",
	"hibernation-not-available",
	"project",
	"environment",
	"unknown",
] as const;

export interface KnownFailure {
	/** The step name in the scenario. */
	step: string;
	owner: (typeof failureOwners)[number];
	/** The cause, in one sentence. */
	note: string;
	/** A repro path or an issue URL, when there is one. */
	reference?: string;
}

export interface CorpusProject {
	/** Stable id. Also the scenario and result file name. */
	id: string;
	/** GitHub `owner/name`. */
	repo: string;
	/** Full commit SHA the run checks out. */
	commit: string;
	stars: number;
	origin: CorpusOrigin;
	/** The Worker's directory in the repository. */
	directory: string;
	/** Wrangler config paths, relative to `directory`. The first one serves the port. */
	configs: string[];
	/** The Wrangler environment that the project's own dev command selects with `--env`. */
	env?: string;
	/** Where the install runs, relative to the repository root. */
	installDirectory: string;
	/** Must keep install scripts off. See `installCommandProblem`. */
	install: string;
	/** The project's own build commands, run in `directory`. */
	build?: string[];
	/** D1 bindings to migrate with `orange d1 migrations apply` before the first boot. */
	d1Migrations?: string[];
	/** Local-only values for `.dev.vars`, as the project's README asks. Never a real credential. */
	devVars?: Record<string, string>;
	/**
	 * What the code shows about Durable Object use. A Worker Loader project with no Durable Object has
	 * empty `classes`, `file` is where it calls the loader, and `uses` names `worker_loaders`.
	 */
	durableObjects: {
		classes: string[];
		/** Source file with the class, relative to the repository root. */
		file: string;
		/** Storage or coordination APIs the class calls. */
		uses: string[];
	};
	/** Changes needed to run it. Empty means unmodified. */
	changes: ProjectChange[];
	/** What is known about failed steps. */
	knownFailures?: KnownFailure[];
	/** Set when the project cannot be run at all, with the reason. No scenario is needed then. */
	notRun?: string;
	/** A probe: its `worker/` directory is the project, with nothing to clone. It installs only when `install` is set. */
	local?: true;
	/** A probe that also runs on `wrangler dev`, so its steps state what workerd really does. */
	baseline?: true;
}

/** Project install scripts must never run. Each supported package manager needs its flag. */
export function installCommandProblem(command: string): string | undefined {
	if (!/(^|\s)--ignore-scripts(\s|$)/.test(command)) {
		return `install must pass --ignore-scripts: ${command}`;
	}
	return /[;&|`$]/.test(command)
		? `install must be one plain command: ${command}`
		: undefined;
}

function projectProblems(project: CorpusProject, directoryName: string): string[] {
	const problems: string[] = [];
	const where = directoryName;
	if (project.id !== directoryName) problems.push(`${where}: id must equal the directory name`);
	if (!/^[a-z0-9][a-z0-9-]*$/.test(project.id)) problems.push(`${where}: id must be kebab-case`);
	if (project.local !== true && !/^[0-9a-f]{40}$/.test(project.commit)) {
		problems.push(`${where}: commit must be a full SHA`);
	}
	if (!(corpusOrigins as readonly string[]).includes(project.origin)) {
		problems.push(`${where}: unknown origin ${project.origin}`);
	}
	const install = project.local === true && project.install === "" ? undefined : installCommandProblem(project.install);
	if (install !== undefined) problems.push(`${where}: ${install}`);
	if (project.configs.length === 0) problems.push(`${where}: configs is empty`);
	const { classes, uses } = project.durableObjects;
	if (uses.length === 0 || (classes.length === 0 && !uses.includes("worker_loaders"))) {
		problems.push(`${where}: durableObjects must name its classes and their APIs, or use worker_loaders`);
	}
	return problems;
}

/** Reads each `real-projects/<id>/project.json` whose id matches, most visible first. */
export async function readCorpus(directory: string, filter?: RegExp): Promise<CorpusProject[]> {
	const projects: CorpusProject[] = [];
	const problems: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (!entry.isDirectory() || filter?.test(entry.name) === false) continue;
		const path = join(directory, entry.name, "project.json");
		const project = JSON.parse(await readFile(path, "utf8")) as CorpusProject;
		problems.push(...projectProblems(project, entry.name));
		projects.push(project);
	}
	if (problems.length > 0) throw new Error(`${directory} is invalid:\n  ${problems.join("\n  ")}`);
	return projects.sort((a, b) => b.stars - a.stars || a.id.localeCompare(b.id));
}
