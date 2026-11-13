// Reports the time zone and default locale that Worker code sees, for
// src/runtime/spawn.test.ts.
export default {
	fetch() {
		return Response.json({
			date: new Date(0).toLocaleDateString(),
			locale: Intl.DateTimeFormat().resolvedOptions().locale,
			number: (1234567.891).toLocaleString(),
			offsetMinutes: new Date(0).getTimezoneOffset(),
			timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		});
	},
};
