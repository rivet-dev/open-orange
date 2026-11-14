// Loaded before every root test file. Tests start real `orange dev` processes that inherit this
// environment, so Orange settings and provider keys from the developer's shell would change what
// the tests observe. Tests that need one of these set it explicitly on the process they start.
const prefixes = ["ORANGE_", "RIVET_", "RIVETKIT_"];
// CLAUDE_CONFIG_DIR and CODEX_HOME point `orange mcp` at the developer's agent configuration.
const names = ["OPENROUTER_API_KEY", "E2B_API_KEY", "DAYTONA_API_KEY", "FREESTYLE_API_KEY", "CLAUDE_CONFIG_DIR", "CODEX_HOME"];

for (const name of Object.keys(process.env)) {
	if (names.includes(name) || prefixes.some((prefix) => name.startsWith(prefix))) {
		delete process.env[name];
	}
}
