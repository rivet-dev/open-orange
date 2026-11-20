// The /docs/ sidebar. Titles come from each file's frontmatter; this file only
// orders and groups the collection entries by id (path without extension).
// A doc missing here still gets a page and is listed under "More".
import { getCollection, type CollectionEntry } from 'astro:content';
import { NO_PAGE, docRoute } from './routes';

export type DocLink = { label: string; href: string; id?: string };
/** A sidebar section. `groups` are collapsible sub-sections, open when they hold the current page. */
/** `collapsed`: shown as a fold, open when it holds the current page. */
export type DocGroup = { title: string; links: DocLink[]; groups?: DocGroup[]; collapsed?: boolean };

type Section = { title: string; ids: string[]; groups?: { title: string; ids: string[] }[]; collapsed?: boolean };

const SECTIONS: Section[] = [
	{ title: 'Getting started', ids: ['/docs/', 'architecture', 'deploy', 'migrate'] },
	{
		title: 'Bindings',
		ids: ['/docs/bindings/', 'modules/bindings'],
		// Keep these groups matched to Cloudflare's own grouping, so people coming
		// from Cloudflare find a binding where they expect it. The dashboard sidebar
		// and the Workers bindings canvas group products as Compute, Storage
		// ("Storage & databases" in the dashboard) and AI; Media has no binding here
		// yet. The Workers docs put handlers and per-request APIs under Runtime APIs.
		// When Cloudflare moves or renames a product, move or rename it here too.
		groups: [
			{
				title: 'Compute',
				ids: ['modules/workflows', 'modules/multi-worker', 'modules/worker-loader', 'modules/sandbox', 'modules/assets'],
			},
			{
				title: 'Storage',
				ids: ['modules/durable-objects', 'modules/kv', 'modules/d1', 'modules/r2', 'modules/hyperdrive', 'modules/queues'],
			},
			{ title: 'AI', ids: ['modules/workers-ai', 'modules/browser-rendering'] },
			{
				title: 'Runtime APIs',
				ids: [
					'modules/globals',
					'modules/fetch-events',
					'modules/cron-triggers',
					'modules/tail-workers',
					'modules/cache',
					'modules/email',
					'modules/rate-limiting',
					'modules/secrets-store',
					'modules/version-metadata',
				],
			},
		],
	},
	// What OpenOrange adds on top of Cloudflare's APIs. Code that uses these runs on OpenOrange only.
	{ title: 'OpenOrange extensions', ids: ['extensions/fork-durable-objects'] },
	{
		title: 'Reference',
		ids: ['/docs/compatibility/', 'operations/monitoring', 'operations/debugging', 'operations/limits', 'operations/production-checklist'],
	},
	{ title: 'Advanced', ids: ['errors', 'internals/durable-objects'], collapsed: true },
];

// Docs pages written as Astro pages rather than repo MDX, listed in SECTIONS by route.
const PAGES: Record<string, string> = { '/docs/': 'Introduction', '/docs/bindings/': 'Bindings overview', '/docs/compatibility/': 'Compatibility' };

/** Titles that differ from the doc's frontmatter, on the page and in the sidebar. */
export const TITLES: Record<string, string> = { 'modules/browser-rendering': 'Browser Run', 'modules/bindings': 'Binding configuration' };

// Sidebar labels that differ from the page title.
const LABELS: Record<string, string> = { 'modules/bindings': 'Configuration', migrate: 'Migrate', errors: 'Error reports', 'internals/durable-objects': 'Durable Objects internals' };

/** Every link in sidebar order, with the title of the section or group it sits in. */
export const flattenNav = (groups: DocGroup[]): (DocLink & { group: string })[] =>
	groups.flatMap((group) => [
		...group.links.map((link) => ({ ...link, group: group.title })),
		...flattenNav(group.groups ?? []),
	]);

export const docHref = docRoute;

export async function docsNav(): Promise<{ groups: DocGroup[]; entries: CollectionEntry<'docs'>[] }> {
	const entries = await getCollection('docs');
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const links = (ids: string[]): DocLink[] =>
		ids.flatMap((id) => {
			if (PAGES[id]) return [{ label: PAGES[id], href: id }];
			const entry = byId.get(id);
			return entry ? [{ label: LABELS[id] ?? TITLES[id] ?? entry.data.title, href: docHref(id), id }] : [];
		});

	const listed = new Set(SECTIONS.flatMap((s) => [...s.ids, ...(s.groups ?? []).flatMap((g) => g.ids)]));
	const groups: DocGroup[] = SECTIONS.map((section) => ({
		title: section.title,
		links: links(section.ids),
		collapsed: section.collapsed,
		groups: section.groups?.map((g) => ({ title: g.title, links: links(g.ids) })).filter((g) => g.links.length),
	}));
	const unlisted = entries.filter((entry) => !listed.has(entry.id) && !NO_PAGE.has(entry.id)).sort((a, b) => a.data.title.localeCompare(b.data.title));
	if (unlisted.length) groups.splice(groups.length - 1, 0, { title: 'More', links: links(unlisted.map((e) => e.id)) });

	return { groups: groups.filter((group) => group.links.length || group.groups?.length), entries };
}
