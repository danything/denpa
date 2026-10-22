import { describe, expect, test } from "bun:test";
import { type RowStatus, statusLines, toneOf } from "./row-status";

const line = (
  kind: string,
  tone: RowStatus["tone"],
  extra: Partial<RowStatus> = {},
): RowStatus => ({
  kind,
  tone,
  label: kind,
  detail: `${kind}の理由`,
  ...extra,
});

describe("行の状態の段", () => {
  test("バッジの色から段の色へ。塗ったものは録画中", () => {
    expect(toneOf("solid error")).toBe("rec");
    expect(toneOf("error outline")).toBe("error");
    expect(toneOf("warning")).toBe("warning");
    expect(toneOf("success")).toBe("ok");
    expect(toneOf("")).toBe("neutral");
  });

  test("動いているものが先、問題は重いものから", () => {
    const lines = statusLines(
      [line("encode", "busy")],
      [line("clip", "warning")],
    );
    expect(lines.map((l) => l.kind)).toEqual(["encode", "clip"]);
    const problems = statusLines(
      [],
      [line("saved", "ok"), line("failed", "error")],
    );
    expect(problems.map((l) => l.kind)).toEqual(["failed", "saved"]);
  });

  test("2段に収まらなければ、2段目に残りのラベルをつなぐ。色はいちばん重いもの、中身は落とす", () => {
    const lines = statusLines(
      [line("encode", "busy", { testid: "recording-state" })],
      [
        line("logo", "warning"),
        line("clip", "warning"),
        line("save-failed", "error"),
      ],
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]?.kind).toBe("encode");
    expect(lines[1]).toMatchObject({
      tone: "error",
      label: "save-failed・logo・clip",
      running: false,
    });
    expect(lines[1]?.detail).toBeUndefined();
  });
});
