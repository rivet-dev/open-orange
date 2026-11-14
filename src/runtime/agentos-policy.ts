import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { mergeRuntimeSettings, workerVarSettings } from "../../packages/runtime-node/src/internal/runtime-settings.js";
import { r2S3SettingsFromEnvironment } from "../../packages/runtime-node/src/bindings/r2/s3-backend.js";
import { aiBaseUrlVariable, defaultBaseUrl as defaultAiBaseUrl } from "../../packages/runtime-node/src/bindings/ai/backend.js";
import type { SpawnRuntimeOptions } from "./spawn.js";

/** Forward explicit Orange configuration, rather than the ambient host environment. */
export function agentOsRuntimeEnvironment(): Record<string, string> {
	const credentials = new Set(["NODE_OPTIONS", "RIVET_TOKEN", "RIVET_NAMESPACE", "RIVET_PUBLIC_TOKEN", "RIVET_PUBLIC_ENDPOINT", "RIVET__AUTH__ADMIN_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "OPENROUTER_API_KEY"]);
	return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && (entry[0].startsWith("ORANGE_") || credentials.has(entry[0]))));
}

/** Explicit host service grants, separate from VM-local loopback. */
export function configuredHostLoopbackPorts(): number[] {
	const text = process.env.OPENORANGE_AGENTOS_HOST_LOOPBACK_PORTS?.trim();
	if (!text) return [];
	const limit = Number(process.env.OPENORANGE_AGENTOS_MAX_HOST_LOOPBACK_PORTS ?? 128);
	const invalid = (message: string): never => { throw Object.assign(new Error(message), { code: "ERR_OPENORANGE_AGENTOS_NETWORK_CONFIG" }); };
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 65535) invalid("OPENORANGE_AGENTOS_MAX_HOST_LOOPBACK_PORTS must be 1 through 65535");
	if (text.length > 65536) invalid("OPENORANGE_AGENTOS_HOST_LOOPBACK_PORTS exceeds 64 KiB");
	const ports = [...new Set(text.split(',').map(value => {
		const port = Number(value.trim());
		if (!/^\d+$/.test(value.trim()) || !Number.isInteger(port) || port < 1 || port > 65535) invalid("OPENORANGE_AGENTOS_HOST_LOOPBACK_PORTS must contain comma-separated TCP ports 1 through 65535");
		return port;
	}))];
	if (ports.length > limit) invalid(`Host loopback grants exceed ${limit}; raise OPENORANGE_AGENTOS_MAX_HOST_LOOPBACK_PORTS`);
	if (ports.length >= limit * 0.8) process.stderr.write(`WARN_OPENORANGE_HOST_LOOPBACK_GRANTS_NEAR_LIMIT: ${ports.length}/${limit}; raise OPENORANGE_AGENTOS_MAX_HOST_LOOPBACK_PORTS\n`);
	return ports;
}

/** Each configured provider authorizes only its endpoint, with loopback opt-in per port. */
export function agentOsServiceNetwork(options: SpawnRuntimeOptions, environment: Record<string, string>, backend: { host: string; port: number }, fixturePorts: number[] = configuredHostLoopbackPorts()) {
	const settings = mergeRuntimeSettings(environment, workerVarSettings(options.bindingConfigurations));
	const urls: string[] = [];
	for (const binding of options.bindingConfigurations) {
		if (binding.type === "ai") urls.push(settings[aiBaseUrlVariable] ?? defaultAiBaseUrl);
		if (binding.type === "browser" && settings.ORANGE_BROWSER_CDP_URL) urls.push(settings.ORANGE_BROWSER_CDP_URL);
		if (binding.type === "hyperdrive") urls.push(binding.connectionString);
		if (binding.type === "r2_bucket") {
			const s3 = r2S3SettingsFromEnvironment(binding.bucketName, settings);
			if (s3) urls.push(s3.endpoint);
		}
	}
	if (settings.ORANGE_EMAIL_SMTP_URL) urls.push(settings.ORANGE_EMAIL_SMTP_URL);
	if (settings.ORANGE_MIGRATE_WORKER_URL) urls.push(settings.ORANGE_MIGRATE_WORKER_URL);
	const targets = [backend, ...fixturePorts.map(port => ({ host: "127.0.0.1", port })), ...urls.map(value => {
		const url = new URL(value);
		const defaults: Record<string, number> = { "http:": 80, "https:": 443, "ws:": 80, "wss:": 443, "smtp:": 25, "smtps:": 465, "postgres:": 5432, "postgresql:": 5432, "mysql:": 3306 };
		const port = Number(url.port || defaults[url.protocol]);
		if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid configured service port (${url.protocol})`);
		return { host: url.hostname, port };
	})];
	return {
		patterns: [...new Set(["tcp://127.0.0.1:*", "tcp://[::1]:*", ...targets.map(target => `tcp://${target.host}:${target.port}`)])],
		loopbackExemptPorts: [...new Set(targets.filter(target => ["127.0.0.1", "localhost", "[::1]", "::1"].includes(target.host)).map(target => target.port))],
	};
}

/** Explicit trusted-controller authority for a private temporary project tree.
 * The VM still receives only its selected project mount, never the base tree.
 */
export async function agentOsProjectIsWritable(projectRoot: string): Promise<boolean> {
 const configured=process.env.OPENORANGE_AGENTOS_WRITABLE_PROJECT_BASE;
 const list=process.env.OPENORANGE_AGENTOS_WRITABLE_PROJECT_BASES;
 if(!configured&&!list)return false;
 const invalid=(message:string):never=>{throw Object.assign(new Error(message),{code:"ERR_OPENORANGE_AGENTOS_FILESYSTEM_CONFIG"});};
 let parsed:unknown=[];
 if(list){
  if(list.length>65536)invalid("OPENORANGE_AGENTOS_WRITABLE_PROJECT_BASES exceeds64KiB");
  try{parsed=JSON.parse(list);}catch{invalid("OPENORANGE_AGENTOS_WRITABLE_PROJECT_BASES must be a JSON array of absolute private directory paths");}
 }
 if(!Array.isArray(parsed)||parsed.length>16||parsed.some(value=>typeof value!=="string"))invalid("OPENORANGE_AGENTOS_WRITABLE_PROJECT_BASES must contain at most16 directory paths");
 const bases=[...new Set([...(configured?[configured]:[]),...(parsed as string[])])];
 if(bases.length>16)invalid("At most16 writable project bases are supported; reduce OPENORANGE_AGENTOS_WRITABLE_PROJECT_BASES");
 if(bases.length>=13)process.stderr.write(`WARN_OPENORANGE_WRITABLE_PROJECT_BASES_NEAR_LIMIT: ${bases.length}/16; reduce configured bases\n`);
 const project=await realpath(projectRoot);
 let permitted=false;
 for(const entry of bases){
  if(!isAbsolute(entry))invalid("Writable project bases must be absolute");
  const base=resolve(entry),metadata=await lstat(base),canonical=await realpath(base);
  if(base===sep||canonical!==base||!metadata.isDirectory()||metadata.uid!==process.getuid?.()||(metadata.mode&0o077)!==0)invalid("Writable project bases must be canonical, owned private directories (mode0700)");
  const child=relative(base,project);
  if(child===""||(!isAbsolute(child)&&child!==".."&&!child.startsWith(".."+sep)))permitted=true;
 }
 return permitted;
}
