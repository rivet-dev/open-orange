// Preload with `NODE_OPTIONS=--import <this file>`. It makes each hostname in ORANGE_TEST_HOSTS, a
// JSON object such as {"two-addresses.test": ["::1", "127.0.0.1"]}, resolve to those addresses
// in that order, as an /etc/hosts entry would without root. Connections to them stay real.
import dns, { type LookupAddress, type LookupOptions } from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import { isIP } from "node:net";

const hosts: Record<string, string[]> = JSON.parse(process.env.ORANGE_TEST_HOSTS ?? "{}");
const realLookup = dns.lookup;

type Callback = (error: Error | null, address: string | LookupAddress[], family?: number) => void;

function testLookup(hostname: string, options: LookupOptions | number | Callback, callback?: Callback): void {
	const done = typeof options === "function" ? options : callback!;
	const all = typeof options === "object" && options.all === true;
	const addresses = hosts[hostname];
	if (addresses === undefined) {
		Reflect.apply(realLookup, dns, typeof options === "function" ? [hostname, options] : [hostname, options, callback]);
		return;
	}
	const records = addresses.map((address) => ({ address, family: isIP(address) }));
	process.nextTick(() => (all ? done(null, records) : done(null, records[0]!.address, records[0]!.family)));
}

dns.lookup = testLookup as typeof dns.lookup;
syncBuiltinESMExports();
