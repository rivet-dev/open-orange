// A Worker Loader limit was reached. The message names the limit and the setting that raises it.
export class WorkerLoaderLimitError extends RangeError {
	constructor(message: string) {
		super(message);
		this.name = "WorkerLoaderLimitError";
	}
}
