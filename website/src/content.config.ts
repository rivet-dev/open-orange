import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// The repository's docs are the single source of truth: /docs/ renders them in
// place, so builds need the whole repository. Entry ids are paths without the
// extension, and `modules/index.mdx` becomes `modules`.
const docs = defineCollection({
	loader: glob({ base: '../docs', pattern: ['*.mdx', 'modules/*.mdx', 'operations/*.mdx', 'extensions/*.mdx', 'internals/*.mdx'] }),
	schema: z.object({ title: z.string(), description: z.string() }),
});

export const collections = { docs };
