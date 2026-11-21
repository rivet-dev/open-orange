import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { isRecord } from "../bindings/unknown-values.js";

export const PINNED_RIVETKIT_BRANCH = "v3.1.2-rc.6";
export const PINNED_RIVETKIT_COMMIT =
	"7d2fda3749f785619883c46aed963fb7b48994e6";
export const PINNED_RIVETKIT_VERSION = "3.1.2-rc.6";
export const PINNED_RIVETKIT_SUPPORTED_HOSTS =
	"Linux x64/arm64 (glibc or musl) and macOS x64/arm64";

const rivetKitPackageName = "rivetkit";
const napiPackageName = "@rivetkit/rivetkit-napi";
const enginePackageName = "@rivetkit/engine-cli";

export interface InstalledRivetKitPackage {
	name: string;
	version: string;
}

export interface InstalledRivetKitBuild {
	engineBinaryPath: string;
	enginePlatformBinaryPath: string;
	nativeWrapperHasLocalBinary: boolean;
	packages: readonly InstalledRivetKitPackage[];
}

function readPackageManifest(path: string): InstalledRivetKitPackage {
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (
		!isRecord(parsed) ||
		typeof parsed.name !== "string" ||
		typeof parsed.version !== "string"
	) {
		throw new Error(`Invalid RivetKit package manifest at ${path}`);
	}
	return { name: parsed.name, version: parsed.version };
}

function findPackageManifest(
	entrypoint: string,
	expectedName: string,
): InstalledRivetKitPackage {
	let directory = dirname(entrypoint);
	while (true) {
		const path = join(directory, "package.json");
		if (existsSync(path)) {
			const manifest = readPackageManifest(path);
			if (manifest.name === expectedName) {
				return manifest;
			}
		}
		const parent = dirname(directory);
		if (parent === directory) {
			throw new Error(
				`Could not locate the ${expectedName} package manifest from ${entrypoint}`,
			);
		}
		directory = parent;
	}
}

function usesMusl(): boolean {
	const report: unknown = process.report?.getReport();
	if (!isRecord(report) || !isRecord(report.header)) {
		return true;
	}
	return typeof report.header.glibcVersionRuntime !== "string";
}

function nativePlatformPackageName(): string {
	if (process.platform === "darwin") {
		if (process.arch === "x64" || process.arch === "arm64") {
			return `${napiPackageName}-${process.platform}-${process.arch}`;
		}
	} else if (process.platform === "linux") {
		if (process.arch === "x64" || process.arch === "arm64") {
			return `${napiPackageName}-${process.platform}-${process.arch}-${usesMusl() ? "musl" : "gnu"}`;
		}
	}
	throw new Error(
		`The pinned RivetKit ${PINNED_RIVETKIT_VERSION} supports ${PINNED_RIVETKIT_SUPPORTED_HOSTS}; received ${process.platform}/${process.arch}`,
	);
}

function nativeLocalBinaryName(): string {
	if (process.platform === "linux") {
		return `rivetkit-napi.linux-${process.arch}-${usesMusl() ? "musl" : "gnu"}.node`;
	}
	return `rivetkit-napi.${process.platform}-${process.arch}.node`;
}

function enginePlatformPackageName(): string {
	if (process.platform === "linux") {
		if (process.arch === "x64" || process.arch === "arm64") {
			return `${enginePackageName}-linux-${process.arch}-musl`;
		}
	} else if (process.platform === "darwin") {
		if (process.arch === "x64" || process.arch === "arm64") {
			return `${enginePackageName}-darwin-${process.arch}`;
		}
	}
	throw new Error(
		`The pinned RivetKit ${PINNED_RIVETKIT_VERSION} supports ${PINNED_RIVETKIT_SUPPORTED_HOSTS}; received ${process.platform}/${process.arch}`,
	);
}

function requireEngineBinaryPath(
	requireFromRivetKit: NodeJS.Require,
): string {
	const enginePackage: unknown = requireFromRivetKit(enginePackageName);
	if (!isRecord(enginePackage) || typeof enginePackage.getEnginePath !== "function") {
		throw new Error("The pinned RivetKit Engine package has no getEnginePath()");
	}
	const path: unknown = Reflect.apply(
		enginePackage.getEnginePath,
		enginePackage,
		[],
	);
	if (typeof path !== "string") {
		throw new Error("The pinned RivetKit Engine package returned an invalid path");
	}
	return path;
}

export function discoverInstalledRivetKitBuild(): InstalledRivetKitBuild {
	const requireFromOrange = createRequire(import.meta.url);
	const rivetKitEntrypoint = requireFromOrange.resolve(rivetKitPackageName);
	const requireFromRivetKit = createRequire(rivetKitEntrypoint);
	const napiEntrypoint = requireFromRivetKit.resolve(napiPackageName);
	const engineEntrypoint = requireFromRivetKit.resolve(enginePackageName);
	const nativePlatformName = nativePlatformPackageName();
	const enginePlatformName = enginePlatformPackageName();
	// Each platform package is an optional dependency of its wrapper, not of rivetkit. Resolve it
	// from the wrapper: pnpm's global install does not hoist it where rivetkit can see it.
	const nativePlatformManifestPath = createRequire(napiEntrypoint).resolve(
		`${nativePlatformName}/package.json`,
	);
	const enginePlatformManifestPath = createRequire(engineEntrypoint).resolve(
		`${enginePlatformName}/package.json`,
	);
	const enginePlatformBinaryPath = join(
		dirname(enginePlatformManifestPath),
		"rivet-engine",
	);
	return {
		engineBinaryPath: requireEngineBinaryPath(requireFromRivetKit),
		enginePlatformBinaryPath,
		nativeWrapperHasLocalBinary: existsSync(
			join(dirname(napiEntrypoint), nativeLocalBinaryName()),
		),
		packages: [
			findPackageManifest(rivetKitEntrypoint, rivetKitPackageName),
			findPackageManifest(napiEntrypoint, napiPackageName),
			readPackageManifest(nativePlatformManifestPath),
			findPackageManifest(engineEntrypoint, enginePackageName),
			readPackageManifest(enginePlatformManifestPath),
		],
	};
}

export function assertPinnedRivetKitBuild(
	build = discoverInstalledRivetKitBuild(),
): void {
	const expectedPackageNames = new Set([
		rivetKitPackageName,
		napiPackageName,
		nativePlatformPackageName(),
		enginePackageName,
		enginePlatformPackageName(),
	]);
	const resolvedPackageNames = new Set(
		build.packages.map((packageManifest) => packageManifest.name),
	);
	if (
		build.packages.length !== expectedPackageNames.size ||
		resolvedPackageNames.size !== expectedPackageNames.size ||
		[...expectedPackageNames].some((name) => !resolvedPackageNames.has(name))
	) {
		throw new Error(
			`OpenOrange requires exactly these RivetKit build packages: ${[...expectedPackageNames].join(", ")}; resolved ${build.packages.map(({ name }) => name).join(", ")}`,
		);
	}
	for (const packageManifest of build.packages) {
		if (packageManifest.version !== PINNED_RIVETKIT_VERSION) {
			throw new Error(
				`OpenOrange requires ${packageManifest.name}@${PINNED_RIVETKIT_VERSION} from RivetKit ${PINNED_RIVETKIT_BRANCH} (commit ${PINNED_RIVETKIT_COMMIT}); resolved ${packageManifest.version}`,
			);
		}
	}
	if (build.nativeWrapperHasLocalBinary) {
		throw new Error(
			"OpenOrange refuses an unversioned local RivetKit NAPI binary; install the pinned platform package",
		);
	}
	if (
		realpathSync(build.engineBinaryPath) !==
		realpathSync(build.enginePlatformBinaryPath)
	) {
		throw new Error(
			`OpenOrange requires the pinned RivetKit Engine artifact at ${build.enginePlatformBinaryPath}; resolved ${build.engineBinaryPath}`,
		);
	}
}
