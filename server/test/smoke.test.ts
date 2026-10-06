import { describe, expect, test } from "bun:test";

describe("workspace smoke", () => {
  test("bun test 运行环境可用", () => {
    expect(1).toBe(1);
  });
});
