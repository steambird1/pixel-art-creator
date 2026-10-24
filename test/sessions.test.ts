import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.js";
import {
  backToTurn,
  countGenerationTurns,
  createSession,
  deleteSession,
  groupTurns,
  listSessions,
  loadSession,
  MAX_SESSION_TITLE,
  normalizeSessionTitle,
  renameSession,
  saveSession,
} from "../src/sessions.js";
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

test("sessions: 同一 groupId 的组图变体算一个逻辑轮次", () => {
  const a = turn(1, 2, 0.01);
  const b = turn(2, 2, 0);
  const c = turn(3, 4, 0.02);
  a.groupId = "g1";
  b.groupId = "g1";

  const groups = groupTurns([a, b, c]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].map((t) => t.index), [1, 2]);
  assert.deepEqual(groups[1].map((t) => t.index), [3]);
  assert.equal(countGenerationTurns([a, b, c]), 2);
});

test("sessions: 会话列表按逻辑轮次计数，并保留图片数", () => {
  const original = config.sessionsDir;
  const dir = mkdtempSync(join(tmpdir(), "drawing-util-sessions-"));
  config.sessionsDir = dir;
  try {
    const s = createSession();
    const a = turn(1, 2, 0.01);
    const b = turn(2, 2, 0);
    const c = turn(3, 4, 0.02);
    a.groupId = "g1";
    b.groupId = "g1";
    s.turns = [a, b, c];
    saveSession(s);

    const summary = listSessions().find((x) => x.id === s.id);
    assert.ok(summary);
    assert.equal(summary!.turns, 2);
    assert.equal(summary!.images, 3);
  } finally {
    config.sessionsDir = original;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sessions: 删除会话会移除 JSON，且拒绝非法 / 不存在 id", () => {
  const original = config.sessionsDir;
  const dir = mkdtempSync(join(tmpdir(), "drawing-util-sessions-"));
  config.sessionsDir = dir;
  try {
    const s = createSession();
    assert.ok(loadSession(s.id));
    assert.equal(deleteSession(s.id), true);
    assert.equal(loadSession(s.id), null);
    assert.equal(deleteSession(s.id), false);
    assert.equal(deleteSession("../bad"), false);
  } finally {
    config.sessionsDir = original;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sessions: 重命名会规范化标题、持久化并出现在列表", () => {
  const original = config.sessionsDir;
  const dir = mkdtempSync(join(tmpdir(), "drawing-util-sessions-"));
  config.sessionsDir = dir;
  try {
    assert.equal(normalizeSessionTitle("  森林 \n 地图  "), "森林 地图");
    assert.equal(normalizeSessionTitle(123), "");

    const s = createSession();
    renameSession(s, "  森林 \n 地图  ");
    assert.equal(s.title, "森林 地图");
    assert.equal(loadSession(s.id)?.title, "森林 地图");
    assert.equal(listSessions().find((x) => x.id === s.id)?.title, "森林 地图");

    renameSession(s, "x".repeat(MAX_SESSION_TITLE + 10));
    assert.equal(s.title.length, MAX_SESSION_TITLE);

    renameSession(s, "");
    assert.equal(loadSession(s.id)?.title, "");
  } finally {
    config.sessionsDir = original;
    rmSync(dir, { recursive: true, force: true });
  }
});
