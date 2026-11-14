import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync("generated", { recursive: true });
writeFileSync("generated/build.txt", "built before bundling");
