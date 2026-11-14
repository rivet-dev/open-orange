import type { WranglerHelpInventory } from "../generators/wrangler-help.js";

/**
 * Wrangler commands whose help Orange replaces on purpose, with the reason.
 * Orange still answers `--help` for them, so only the text comparison is skipped.
 */
export const replacedHelpCommands: ReadonlyMap<string, string> = new Map([
	[
		"",
		"Orange lists only the commands that run in Orange, with its own descriptions, and only the global flags it takes.",
	],
	[
		"dev",
		"Orange documents only the dev flags it supports, plus its keys and JSON Lines events.",
	],
	["login", "Orange signs in to Rivet Cloud, not Cloudflare, and shares the session with the Rivet CLI."],
	["logout", "Orange signs out of Rivet Cloud, not Cloudflare."],
	["whoami", "Orange shows the Rivet Cloud account and the linked cluster, not a Cloudflare account."],
	["deploy", "Orange deploys to a Rivet cluster through the Rivet Cloud API, not to Cloudflare."],
	["d1 execute", "Orange adds --cloud-api, because its --remote reaches the linked Rivet cluster, not Cloudflare."],
	["d1 migrations apply", "Orange's --remote reaches the D1 database on the linked Rivet cluster, not on Cloudflare, and it adds --cloud-api."],
	["d1 migrations list", "Orange's --remote reaches the D1 database on the linked Rivet cluster, not on Cloudflare, and it adds --cloud-api."],
]);

export function compareHelpInventories(
	reference: WranglerHelpInventory,
	candidate: WranglerHelpInventory,
	replaced: ReadonlyMap<string, string>,
): string[] {
	const errors: string[] = [];
	const referenceCommands = new Map(
		reference.commands.map((command) => [command.path.join(" "), command]),
	);
	const candidateCommands = new Map(
		candidate.commands.map((command) => [command.path.join(" "), command]),
	);

	for (const [path, command] of referenceCommands) {
		const candidateCommand = candidateCommands.get(path);
		if (candidateCommand === undefined) {
			errors.push(`missing CLI help endpoint: ${path || "<root>"}`);
		} else if (candidateCommand.help !== command.help && !replaced.has(path)) {
			errors.push(`different CLI help output: ${path || "<root>"}`);
		}
	}
	for (const path of candidateCommands.keys()) {
		if (!referenceCommands.has(path)) {
			errors.push(`extra CLI help endpoint: ${path || "<root>"}`);
		}
	}
	for (const path of replaced.keys()) {
		if (!referenceCommands.has(path)) {
			errors.push(`replaced CLI help command is not in Wrangler: ${path}`);
		}
	}
	return errors;
}
