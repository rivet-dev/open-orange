export type Case = { name: string; status: string };
export type Run = { cases: Case[]; complete: boolean; capped?: boolean; timedOut?: boolean; error?: string };

export function validRun(run: Run): boolean {
	return run.complete && run.cases.length > 0 && !run.capped && !run.timedOut && !run.error &&
		new Set(run.cases.map(c => c.name)).size === run.cases.length;
}

export function matchedPasses(host: Run, guest: Run): number {
	if (!validRun(host) || !validRun(guest) || host.cases.length !== guest.cases.length) return 0;
	if (host.cases.some(h => !guest.cases.some(g => g.name === h.name))) return 0;
	return host.cases.filter(h => h.status === "pass" && guest.cases.some(g => g.name === h.name && g.status === "pass")).length;
}
export function hostCases(text: string): { cases: Case[]; complete: boolean; error?: string; skippedSuites?: {name:string;reason:string}[] } {
	let events: any[];
	try { events = text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
	catch { return { cases: [], complete: false, error: "Malformed JSON Lines test report" }; }
	const starts = new Map<number, { name: string; parentId: number }>();
	for (const e of events) if (e.data?.testId && e.data.name !== e.data.file) starts.set(e.data.testId, e.data);
	const nameOf = (id: number): string => { const d = starts.get(id); return d ? (d.parentId && starts.has(d.parentId) ? nameOf(d.parentId) + " > " : "") + d.name : ""; };
	const cases = events.filter(e => ["test:pass", "test:fail"].includes(e.type) && e.data.details.type !== "suite" && e.data.name !== e.data.file)
		.map(e => ({ name: nameOf(e.data.testId) || e.data.name, status: e.data.skip ? "skip" : e.data.todo ? "todo" : e.type === "test:pass" ? "pass" : "fail" }));
	const skippedSuites = events.filter(e => e.type === "test:pass" && e.data?.details?.type === "suite" && e.data.skip)
        .map(e => ({name: nameOf(e.data.testId) || e.data.name, reason: String(e.data.skip)}));
    const summary = events.findLast(e => e.type === "test:summary");
	return { cases, complete: summary?.data.counts.tests === cases.length, ...(skippedSuites.length ? {skippedSuites} : {}) };
}
export function guestCases(text: string) {
	const cases: Case[] = [...text.matchAll(/^(not ok|ok) \d+ - (.*?)( # (?:SKIP|TODO).*)?$/gm)]
		.map(m => ({ name: m[2]!, status: m[3] ? "skip" : m[1] === "ok" ? "pass" : "fail" }));
	const count = /^# tests (\d+)$/m.exec(text);
	const plan = /^1\.\.(\d+)$/m.exec(text);
	return { cases, complete: !!count && Number(count[1]) === cases.length && !!plan && Number(plan[1]) === cases.length };
}
