import { describe, expect, it } from "vitest";
import { validateScheduleUpgrade, type ScheduleUpgrade } from "./index.js";

const valid: ScheduleUpgrade = {
  targetHeight: 50_780_000n,
  major: 2,
  minor: 1,
  successorSha256: new Uint8Array(32).fill(0xab),
};

describe("validateScheduleUpgrade", () => {
  it("accepts a named release with a real pin", () => {
    expect(() => validateScheduleUpgrade(valid)).not.toThrow();
    expect(() => validateScheduleUpgrade({ ...valid, minor: 0 })).not.toThrow();
  });

  it("mirrors the engine's rejections", () => {
    expect(() => validateScheduleUpgrade({ ...valid, major: 0 })).toThrow(
      /major must be a non-zero/,
    );
    expect(() =>
      validateScheduleUpgrade({
        ...valid,
        successorSha256: new Uint8Array(32),
      }),
    ).toThrow(/all-zero/);
    expect(() =>
      validateScheduleUpgrade({
        ...valid,
        successorSha256: new Uint8Array(31).fill(1),
      }),
    ).toThrow(/32 bytes/);
    expect(() => validateScheduleUpgrade({ ...valid, minor: -1 })).toThrow(
      /minor/,
    );
    expect(() =>
      validateScheduleUpgrade({ ...valid, targetHeight: 1n << 64n }),
    ).toThrow(/targetHeight/);
  });
});
