// `orange deploy` images install Orange's runtime dependencies from this
// lockfile, so the image gets exactly the tree that this package was built and
// tested with, and the install resolves nothing. Without it, `npm install` of
// the packed package resolves the whole tree from the registry on every build.
//
// The input is the workspace's pnpm 9 lockfile. The output keeps only the root
// importer's runtime `dependencies`. Packages that only other importers or
// development dependencies use stay in `packages` and `snapshots`, and pnpm
// never installs them.
export function imageLockfile(workspaceLockfile: string): string {
	const lines = workspaceLockfile.split("\n");
	const importers = lines.indexOf("importers:");
	const packages = lines.indexOf("packages:");
	if (lines[0] !== "lockfileVersion: '9.0'" || importers === -1 || packages < importers) {
		throw new Error("The workspace pnpm-lock.yaml is not a pnpm 9 lockfile with importers and packages");
	}
	const root = lines.indexOf("  .:", importers);
	if (root === -1 || root > packages) {
		throw new Error("The workspace pnpm-lock.yaml has no root importer");
	}
	const rootImporter: string[] = [];
	let section: string | undefined;
	for (const line of lines.slice(root + 1, packages)) {
		// A two-space key starts the next importer.
		if (/^ {2}\S/.test(line)) break;
		const key = /^ {4}(\S+):$/.exec(line)?.[1];
		if (key !== undefined) section = key;
		if (section === "dependencies" || section === "optionalDependencies") rootImporter.push(line);
	}
	return [
		...lines.slice(0, importers + 1),
		"",
		"  .:",
		...rootImporter.filter((line) => line.length > 0),
		"",
		...lines.slice(packages),
	].join("\n");
}

// The same lockfile without some of the root importer's dependencies, for an image that does not
// need them. pnpm's frozen install accepts it while the image's package.json omits the same names.
// Their packages stay in `packages` and `snapshots`, and pnpm installs only what is reachable.
export function withoutRootDependencies(lockfile: string, names: ReadonlySet<string>): string {
	if (names.size === 0) return lockfile;
	const out: string[] = [];
	let inRoot = false;
	let skipping = false;
	for (const line of lockfile.split("\n")) {
		if (line === "  .:") inRoot = true;
		else if (/^ {0,2}\S/.test(line)) inRoot = false;
		if (inRoot && /^ {6}\S/.test(line)) {
			const name = line.trim().replace(/:$/, "").replace(/^'(.*)'$/, "$1");
			skipping = names.has(name);
		} else if (!inRoot || /^ {0,4}\S/.test(line)) {
			skipping = false;
		}
		if (!skipping) out.push(line);
	}
	return out.join("\n");
}
