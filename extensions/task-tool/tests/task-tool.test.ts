import { describe, expect, it } from "vitest";

import { normalizeTaskParams } from "../src/task-params.js";

describe("normalizeTaskParams", () => {
	it("accepts single task", () => {
		const result = normalizeTaskParams({ type: "single", tasks: [{ prompt: "Hello" }] });
		expect(result.ok).toBe(true);
	});
});
