// The short binding → service map on /docs/architecture/ (BindingRoutes).
// One row per service a binding lands on, grouped so the page reads in a
// glance. Each claim follows
// the binding's docs/modules/*.mdx page and its `orange` field in
// packages/cloudflare-conformance/compat/products.json; the full table with
// statuses is SERVICE_MAP in site.ts. Provider names come from PROVIDERS, so
// they stay in step with the rest of the site. `icons` are the brand icons of
// the services a row names, from SERVICE_ICONS.
import { PRODUCTS } from './conformance';
import type { ServiceIconId } from './service-icons';
import { PROVIDERS, SITE } from './site';

export type MappedBinding = { label: string; href: string };

export type BindingRoute = {
	id: string;
	bindings: MappedBinding[];
	service: string;
	detail: string;
	icons: ServiceIconId[];
};

const doc = (label: string, page: string, anchor = ''): MappedBinding => ({
	label,
	href: `${SITE.docsBindings}${page}/${anchor}`,
});

/** "A, B, C or D": the hosted providers for a pluggable binding, `first` leading, plus any extras. */
const examples = (key: string, extra: string[] = [], first?: string): string => {
	const hosted = PROVIDERS[key]?.hosted.map((p) => p.name) ?? [];
	const ordered = first && hosted.includes(first) ? [first, ...hosted.filter((n) => n !== first)] : hosted;
	const names = [...ordered, ...extra];
	if (names.length < 2) return names.join('');
	return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
};

export const BINDING_ROUTES: BindingRoute[] = [
	{
		id: 'workers',
		bindings: [doc('Workers', 'fetch-events')],
		service: 'The OpenOrange runtime, on Node.js',
		detail: 'Your fetch handler and Workers globals, in a Node.js process in your container.',
		icons: ['nodejs'],
	},
	{
		id: 'actors',
		bindings: [
			doc('Durable Objects', 'durable-objects'),
			doc('KV', 'kv'),
			doc('D1', 'd1'),
			doc('Workflows', 'workflows'),
			doc('Queues', 'queues'),
			doc('Cron Triggers', 'cron-triggers'),
			doc('Cache API', 'cache'),
			doc('Rate Limiting', 'rate-limiting'),
		],
		service: 'Rivet Actors',
		detail: 'One Actor per object, namespace, database, queue or Workflow instance. Rivet places them across your containers.',
		icons: ['rivet'],
	},
	{
		id: 'r2',
		bindings: [doc('R2', 'r2')],
		service: 'A Rivet Actor, or any S3-compatible store',
		detail: `An Actor by default. Point a bucket at ${examples('r2')}.`,
		icons: ['rivet', 'amazon-s3'],
	},
	{
		id: 'email',
		bindings: [doc('Email', 'email')],
		service: 'Any SMTP server',
		detail: `Such as ${examples('send-email', [], 'Amazon SES')}.`,
		icons: ['amazon-ses'],
	},
	{
		id: 'ai',
		bindings: [doc('Workers AI', 'workers-ai')],
		service: 'Any OpenAI-compatible endpoint',
		detail: `OpenRouter by default, or ${examples('workers-ai', [], 'OpenRouter').replace(/^OpenRouter, /, '')}.`,
		icons: ['openrouter', 'openai'],
	},
	{
		id: 'sandboxes',
		bindings: [doc('Sandboxes', 'sandbox'), doc('Containers', 'sandbox', '#containers')],
		service: 'Your sandbox provider',
		detail: `${examples('sandboxes', ['an agentOS VM'])}. Other container images do not run.`,
		icons: ['e2b', 'daytona', 'freestyle', 'agentos'],
	},
	{
		id: 'browser',
		bindings: [doc('Browser Rendering', 'browser-rendering')],
		service: 'Browserbase, or any DevTools Protocol browser',
		detail: `Also ${examples('browser-rendering', ['a headless Chrome you run']).replace(/^Browserbase, /, '')}.`,
		icons: ['browserbase', 'chrome'],
	},
	{
		id: 'hyperdrive',
		bindings: [doc('Hyperdrive', 'hyperdrive')],
		service: 'Your Postgres or MySQL database, in your VPC',
		detail: 'The Worker runs there too, so it connects directly with your connection string.',
		icons: ['postgresql', 'mysql'],
	},
];

/** Bindings that load but throw on every call (status `stub` in products.json). */
export const NOT_SUPPORTED: string[] = PRODUCTS.filter((p) => p.status === 'stub').flatMap((p) => p.product.split(', '));
