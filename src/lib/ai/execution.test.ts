import { describe, expect, it } from "vitest";
import { isAiBackgroundExecution, withAiBackgroundExecution, withAiUserExecution } from "./execution";

describe("AI execution context", () => {
  it("tracks unattended work across awaits without leaking to concurrent manual work", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const background = withAiBackgroundExecution(async () => {
      expect(isAiBackgroundExecution()).toBe(true);
      expect(await withAiUserExecution(async () => isAiBackgroundExecution())).toBe(false);
      expect(isAiBackgroundExecution()).toBe(true);
      await gate;
      return isAiBackgroundExecution();
    });
    expect(isAiBackgroundExecution()).toBe(false);
    release();
    expect(await background).toBe(true);
    expect(isAiBackgroundExecution()).toBe(false);
  });
});
