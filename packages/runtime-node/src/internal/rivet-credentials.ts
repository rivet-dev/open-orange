// Credentials the runtime uses to reach the Rivet Engine. Worker code shares this
// process's environment, so the runtime takes them out before the Worker loads.
const credentialNames = [
	"RIVET_ENDPOINT",
	"RIVET_PUBLIC_ENDPOINT",
	"RIVET_PUBLIC_TOKEN",
	"RIVET_TOKEN",
] as const;

// The local Engine that RivetKit spawns reads its admin token from the environment
// when it starts, so it stays unless the runtime uses an external Engine.
const localEngineAdminToken = "RIVET__AUTH__ADMIN_TOKEN";

let taken: Partial<Record<string, string>> = {};
// The external Engine endpoint, such as `https://<namespace>:<token>@api.rivet.dev`.
let externalEndpoint: string | undefined;

export function takeRivetCredentials(options: { endpoint: string | undefined }): void {
	externalEndpoint = options.endpoint;
	const names: string[] = [...credentialNames];
	if (options.endpoint !== undefined) names.push(localEngineAdminToken);
	for (const name of names) {
		const value = process.env[name];
		if (value === undefined) continue;
		taken = { ...taken, [name]: value };
		delete process.env[name];
	}
}

// RIVET_TOKEN as the runtime process received it.
export function rivetToken(): string | undefined {
	return taken.RIVET_TOKEN ?? process.env.RIVET_TOKEN;
}

/**
 * The credential of Orange's Rivet control client, which resolves and creates actors and mints the
 * scoped tokens that Orange calls actors with: the token in the external endpoint URL, else
 * RIVET_TOKEN. A local Engine accepts RivetKit's local admin token `default`. Undefined when an
 * external Engine has no token.
 */
export function rivetControlCredential(): string | undefined {
	if (externalEndpoint === undefined) return rivetToken() ?? "default";
	const password = new URL(externalEndpoint).password;
	// RivetKit's client decodes the endpoint password the same way.
	return password.length > 0 ? decodeURIComponent(password) : rivetToken();
}
