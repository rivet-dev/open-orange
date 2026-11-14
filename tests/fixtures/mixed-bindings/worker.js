import { DurableObject } from "cloudflare:workers";

export class Room extends DurableObject {}
export class Cart extends DurableObject {}
export class Lobby extends DurableObject {}

export default {
	fetch() {
		return new Response("ok");
	},
	scheduled() {},
	tail() {},
};
