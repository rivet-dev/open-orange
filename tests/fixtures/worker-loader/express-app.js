// An Express app for a dynamic Worker. The test bundles it with Express into
// one module, since dynamic Workers cannot resolve npm packages.
import { httpServerHandler } from "cloudflare:node";
import express from "express";

const app = express();
app.use(express.json());
app.get("/users/:id", (req, res) => {
	res.json({ id: req.params.id });
});
app.post("/echo", (req, res) => {
	res.status(201).send(`hello ${req.body.name}`);
});
app.get("/cookies", (_req, res) => {
	res.cookie("a", "1");
	res.cookie("b", "2");
	res.send("cookies");
});
app.listen(8080);

export default httpServerHandler({ port: 8080 });
