// /vs-workerd/ page copy: the two descriptions, when to use each, and the
// comparison matrix. The service-by-service rows and the limits it rests on
// are WORKERD_SERVICES and WORKERD_LIMITS in site.ts, read from workerd's
// source at the release pinned in WORKERD.
//
// Every workerd claim here is about workerd's stable features: the default
// configuration, without the --experimental flag. Sources, at the pinned
// release unless noted:
// - Bindings forward to a service you write: workerd.capnp kvNamespace,
//   r2Bucket, queue; workflowsEngine is "externally-supplied"; no d1 binding.
// - Durable Object storage: workerd.capnp durableObjectStorage. localDisk is
//   "EXPERIMENTAL; SUBJECT TO BACKWARDS-INCOMPATIBLE CHANGE"; inMemory is
//   "intended for local testing purposes".
// - Self-hosting stateless Workers and `wrangler dev`: README "As an
//   application server", "Serving in production", "Local Worker development
//   with wrangler".
// - Wrangler fields: README "Configuring workerd".
// - Memory, CPU and alarms: worker-factory.c++ NullIsolateLimitEnforcer
//   ("Single-tenant policy: no limits"), getAlarmLimit() returns 15 minutes.
//   No Durable Object storage size is documented.
// - No tooling moves data into or out of workerd.
// - License: Apache 2.0 (LICENSE).
// OpenOrange claims come from site.ts (SERVICE_MAP, DEPLOY_TARGETS, FAQ),
// the /architecture/ and /enterprise/ pages, README.md (Node.js 22) and
// docs/migrate.mdx. Forking is Rivet's: rivet.dev/actors/docs/forking/.

// Text in backticks renders as code.

export const WORKERD_AS_OF = { iso: '2026-11-12', label: 'November 12, 2026' } as const;

export const WORKERD_COMPARE = {
	headline: 'OpenOrange runs your app. workerd runs a Worker.',
	workerd:
		"Cloudflare's core runtime: it executes a Worker, and it's what `wrangler dev` runs on your laptop. It doesn't run Durable Objects across machines, and it has no KV, D1, Queues or Workflows of its own. Its storage is for development, not data you keep.",
	openorange:
		'Runs your whole Cloudflare project in production. Your Workers run on Node.js, and Rivet runs Durable Objects, KV, D1, Queues, Workflows and the rest across your machines. Cloudflare locks your data in. OpenOrange opens it up and live-migrates it, with zero downtime for Durable Objects.',
	useOpenOrange: [
		'You run a Cloudflare project in production on your own cloud.',
		'You need Durable Objects, Queues or Workflows across machines.',
		'You need production storage, not a SQLite file on one disk.',
		'You want stock Node.js, not the `nodejs_compat` subset.',
		"You're live-migrating an app off Cloudflare, or between OpenOrange clusters.",
		'You want to fork an Actor and its state.',
	],
	useWorkerd: [
		"You deploy to Cloudflare and want its exact runtime on your machine to test a Worker.",
		'Your Worker is a stateless fetch handler and needs nothing else.',
	],
	footnote:
		"Compared with workerd's default configuration as of November 12, 2026.",
} as const;

/** yes: it does this. no: it doesn't. partial: only part of it. Unset: a plain fact. */
export type Mark = 'yes' | 'no' | 'partial';
export type MatrixCell = { mark?: Mark; text: string };
export type MatrixRow = { label: string; workerd: MatrixCell; openorange: MatrixCell };

export const WORKERD_MATRIX: MatrixRow[] = [
	{
		label: 'Runs your Cloudflare code as is',
		workerd: { mark: 'partial', text: 'The Worker runs. Most bindings call services you build.' },
		openorange: { mark: 'yes', text: 'Your code and wrangler config, unchanged.' },
	},
	{
		label: 'Live migration of your data',
		workerd: { mark: 'no', text: 'No tooling.' },
		openorange: { mark: 'yes', text: 'Off Cloudflare or between OpenOrange clusters, with zero downtime for Durable Objects.' },
	},
	{
		label: 'Production-ready',
		workerd: { mark: 'partial', text: 'For stateless Workers only.' },
		openorange: { mark: 'yes', text: 'Durable Objects and storage included.' },
	},
	{
		label: 'Durable Objects across machines',
		workerd: { mark: 'no', text: 'One process holds every object.' },
		openorange: { mark: 'yes', text: 'Rivet places them across your machines.' },
	},
	{
		label: 'Fork an Actor with its state',
		workerd: { mark: 'no', text: 'No.' },
		openorange: { mark: 'yes', text: 'Yes, with Rivet Actors beside your Workers. A Durable Object facet `clone()` is a fork.' },
	},
	{
		label: 'Storage',
		workerd: { mark: 'no', text: 'For development. Experimental SQLite on one disk.' },
		openorange: { mark: 'yes', text: "Rivet's durable store, in the region you choose." },
	},
	{
		label: 'Database size',
		workerd: { text: 'Not documented.' },
		openorange: { mark: 'yes', text: 'Not capped by host disk.' },
	},
	{
		label: 'Latency to your database',
		workerd: { mark: 'partial', text: 'The Worker can sit next to it. Storage and services are yours to build.' },
		openorange: { mark: 'yes', text: 'In your VPC, next to it, with Durable Objects and storage.' },
	},
	{
		label: 'KV, D1, R2, Queues, Workflows',
		workerd: { mark: 'no', text: 'Bindings only. You build the services.' },
		openorange: { mark: 'yes', text: 'Built in. R2 can use any S3-compatible store.' },
	},
	{
		label: 'Cron Triggers',
		workerd: { mark: 'no', text: 'The handler runs. Nothing fires it.' },
		openorange: { mark: 'yes', text: 'Built in, same cron syntax.' },
	},
	{
		label: 'Node.js',
		workerd: { mark: 'no', text: 'The `nodejs_compat` subset.' },
		openorange: { mark: 'yes', text: 'Stock Node.js 22 or later.' },
	},
	{
		label: 'Memory',
		workerd: { mark: 'partial', text: 'No cap, but one process holds every Durable Object.' },
		openorange: { mark: 'yes', text: "Up to your machine's memory. The Node.js heap is configurable." },
	},
	{
		label: 'CPU and alarm time',
		workerd: { mark: 'partial', text: 'No CPU cap. Alarms stop at 15 minutes, hard-coded.' },
		openorange: { mark: 'yes', text: 'No CPU cap. Alarms run past 15 minutes.' },
	},
	{
		label: 'Wrangler config',
		workerd: { mark: 'partial', text: 'A few fields. Anything else is an error.' },
		openorange: { mark: 'yes', text: 'Read unchanged.' },
	},
	{
		label: 'Deploy targets',
		workerd: { text: 'Any machine. You build the rollout.' },
		openorange: { mark: 'yes', text: 'Rivet Cloud, your AWS, GCP or Azure account, or your own servers.' },
	},
	{
		label: 'Managed option',
		workerd: { mark: 'no', text: 'None, outside Cloudflare itself.' },
		openorange: { mark: 'yes', text: 'Rivet Cloud, or BYOC in your account.' },
	},
	{
		label: 'License',
		workerd: { text: 'Apache 2.0' },
		openorange: { text: 'Apache 2.0' },
	},
	{
		label: 'Maintained and supported',
		workerd: { text: 'Maintained by Cloudflare as the core of Workers.' },
		openorange: { mark: 'yes', text: 'Maintained by Rivet, with support contracts.' },
	},
];
