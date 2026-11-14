using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
	services = [(
		name = "main",
		worker = (
			compatibilityDate = "2026-09-03",
			compatibilityFlags = [],
			modules = [(
				name = "worker",
				esModule = embed "durable-object-hibernation-registration-worker.js"
			)],
			bindings = [(
				name = "SOCKETS",
				durableObjectNamespace = "SocketRegistry"
			)],
			durableObjectNamespaces = [(
				className = "SocketRegistry",
				uniqueKey = "open-orange-hibernation-registration-fixture",
				preventEviction = true
			)],
			durableObjectStorage = (inMemory = void)
		)
	)],
	sockets = [(
		name = "http",
		address = "127.0.0.1:0",
		http = (),
		service = "main"
	)]
);
