import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.js";
import { backToTurn, createSession } from "../src/sessions.js";
import { EMPTY_USAGE } from "../src/pricing.js";
import type { TurnRecord } from "../src/types.js";

function turn(index: number, msgLen: number, cost: number): TurnRecord {
  return {
    index,
    prompt: `turn ${index}`,
    code: `size 16 16\npixel 0 0 1`,
    png: `/preview/test/turn_${index}.png`,
    width: 16,
    height: 16,
    createdAt: new Date().toISOString(),
    msgLen,
    mode: "auto",
    cost,
    usage: { ...EMPTY_USAGE },
    attempts: 1,
  };
}

test("sessions: 回到旧轮次不会扣减累计费用", () => {
  const original = config.sessionsDir;
  const dir = mkdtempSync(join(tmpdir(), "drawing-util-sessions-"));
  config.sessionsDir = dir;
  try {
    const s = createSession();
    s.messages = [
      { role: "user", content: "a" },
      { role: "assistant", content: "a" },
      { role: "user", content: "b" },
      { role: "assistant", content: "b" },
    ];
    s.turns = [turn(1, 2, 0.01), turn(2, 4, 0.02)];
    s.spend = 0.03;

    const updated = backToTurn(s, 1);
    assert.ok(updated);
    assert.equal(updated!.turns.length, 1);
    assert.equal(updated!.turns[0].index, 1);
    // 累计消费保持不变（回滚不退还已花费用）
    assert.equal(updated!.spend, 0.03);
    // 历史截断到该轮生成前
    assert.equal(updated!.messages.length, 2);
  } finally {
    config.sessionsDir = original;
    rmSync(dir, { recursive: true, force: true });
  }
});
