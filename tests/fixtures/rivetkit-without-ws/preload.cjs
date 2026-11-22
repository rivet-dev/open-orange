// Loaded with `--require` into `orange dev` and its runtime. It stands in for a RivetKit install that
// cannot load `ws`, so Orange cannot make RivetKit open its sockets with `ws`.
const Module = require("node:module");
const { sep } = require("node:path");

const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
	if (request === "ws" && parent?.filename?.includes(`${sep}rivetkit${sep}`)) {
		throw Object.assign(new Error(`Cannot find module '${request}'`), { code: "MODULE_NOT_FOUND" });
	}
	return Reflect.apply(resolveFilename, this, [request, parent, ...rest]);
};
