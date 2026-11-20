import { createHash } from "node:crypto";

import type { RivetActorClient } from "../../internal/rivetkit.js";
import { forkDurableObjectActor } from "./orange-fork.js";
import {
	durableObjectActorInput,
	durableObjectStorageName,
	type DurableObjectStubDescriptor,
	type ForkDurableObjectActor,
	type ResolveDurableObjectActor,
} from "./namespace.js";

// A Durable Object actor is addressed as `<class-slug>-<hash>` / `[jurisdiction?, idHex]`, for example
// `greeter-5c8cd02c` / `80ac…36cc`. The key is the ID itself, so every
// process that holds the ID, as an object or as a string, derives the same actor.

const actorNameDigestLength = 8;
const classSlugMaxLength = 40;

function actorNameDigest(deploymentIdentity: string, className: string): string {
	if (deploymentIdentity.length === 0 || className.length === 0) {
		throw new Error(
			"Durable Object actor names require deployment and class names",
		);
	}
	return createHash("sha256")
		.update("open-orange-durable-object\0")
		.update(deploymentIdentity)
		.update("\0")
		.update(className)
		.digest("hex");
}

function classSlug(className: string): string {
	const slug = className
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.slice(0, classSlugMaxLength)
		.replace(/^-+|-+$/g, "");
	return slug === "" ? "object" : slug;
}

/** `greeter-5c8cd02c`: the class in kebab case plus a hash of the deployment and class. */
export function durableObjectActorName(
	deploymentIdentity: string,
	className: string,
): string {
	const storageName = durableObjectStorageName(deploymentIdentity, className);
	const digest = actorNameDigest(deploymentIdentity, storageName);
	return `${classSlug(storageName)}-${digest.slice(0, actorNameDigestLength)}`;
}

/** `[idHex]`, or `[jurisdiction, idHex]` for an ID made in a jurisdiction. */
export function durableObjectActorKey(
	descriptor: Pick<DurableObjectStubDescriptor, "id" | "jurisdiction">,
): readonly string[] {
	const hex = descriptor.id.toString();
	return descriptor.jurisdiction === undefined ? [hex] : [descriptor.jurisdiction, hex];
}

/** Resolves Durable Object IDs to actors through `client`. */
export function createDurableObjectActorResolver(
	client: () => RivetActorClient,
): ResolveDurableObjectActor {
	return (descriptor) =>
		client().getOrCreate(
			durableObjectActorName(descriptor.deploymentIdentity, descriptor.className),
			durableObjectActorKey(descriptor),
			durableObjectActorInput(descriptor),
		);
}

/** Forks objects' actors through `client`, for `orange.fork()`. */
export function createDurableObjectActorForker(
	client: () => RivetActorClient,
): ForkDurableObjectActor {
	return (source, target, input) =>
		forkDurableObjectActor(client(), {
			actorName: durableObjectActorName(source.deploymentIdentity, source.className),
			input,
			// The copy keeps a name only up to 1024 bytes, as an object started by name does.
			name: durableObjectActorInput(target)?.name,
			sourceKey: durableObjectActorKey(source),
			targetKey: durableObjectActorKey(target),
		});
}
