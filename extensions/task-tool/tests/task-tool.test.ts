import { describe, expect, it } from "vitest";

import { normalizeTaskParams } from "../src/task-params.js";

describe("normalizeTaskParams", () => {
	it("accepts single task", () => {
		const result = normalizeTaskParams({ type: "single", tasks: [{ prompt: "Hello" }] });
		expect(result.ok).toBe(true);
	});

	it("defaults fork to true", () => {
		const result = normalizeTaskParams({ type: "single", tasks: [{ prompt: "Hello" }] });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.items[0].fork).toBe(true);
	});

	it("rejects non-boolean fork", () => {
		const result = normalizeTaskParams({
			type: "single",
			tasks: [{ prompt: "Hi", fork: "yes" }],
		});
		expect(result.ok).toBe(false);
	});
});
