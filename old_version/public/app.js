/* drawing_util 前端（原生 JS，无构建） */
"use strict";

const $ = (id) => document.getElementById(id);

const MODE_LABEL = { chat: "仅 chat", auto: "自动升级", deep: "深度思考" };
const MODE_STATUS = {
  chat: "正在生成（仅 chat，最快档）…",
  auto: "正在生成（自动升级：快速 → 轻思考 → 深思考）…",
  deep: "正在生成（深度思考，可能需要 20~60 秒甚至更久）…",
};

const state = {
  sessionId: null,
  session: null,   // SessionState
  viewTurn: null,  // 当前查看的 TurnRecord
  busy: false,
};

const PREFS_KEY = "drawing_util_prefs";

/* ---------------- API ---------------- */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/* ---------------- 偏好设置 ---------------- */

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    if (["chat", "auto", "deep"].includes(p.mode)) $("mode").value = p.mode;
    if (Number.isFinite(Number(p.costLimit)) && Number(p.costLimit) >= 0) {
      $("costLimit").value = Number(p.costLimit);
    }
  } catch {
    /* 忽略损坏的本地偏好 */
  }
}

function savePrefs() {
  try {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ mode: $("mode").value, costLimit: Number($("costLimit").value) }),
    );
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

/* ---------------- 会话 ---------------- */

async function refreshSessionList(selectId) {
  const { sessions } = await api("/api/sessions");
  const sel = $("sessionSelect");
  sel.innerHTML = "";
  for (const s of sessions) {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = `会话 ${s.id} · ${s.turns} 轮 · ¥${(s.spend ?? 0).toFixed(3)}`;
    sel.appendChild(opt);
  }
  if (sessions.length === 0) {
    const { session } = await api("/api/session", {
      method: "POST",
      body: { mode: $("mode").value, costLimit: Number($("costLimit").value) },
    });
    await refreshSessionList(session.id);
    return session.id;
  }
  const target = selectId && sessions.some((s) => s.id === selectId) ? selectId : sessions[0].id;
  sel.value = target;
  return target;
}

async function openSession(id) {
  const { session } = await api(`/api/session/${id}`);
  state.sessionId = id;
  state.session = session;
  $("galleryLink").href = `/preview/gallery_${id}.html`;
  $("galleryLink").hidden = false;

  const settings = session.settings ?? { mode: "auto", costLimit: 0.5 };
  $("mode").value = ["chat", "auto", "deep"].includes(settings.mode) ? settings.mode : "auto";
  $("costLimit").value = Number.isFinite(Number(settings.costLimit)) ? Number(settings.costLimit) : 0.5;
  renderSpend();

  renderChat();
  renderHistory();
  const last = session.turns.length ? session.turns[session.turns.length - 1] : null;
  showTurn(last);
}

async function newSession() {
  const { session } = await api("/api/session", {
    method: "POST",
    body: { mode: $("mode").value, costLimit: Number($("costLimit").value) },
  });
  await refreshSessionList(session.id);
  await openSession(session.id);
  scrollChatToBottom();
  $("input").focus();
}

async function saveSettings(patch) {
  if (!state.sessionId) return;
  const { session } = await api(`/api/session/${state.sessionId}/settings`, {
    method: "POST",
    body: patch,
  });
  state.session = session;
  renderSpend();
  await refreshSessionList(state.sessionId);
}

/* ---------------- 费用显示 ---------------- */

function renderSpend() {
  const el = $("spend");
  const spend = state.session?.spend ?? 0;
  const limit = Number($("costLimit").value);
  if (!Number.isFinite(limit) || limit <= 0) {
    el.textContent = `已花 ¥${spend.toFixed(4)} / 不限额`;
    el.classList.remove("near", "over");
    return;
  }
  const pct = spend / limit;
  el.textContent = `已花 ¥${spend.toFixed(4)} / ¥${limit.toFixed(2)}`;
  el.classList.toggle("near", pct >= 0.8 && pct < 1);
  el.classList.toggle("over", pct >= 1);
  el.title = `本会话累计实际费用 ¥${spend.toFixed(4)}，上限 ¥${limit.toFixed(2)}（${(pct * 100).toFixed(1)}%）`;
}

/* ---------------- 聊天渲染 ---------------- */

function bubble(role, text, extra = {}) {
  const div = document.createElement("div");
  div.className = `bubble ${role}`;
  div.textContent = text;
  Object.assign(div.dataset, extra);
  return div;
}

/** 左侧对话滚到最底部（等布局完成后补一次，避免 scrollHeight 过期） */
function scrollChatToBottom() {
  const chat = $("chat");
  chat.scrollTop = chat.scrollHeight;
  requestAnimationFrame(() => {
    chat.scrollTop = chat.scrollHeight;
  });
}

function isCodeText(text) {
  return /img`|CombinedTiles\s*\(/.test(text);
}

/** 把“简要介绍 + 代码”分开；历史里通常只有代码 */
function splitIntroAndCode(text) {
  const idx = text.search(
    /```|img`|new\s+CombinedTiles|(?:export\s+)?const\s+[A-Za-z_$][\w$]*\s*=\s*(?:img`|new\s+CombinedTiles)/,
  );
  if (idx <= 0) return { intro: "", code: text };
  return { intro: text.slice(0, idx).trim(), code: text.slice(idx).trim() };
}

/** 代码输出：可折叠，默认折叠，等宽字体 */
function codeBubble(code, turn) {
  const div = document.createElement("div");
  div.className = "bubble assistant code-wrap";
  const details = document.createElement("details");
  details.className = "code-details";
  const lines = code ? code.split("\n").length : 0;
  const summary = document.createElement("summary");
  summary.textContent = `查看代码 · ${lines} 行（点击展开）`;
  const pre = document.createElement("pre");
  const codeEl = document.createElement("code");
  codeEl.textContent = code;
  pre.appendChild(codeEl);
  details.append(summary, pre);
  div.appendChild(details);
  if (turn) div.dataset.turn = String(turn.index);
  return div;
}

/** 思维链：可折叠，默认折叠 */
function reasoningBubble(reasoning) {
  const div = document.createElement("div");
  div.className = "bubble assistant reasoning-wrap";
  const details = document.createElement("details");
  details.className = "reasoning";
  const summary = document.createElement("summary");
  summary.textContent = `🧠 思考过程 · ${reasoning.length} 字（点击展开）`;
  const pre = document.createElement("pre");
  pre.textContent = reasoning;
  details.append(summary, pre);
  div.appendChild(details);
  return div;
}

function renderChat() {
  const chat = $("chat");
  chat.innerHTML = "";
  const messages = state.session?.messages ?? [];
  if (!messages.length) {
    chat.appendChild(
      bubble(
        "hint",
        "新会话已就绪。默认 16×16，可在消息中指定如 32*32；复杂场景会自动拆分为 16×16 图块。\n" +
          "顶部可切换「仅 chat / 自动升级 / 深度思考」，并设置本会话费用上限。",
      ),
    );
    scrollChatToBottom();
    return;
  }

  // 助手消息下标 -> 该轮记录，用于取 intro / reasoning
  const turnsByMsg = new Map();
  for (const t of state.session?.turns ?? []) {
    if (Number.isFinite(t.msgLen)) turnsByMsg.set(t.msgLen - 1, t);
  }

  messages.forEach((m, i) => {
    if (m.role === "system") return;
    if (m.role === "user") {
      chat.appendChild(bubble("user", m.content));
      return;
    }
    const turn = turnsByMsg.get(i);
    const { intro, code } = splitIntroAndCode(m.content);
    const shownIntro = turn?.intro || intro;
    // 思维链（若有）默认折叠，放在回答之前
    if (turn?.reasoning) chat.appendChild(reasoningBubble(turn.reasoning));
    // AI 的简要介绍：像普通对话一样展示
    if (shownIntro) chat.appendChild(bubble("assistant", shownIntro));
    if (code && isCodeText(code)) chat.appendChild(codeBubble(code, turn));
    else chat.appendChild(bubble("assistant", m.content));
  });

  scrollChatToBottom();
}

/* ---------------- 预览渲染 ---------------- */

function showTurn(turn) {
  state.viewTurn = turn;
  const has = !!turn;
  $("placeholder").hidden = has;
  $("stageInner").hidden = !has;
  $("downloadBtn").hidden = !has;
  $("copyBtn").hidden = !has;
  $("backBtn").hidden = !has;
  $("codeBox").hidden = !has;
  if (!has) {
    $("turnTitle").textContent = "尚未生成";
    $("turnMeta").textContent = "";
    return;
  }
  $("previewImg").src = turn.imageData || turn.png;
  $("turnTitle").textContent = `第 ${turn.index} 轮`;

  const cost = Number.isFinite(turn.cost) ? ` · ¥${turn.cost.toFixed(4)}` : "";
  const tier = turn.tierLabel || MODE_LABEL[turn.mode] || "";
  const tries = turn.attempts > 1 ? ` · ${turn.attempts} 次尝试` : "";
  const time = turn.createdAt?.slice(11, 19) ?? "";
  $("turnMeta").textContent = `${turn.width}×${turn.height}${cost} · ${tier}${tries} · ${time}`;

  $("downloadBtn").href = turn.png;
  $("downloadBtn").download = `turn_${String(turn.index).padStart(3, "0")}.png`;
  $("codePre").textContent = turn.code || "";
  const codeSummary = $("codeBox").querySelector("summary");
  if (codeSummary) {
    const n = turn.code ? turn.code.split("\n").length : 0;
    codeSummary.textContent = `原始代码 · ${n} 行（点击展开）`;
  }
  $("codeBox").open = false;
  updateGridOverlay();
  renderHistoryActive();
}

function updateGridOverlay() {
  const on = $("gridToggle").checked && state.viewTurn;
  $("gridOverlay").hidden = !on;
  if (on) {
    // 预览 img CSS 宽度 320px，按像素宽等分网格线
    const cell = 320 / state.viewTurn.width;
    $("gridOverlay").style.backgroundSize = `${cell}px ${cell}px`;
  }
}

function renderHistory() {
  const box = $("history");
  box.innerHTML = "";
  const turns = state.session?.turns ?? [];
  if (!turns.length) {
    box.innerHTML = '<span class="meta">暂无</span>';
    return;
  }
  for (const t of turns) {
    const fig = document.createElement("figure");
    fig.dataset.turn = t.index;
    fig.title = `${t.width}×${t.height} · ${t.tierLabel ?? MODE_LABEL[t.mode] ?? ""}${Number.isFinite(t.cost) ? ` · ¥${t.cost.toFixed(4)}` : ""}`;
    const img = document.createElement("img");
    img.src = t.png;
    img.alt = `turn ${t.index}`;
    const cap = document.createElement("figcaption");
    cap.textContent = `#${t.index} ${t.width}×${t.height}${Number.isFinite(t.cost) ? ` · ¥${t.cost.toFixed(3)}` : ""}`;
    fig.append(img, cap);
    fig.onclick = () => showTurn(t);
    box.appendChild(fig);
  }
  renderHistoryActive();
}

function renderHistoryActive() {
  document.querySelectorAll("#history figure").forEach((fig) => {
    fig.classList.toggle("active", Number(fig.dataset.turn) === state.viewTurn?.index);
  });
}

/* ---------------- 生成流程 ---------------- */

let statusTimer = null;
let statusStart = 0;
let statusBase = "";

function setStatus(text) {
  const el = $("status");
  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
  el.hidden = !text;
  el.textContent = text || "";
  if (!text) return;
  statusBase = text;
  statusStart = Date.now();
  statusTimer = setInterval(() => {
    const sec = Math.round((Date.now() - statusStart) / 1000);
    el.textContent = `${statusBase}（已 ${sec}s）`;
  }, 1000);
}

function disableErrorActions(container) {
  container.querySelectorAll(".error-actions button").forEach((b) => {
    b.disabled = true;
  });
  container.classList.add("retried");
}

/** 失败气泡：带【按当前档位重试】【升级后重试】两个按钮 */
function appendErrorCard(text, message, data) {
  const div = document.createElement("div");
  div.className = "bubble error error-card";

  const textEl = document.createElement("div");
  textEl.className = "error-text";
  const charged =
    Number(data.cost ?? 0) > 0
      ? `\n本次失败尝试已产生费用 ¥${Number(data.cost).toFixed(4)}（已计入累计）。`
      : "";
  textEl.textContent = `生成失败：${message}${charged}`;
  div.appendChild(textEl);

  const retry = data.retry;
  if (retry) {
    const actions = document.createElement("div");
    actions.className = "error-actions";

    const same = document.createElement("button");
    same.type = "button";
    same.className = "primary";
    same.textContent = `按当前档位重试（${retry.lastTierLabel}）`;
    same.title = "使用刚才失败的档位再试一次（本次只调用 1 次）";
    same.onclick = () => {
      if (state.busy) return;
      disableErrorActions(div);
      send(text, {
        isRetry: true,
        startTier: retry.lastTier,
        tierLabel: retry.lastTierLabel,
        retryError: message,
      });
    };
    actions.appendChild(same);

    const up = document.createElement("button");
    up.type = "button";
    up.textContent = retry.nextTier ? `升级后重试（${retry.nextTierLabel}）` : "已到最高档位";
    up.title = retry.nextTier
      ? "升级到更高档位重试（本次只调用 1 次）"
      : "当前已是最高档位，无法继续升级";
    up.disabled = !retry.nextTier;
    up.onclick = () => {
      if (state.busy || !retry.nextTier) return;
      disableErrorActions(div);
      send(text, {
        isRetry: true,
        startTier: retry.nextTier,
        tierLabel: retry.nextTierLabel,
        retryError: message,
      });
    };
    actions.appendChild(up);
    div.appendChild(actions);
  }

  return div;
}

async function send(text, opts = {}) {
  if (state.busy) return;
  const isRetry = !!opts.isRetry;
  state.busy = true;
  $("sendBtn").disabled = true;
  if (!isRetry) {
    $("chat").appendChild(bubble("user", text));
  }
  scrollChatToBottom();
  setStatus(
    isRetry
      ? `正在用「${opts.tierLabel ?? "原档位"}」重试…`
      : MODE_STATUS[$("mode").value] ?? "正在生成…",
  );

  try {
    const data = await api("/api/chat", {
      method: "POST",
      body: {
        sessionId: state.sessionId,
        message: text,
        scale: Number($("scale").value),
        mode: $("mode").value,
        costLimit: Number($("costLimit").value),
        ...(opts.startTier ? { startTier: opts.startTier } : {}),
        ...(opts.retryError ? { retryError: opts.retryError } : {}),
      },
    });
    // 服务端已写盘：刷新会话拿最新 turns/messages/spend
    await openSession(state.sessionId);
    const errNote = data.repairs?.length
      ? `（模型自动修复 ${data.repairs.length} 次：${data.repairs[data.repairs.length - 1].error}）`
      : "";
    const b = bubble("assistant", `${data.reply} ${errNote}`.trim());
    if (data.gallery) {
      const link = document.createElement("a");
      link.href = data.gallery;
      link.target = "_blank";
      link.className = "turn-link";
      link.textContent = " 打开画廊 →";
      b.appendChild(link);
    }
    $("chat").appendChild(b);
    scrollChatToBottom();
    showTurn(state.session.turns[state.session.turns.length - 1]);
    await refreshSessionList(state.sessionId);
  } catch (e) {
    const data = e.data ?? {};
    if (e.status === 402) {
      const charged =
        Number(data.cost ?? 0) > 0
          ? `\n本次失败尝试已产生费用 ¥${Number(data.cost).toFixed(4)}（已计入累计）。`
          : "";
      $("chat").appendChild(
        bubble(
          "error",
          `💰 费用上限：${e.message}${charged}\n当前已花 ¥${Number(data.spend ?? state.session?.spend ?? 0).toFixed(4)}，上限 ¥${Number(data.limit ?? 0).toFixed(4)}。\n请在顶部调高“费用上限”，或新建会话，或改用更省的模式。`,
        ),
      );
    } else {
      $("chat").appendChild(appendErrorCard(text, e.message, data));
    }
    scrollChatToBottom();
    if (Number.isFinite(Number(data.spend))) {
      state.session.spend = Number(data.spend);
      renderSpend();
    }
  } finally {
    setStatus("");
    state.busy = false;
    $("sendBtn").disabled = false;
    $("input").focus();
  }
}

/* ---------------- 回到此轮 ---------------- */

async function backToThisTurn() {
  if (!state.viewTurn || state.busy) return;
  const idx = state.viewTurn.index;
  if (!confirm(`回到第 ${idx} 轮？其后的轮次记录将被丢弃，会话从该图继续修改。`)) return;
  try {
    await api(`/api/session/${state.sessionId}/back`, { method: "POST", body: { turn: idx } });
    await openSession(state.sessionId);
    $("chat").appendChild(bubble("hint", `已回到第 ${idx} 轮，可在左侧继续输入以修改这张图。`));
    scrollChatToBottom();
    await refreshSessionList(state.sessionId);
  } catch (e) {
    alert(`操作失败：${e.message}`);
  }
}

/* ---------------- 事件绑定 ---------------- */

$("composer").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const text = $("input").value.trim();
  if (!text || state.busy) return;
  $("input").value = "";
  send(text);
});

$("input").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    $("composer").requestSubmit();
  }
});

$("newSessionBtn").addEventListener("click", newSession);

$("sessionSelect").addEventListener("change", (ev) => openSession(ev.target.value));

$("gridToggle").addEventListener("change", updateGridOverlay);
$("backBtn").addEventListener("click", backToThisTurn);

$("copyBtn").addEventListener("click", async () => {
  if (!state.viewTurn) return;
  try {
    await navigator.clipboard.writeText(state.viewTurn.code || "");
    $("copyBtn").textContent = "✅ 已复制";
  } catch {
    $("copyBtn").textContent = "复制失败";
  }
  setTimeout(() => ($("copyBtn").textContent = "📋 复制代码"), 1500);
});

$("scale").addEventListener("change", () => {
  $("chat").appendChild(
    bubble("hint", `放大倍数已切换为 ${$("scale").value}×，对下一次生成生效。`),
  );
  scrollChatToBottom();
});

$("mode").addEventListener("change", async () => {
  savePrefs();
  try {
    await saveSettings({ mode: $("mode").value });
    $("chat").appendChild(bubble("hint", `思考模式已切换为「${MODE_LABEL[$("mode").value]}」，对下一次生成生效。`));
    scrollChatToBottom();
  } catch (e) {
    alert(`保存模式失败：${e.message}`);
  }
});

$("costLimit").addEventListener("change", async () => {
  let v = Number($("costLimit").value);
  if (!Number.isFinite(v) || v < 0) {
    v = 0;
    $("costLimit").value = "0";
  }
  savePrefs();
  renderSpend();
  try {
    await saveSettings({ costLimit: v });
  } catch (e) {
    alert(`保存费用上限失败：${e.message}`);
  }
});

/* ---------------- 启动 ---------------- */

(async function init() {
  try {
    loadPrefs();
    const id = await refreshSessionList();
    await openSession(id);
  } catch (e) {
    $("chat") && $("chat").appendChild(bubble("error", `初始化失败：${e.message}`));
  }
  $("input").focus();
})();
