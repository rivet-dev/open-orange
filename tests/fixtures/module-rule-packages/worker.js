import { readdirSync, readFileSync } from "node:fs";

import packaged from "wasm-pkg/add.wasm";
import blob from "wasm-pkg/blob.bin";
import local from "./local.wasm";
import note from "./note.txt";

export default {
	async fetch(request) {
		if (new URL(request.url).pathname === "/bundle") {
			// Each uploaded module, with its bytes as hex.
			const entries = readdirSync("/bundle").filter((name) => name !== "worker").sort();
			return Response.json(entries.map((name) => [name, readFileSync(`/bundle/${name}`).toString("hex")]));
		}
		const fromPackage = (await WebAssembly.instantiate(packaged)).exports.add(2, 3);
		const fromProject = (await WebAssembly.instantiate(local)).exports.add(10, 20);
		return Response.json({ fromPackage, fromProject, blob: [...new Uint8Array(blob)], note });
	},
};
