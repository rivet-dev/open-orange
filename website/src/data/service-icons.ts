// Brand icons for the binding → service map on /docs/architecture/
// (BindingRoutes). Raw SVG from src/assets/services, each one comment-tagged
// with where it came from. The SVGs fill with currentColor: `color` is the
// brand colour where it keeps 3:1 contrast on both the light and the dark
// surface, and the rest take the text colour, so every icon reads in both themes.
import agentos from '@/assets/services/agentos.svg?raw';
import amazonS3 from '@/assets/services/amazon-s3.svg?raw';
import amazonSes from '@/assets/services/amazon-ses.svg?raw';
import browserbase from '@/assets/services/browserbase.svg?raw';
import chrome from '@/assets/services/chrome.svg?raw';
import daytona from '@/assets/services/daytona.svg?raw';
import e2b from '@/assets/services/e2b.svg?raw';
import freestyle from '@/assets/services/freestyle.svg?raw';
import mysql from '@/assets/services/mysql.svg?raw';
import nodejs from '@/assets/services/nodejs.svg?raw';
import openai from '@/assets/services/openai.svg?raw';
import openrouter from '@/assets/services/openrouter.svg?raw';
import postgresql from '@/assets/services/postgresql.svg?raw';
import rivet from '@/assets/services/rivet.svg?raw';

export type ServiceIcon = { name: string; svg: string; color?: string };

export const SERVICE_ICONS = {
	nodejs: { name: 'Node.js', svg: nodejs, color: '#5FA04E' },
	rivet: { name: 'Rivet', svg: rivet },
	'amazon-s3': { name: 'Amazon S3', svg: amazonS3, color: '#569A31' },
	'amazon-ses': { name: 'Amazon SES', svg: amazonSes, color: '#DD344C' },
	openrouter: { name: 'OpenRouter', svg: openrouter },
	openai: { name: 'OpenAI', svg: openai },
	e2b: { name: 'E2B', svg: e2b },
	daytona: { name: 'Daytona', svg: daytona },
	freestyle: { name: 'Freestyle', svg: freestyle },
	agentos: { name: 'agentOS', svg: agentos },
	browserbase: { name: 'Browserbase', svg: browserbase, color: '#FF4500' },
	chrome: { name: 'Chrome', svg: chrome, color: '#4285F4' },
	postgresql: { name: 'PostgreSQL', svg: postgresql, color: '#4169E1' },
	mysql: { name: 'MySQL', svg: mysql, color: '#4479A1' },
} satisfies Record<string, ServiceIcon>;

export type ServiceIconId = keyof typeof SERVICE_ICONS;
