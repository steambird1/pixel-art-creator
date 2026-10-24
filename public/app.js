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
  palettes: [],    // 预设调色板
  tilePlan: null,  // 当前轮的智能合并计划
  busy: false,
  dslEditing: false, // 是否正在编辑 DSL（避免误发消息丢失修改）
  dslApplying: false, // 应用 DSL 修改的请求是否进行中
  sizeUnit: "px",  // 画布输入单位：px / tile
  lastSize: { width: 16, height: 16 }, // 最近一次有效的像素尺寸
};

const PREFS_KEY = "drawing_util_prefs";
const PALETTE_SELECT_CUSTOM = "__custom__";

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

const TILE_SIZE = 16;
const MIN_SIZE = 4;
const MAX_SIZE = 256;

function currentSizeUnit() {
  return $("sizeUnit").value === "tile" ? "tile" : "px";
}

/** 根据当前单位设置输入框的取值范围（内部始终使用整数像素） */
function applySizeUnitAttrs() {
  const tile = currentSizeUnit() === "tile";
  const min = tile ? MIN_SIZE / TILE_SIZE : MIN_SIZE;
  const max = tile ? MAX_SIZE / TILE_SIZE : MAX_SIZE;
  for (const id of ["sizeWidth", "sizeHeight"]) {
    const el = $(id);
    el.min = String(min);
    el.max = String(max);
    el.step = tile ? "any" : "1";
    el.setAttribute("inputmode", tile ? "decimal" : "numeric");
    el.setAttribute("aria-label", `${id === "sizeWidth" ? "画布宽度" : "画布高度"}（${tile ? "tiles" : "像素"}）`);
  }
}

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    if (["chat", "auto", "deep"].includes(p.mode)) $("mode").value = p.mode;
    if (Number.isFinite(Number(p.costLimit)) && Number(p.costLimit) >= 0) {
      $("costLimit").value = Number(p.costLimit);
    }
    state.sizeUnit = p.sizeUnit === "tile" ? "tile" : "px";
    $("sizeUnit").value = state.sizeUnit;
    applySizeUnitAttrs();
    if (isValidSize(p.sizeWidth, p.sizeHeight)) {
      setSizeInputs(Number(p.sizeWidth), Number(p.sizeHeight));
    } else {
      setSizeInputs(state.lastSize.width, state.lastSize.height);
    }
  } catch {
    /* 忽略损坏的本地偏好 */
  }
}

function savePrefs() {
  try {
    const size = readTargetSize();
    if (size) state.lastSize = size;
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        mode: $("mode").value,
        costLimit: Number($("costLimit").value),
        sizeUnit: currentSizeUnit(),
        sizeWidth: state.lastSize.width,
        sizeHeight: state.lastSize.height,
      }),
    );
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

function isValidSize(w, h) {
  return (
    Number.isInteger(Number(w)) &&
    Number.isInteger(Number(h)) &&
    Number(w) >= MIN_SIZE &&
    Number(h) >= MIN_SIZE &&
    Number(w) <= MAX_SIZE &&
    Number(h) <= MAX_SIZE
  );
}

function setSizeInputs(w, h) {
  if (!isValidSize(w, h)) return;
  const tile = currentSizeUnit() === "tile";
  $("sizeWidth").value = tile ? String(w / TILE_SIZE) : String(w);
  $("sizeHeight").value = tile ? String(h / TILE_SIZE) : String(h);
  state.lastSize = { width: w, height: h };
  updateSizeHint();
}

function updateSizeHint() {
  const el = $("sizeHint");
  const unit = currentSizeUnit();
  const size = readTargetSize();
  if (!size) {
    el.textContent = unit === "tile"
      ? `（${MIN_SIZE / TILE_SIZE}–${MAX_SIZE / TILE_SIZE} tiles = ${MIN_SIZE}–${MAX_SIZE} px）`
      : `（${MIN_SIZE}–${MAX_SIZE} px）`;
    el.classList.add("bad");
    return;
  }
  el.classList.remove("bad");
  if (unit === "tile") {
    el.textContent = `= ${size.width}×${size.height} px`;
  } else {
    const tilesW = Math.ceil(size.width / TILE_SIZE);
    const tilesH = Math.ceil(size.height / TILE_SIZE);
    const exact = size.width % TILE_SIZE === 0 && size.height % TILE_SIZE === 0;
    el.textContent = `${tilesW}×${tilesH} tiles${exact ? "" : "（含边缘）"}`;
  }
}

/**
 * 读取 UI 指定尺寸，返回整数像素。
 * unit 可显式传入旧单位，用于切换单位时先按旧单位换算。
 */
function readTargetSize(unit = currentSizeUnit()) {
  const rawW = Number($("sizeWidth").value);
  const rawH = Number($("sizeHeight").value);
  if (!Number.isFinite(rawW) || !Number.isFinite(rawH)) return null;
  let w;
  let h;
  if (unit === "tile") {
    w = Math.round(rawW * TILE_SIZE);
    h = Math.round(rawH * TILE_SIZE);
  } else {
    if (!Number.isInteger(rawW) || !Number.isInteger(rawH)) return null;
    w = rawW;
    h = rawH;
  }
  return isValidSize(w, h) ? { width: w, height: h } : null;
}

/* ---------------- 调色板 / 组图 ---------------- */

function paletteLabel(p) {
  return p?.label || p?.name || "默认";
}

function currentPalette() {
  return state.session?.settings?.palette ?? state.palettes.find((p) => p.name === "default") ?? null;
}

function fillPaletteSelect(sel, selectedName, includeCustom = true) {
  sel.innerHTML = "";
  for (const p of state.palettes) {
    const opt = document.createElement("option");
    opt.value = p.name;
    opt.textContent = p.label;
    sel.appendChild(opt);
  }
  if (includeCustom) {
    const opt = document.createElement("option");
    opt.value = PALETTE_SELECT_CUSTOM;
    opt.textContent = "自定义…";
    sel.appendChild(opt);
  }
  if (selectedName && ![...sel.options].some((o) => o.value === selectedName)) {
    const opt = document.createElement("option");
    opt.value = selectedName;
    opt.textContent = selectedName;
    sel.appendChild(opt);
  }
  sel.value = selectedName || "default";
}

async function loadPalettes() {
  const { palettes } = await api("/api/palettes");
  state.palettes = palettes;
  fillPaletteSelect($("palette"), currentPalette()?.name || "default");
  renderGroupPaletteSelects();
}

function fillCustomSwatches(colors) {
  const box = $("customSwatches");
  if (box.children.length !== 15) {
    box.innerHTML = "";
    for (let i = 0; i < 15; i++) {
      const input = document.createElement("input");
      input.type = "color";
      input.dataset.slot = String(i);
      input.title = `槽 ${(i + 1).toString(16)}`;
      box.appendChild(input);
    }
  }
  if (Array.isArray(colors)) {
    [...box.children].forEach((el, i) => {
      el.value = (colors[i] || "#000000").toLowerCase();
    });
  }
}

function setPaletteControls() {
  const p = currentPalette();
  const isPreset = state.palettes.some((x) => x.name === p?.name);
  fillPaletteSelect($("palette"), isPreset ? p.name : PALETTE_SELECT_CUSTOM);
  $("customPalette").hidden = isPreset;
  if (!isPreset) fillCustomSwatches(p?.colors);
  renderGroupPaletteSelects();
  markActivePaletteVariant();
}

function renderGroupPaletteSelects() {
  const box = $("groupPalettes");
  const on = $("groupToggle").checked && $("groupPerPalette").checked && !$("groupAiPalette").checked;
  if (!on) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  const count = Math.max(1, Math.min(9, Number($("groupCount").value) || 4));
  const previous = [...box.querySelectorAll("select")].map((s) => s.value);
  box.innerHTML = "";
  for (let i = 0; i < count; i++) {
    const label = document.createElement("label");
    label.textContent = `#${i + 1}`;
    const sel = document.createElement("select");
    fillPaletteSelect(sel, previous[i] || currentPalette()?.name || "default", false);
    label.appendChild(sel);
    box.appendChild(label);
  }
  box.hidden = false;
}

async function applyPalette(ref, opts = {}) {
  if (!state.sessionId) return;
  try {
    const { session } = await api(`/api/session/${state.sessionId}/palette`, {
      method: "POST",
      body: { palette: ref },
    });
    state.session = session;
    setPaletteControls();
    renderHistory();
    const keep = state.viewTurn ? state.session.turns.find((t) => t.index === state.viewTurn.index) : null;
    showTurn(keep ?? state.session.turns[state.session.turns.length - 1] ?? null);
    await refreshSessionList(state.sessionId);
    if (!opts.quiet) {
      $("chat").appendChild(bubble("hint", `调色板已切换为「${paletteLabel(session.settings.palette)}」。`));
      scrollChatToBottom();
    }
  } catch (e) {
    alert(`切换调色板失败：${e.message}`);
  }
}

function markActivePaletteVariant() {
  const name = currentPalette()?.name;
  document.querySelectorAll("#paletteVariants figure").forEach((fig) => {
    fig.classList.toggle("active", fig.dataset.name === name);
  });
}

async function loadPaletteVariants() {
  if (!state.viewTurn || !state.sessionId) {
    $("paletteHint").textContent = "先查看某一轮再生成变体。";
    return;
  }
  const explicit = state.viewTurn.paletteSource === "explicit";
  const box = $("paletteVariants");
  box.innerHTML = '<span class="meta">正在渲染…</span>';
  try {
    const data = await api(
      `/api/session/${state.sessionId}/turn/${state.viewTurn.index}/palette-preview`,
      { method: "POST", body: {} },
    );
    box.innerHTML = "";
    for (const v of data.variants) {
      const fig = document.createElement("figure");
      fig.dataset.name = v.name;
      const img = document.createElement("img");
      img.src = v.image;
      img.alt = v.label;
      const cap = document.createElement("figcaption");
      cap.textContent = v.label;
      fig.append(img, cap);
      if (!explicit) fig.onclick = () => applyPalette({ name: v.name, colors: v.colors });
      box.appendChild(fig);
    }
    $("paletteHint").textContent = explicit
      ? `该轮使用独立调色板（${paletteLabel(state.viewTurn.palette)}）；变体仅预览，顶部切换只影响会话轮次。`
      : `同一构图 × ${data.variants.length} 个调色板（${data.previewScale}× 预览）`;
    markActivePaletteVariant();
  } catch (e) {
    box.innerHTML = "";
    $("paletteHint").textContent = `渲染失败：${e.message}`;
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
    const turns = Number(s.turns ?? 0);
    const images = Number(s.images ?? turns);
    const count = images > turns ? `${turns} 轮 / ${images} 图` : `${turns} 轮`;
    opt.textContent = `会话 ${s.id} · ${count} · ¥${(s.spend ?? 0).toFixed(3)}`;
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
  if (!$("mergePreview").hidden) closeMergePreview();
  const { session } = await api(`/api/session/${id}`);
  state.sessionId = id;
  state.session = session;
  $("galleryLink").href = `/preview/gallery_${id}.html`;
  $("galleryLink").hidden = false;

  const settings = session.settings ?? { mode: "auto", costLimit: 0.5 };
  $("mode").value = ["chat", "auto", "deep"].includes(settings.mode) ? settings.mode : "auto";
  $("costLimit").value = Number.isFinite(Number(settings.costLimit)) ? Number(settings.costLimit) : 0.5;
  setPaletteControls();
  $("paletteVariants").innerHTML = "";
  $("paletteHint").textContent = "同一构图，仅更换调色板（不调用模型）";
  renderSpend();

  renderChat();
  renderHistory();
  const last = session.turns.length ? session.turns[session.turns.length - 1] : null;
  // 打开会话时把 UI 尺寸同步到最后一轮；新会话保留本地偏好
  if (last) setSizeInputs(last.width, last.height);
  updateSizeHint();
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

async function deleteCurrentSession() {
  if (!state.sessionId || state.busy) return;
  const id = state.sessionId;
  const images = state.session?.turns?.length ?? 0;
  const dsl = state.dslEditing ? "\n当前未应用的 DSL 修改也会丢失。" : "";
  if (
    !confirm(
      `删除会话 ${id}（${images} 条变体记录）？\n会话 JSON、预览图和画廊都会被删除，且不可恢复。${dsl}`,
    )
  ) {
    return;
  }
  state.busy = true;
  $("deleteSessionBtn").disabled = true;
  $("sendBtn").disabled = true;
  try {
    await api(`/api/session/${id}`, { method: "DELETE" });
    state.sessionId = null;
    state.session = null;
    state.viewTurn = null;
    state.dslEditing = false;
    state.dslApplying = false;
    $("galleryLink").hidden = true;
    const nextId = await refreshSessionList();
    await openSession(nextId);
    scrollChatToBottom();
    $("input").focus();
  } catch (e) {
    alert(`删除会话失败：${e.message}`);
  } finally {
    state.busy = false;
    $("deleteSessionBtn").disabled = false;
    $("sendBtn").disabled = false;
  }
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
  el.title =
    `本会话累计实际费用 ¥${spend.toFixed(4)}（回滚对话不会退还），` +
    `上限 ¥${limit.toFixed(2)}（${(pct * 100).toFixed(1)}%）`;
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
  return /img`|CombinedTiles\s*\(|```[ \t]*dsl\b|(?:^|\n)\s*(?:size|canvas)\s*:?\s*\d{1,3}\s*(?:[x*×]\s*|\s+)\d{1,3}/i.test(
    text,
  );
}

/** 把“简要介绍 + 代码”分开；历史里通常只有代码 */
function splitIntroAndCode(text) {
  const idx = text.search(
    /```|img`|new\s+CombinedTiles|(?:^|\n)\s*(?:size|canvas)\s*:?\s*\d{1,3}\s*(?:[x*×]\s*|\s+)\d{1,3}|(?:export\s+)?const\s+[A-Za-z_$][\w$]*\s*=\s*(?:img`|new\s+CombinedTiles)/i,
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
  const label = turn?.dsl ? "查看 JS" : "查看代码";
  const summary = document.createElement("summary");
  summary.textContent = `${label} · ${lines} 行（点击展开）`;
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
    // 组图的多个变体共享同一条助手消息；优先用第一个变体展示介绍/思维链/成本
    if (Number.isFinite(t.msgLen) && !turnsByMsg.has(t.msgLen - 1)) turnsByMsg.set(t.msgLen - 1, t);
  }

  messages.forEach((m, i) => {
    if (m.role === "system") return;
    if (m.role === "user") {
      chat.appendChild(bubble("user", m.content));
      return;
    }
    const turn = turnsByMsg.get(i);
    // 有 turn 时直接用主产物 JS，避免把 JS 注释误判成“介绍”
    const displayCode = turn?.code || m.content;
    const { intro, code } = turn ? { intro: "", code: displayCode } : splitIntroAndCode(displayCode);
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

function turnImageUrl(turn) {
  const v = turn.updatedAt || turn.createdAt || "";
  return v ? `${turn.png}?v=${encodeURIComponent(v)}` : turn.png;
}

/** 组图变体在数据层仍是多条 TurnRecord；这里只在展示层合并成逻辑轮次 */
function historyGroups() {
  const groups = [];
  const byId = new Map();
  for (const t of state.session?.turns ?? []) {
    if (t.groupId) {
      const existing = byId.get(t.groupId);
      if (existing) {
        existing.variants.push(t);
        continue;
      }
    }
    const group = { groupId: t.groupId ?? null, variants: [t] };
    groups.push(group);
    if (t.groupId) byId.set(t.groupId, group);
  }
  const labels = new Map();
  groups.forEach((group, groupIndex) => {
    group.variants.forEach((t, variantIndex) => {
      labels.set(t.index, {
        group,
        groupIndex: groupIndex + 1,
        variantIndex: variantIndex + 1,
        variantCount: group.variants.length,
      });
    });
  });
  return { groups, labels };
}

function groupInfoFor(turn) {
  if (!turn) return null;
  return historyGroups().labels.get(turn.index) ?? null;
}

function turnDisplayLabel(turn, info = groupInfoFor(turn)) {
  if (!turn) return "";
  const groupIndex = info?.groupIndex ?? turn.index;
  return info && info.variantCount > 1
    ? `第 ${groupIndex} 轮 · 组图 ${info.variantIndex}/${info.variantCount}`
    : `第 ${groupIndex} 轮`;
}

function setDslEditMode(editing) {
  state.dslEditing = !!editing;
  const turn = state.viewTurn;
  const can = !!turn?.dsl;
  $("dslPre").hidden = !!editing;
  $("dslEditArea").hidden = !editing;
  $("dslEditBtn").hidden = !!editing || !can;
  $("dslSaveBtn").hidden = !editing;
  $("dslCancelBtn").hidden = !editing;
  $("dslEditHint").textContent = editing
    ? "修改不会立即生效 · Ctrl+Enter 应用 · Esc 撤销更改（不调用模型，不计费）"
    : "修改只在点击“应用更改”后生效；不调用模型，不计费";
  $("dslError").hidden = true;
  $("dslError").textContent = "";
}

function showTurn(turn) {
  state.viewTurn = turn;
  const has = !!turn;
  $("placeholder").hidden = has;
  $("stageInner").hidden = !has;
  $("downloadBtn").hidden = !has;
  $("copyBtn").hidden = !has;
  $("copyBtn").textContent = "📋 复制 JS";
  $("copyCodeBtn").textContent = "📋 复制代码";
  $("backBtn").hidden = !has;
  $("codeBox").hidden = !has;
  $("dslBox").hidden = !has || !turn?.dsl;
  if (!has) {
    setDslEditMode(false);
    $("turnTitle").textContent = "尚未生成";
    $("turnMeta").textContent = "";
    $("tileInfo").hidden = true;
    $("tileBox").hidden = true;
    $("groupVariants").hidden = true;
    $("groupVariants").innerHTML = "";
    return;
  }
  const info = groupInfoFor(turn);
  $("previewImg").src = turn.imageData || turnImageUrl(turn);
  $("turnTitle").textContent = turnDisplayLabel(turn, info);

  const cost = Number.isFinite(turn.cost) ? ` · ¥${turn.cost.toFixed(4)}` : "";
  const tier = turn.source === "trace" ? "本地描摹" : turn.tierLabel || MODE_LABEL[turn.mode] || "";
  const tries = turn.attempts > 1 ? ` · ${turn.attempts} 次尝试` : "";
  const tiles = turn.tileStats ? ` · ${turn.tileStats.total} tiles` : "";
  const palette = turn.palette ? ` · ${paletteLabel(turn.palette)}` : "";
  const edited = turn.editedAt ? " · 手动编辑" : "";
  const scale = turn.scale ? ` · ${turn.scale}×` : "";
  const time = turn.createdAt?.slice(11, 19) ?? "";
  $("turnMeta").textContent = `${turn.width}×${turn.height}${cost} · ${tier}${tries}${tiles}${palette}${edited}${scale} · ${time}`;

  $("downloadBtn").href = turnImageUrl(turn);
  $("downloadBtn").download = `turn_${String(turn.index).padStart(3, "0")}.png`;
  $("codePre").textContent = turn.code || "";
  const codeSummary = $("codeBox").querySelector("summary");
  if (codeSummary) {
    const n = turn.code ? turn.code.split("\n").length : 0;
    codeSummary.textContent = `JavaScript 代码 · ${n} 行（点击展开）`;
  }
  $("codeBox").open = false;

  $("dslPre").textContent = turn.dsl || "";
  $("dslBox").hidden = !turn.dsl;
  $("dslBox").open = false;
  setDslEditMode(false);

  renderTileInfo(turn);
  updateGridOverlay();
  renderGroupVariants(turn, info);
  renderHistoryActive();
}

function renderGroupVariants(turn, info = groupInfoFor(turn)) {
  const box = $("groupVariants");
  box.innerHTML = "";
  if (!turn || !info || info.variantCount <= 1) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  info.group.variants.forEach((variant, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = variant.index === turn.index ? "active" : "";
    const pal = variant.palette ? paletteLabel(variant.palette) : "";
    btn.title = `${turnDisplayLabel(variant, { ...info, variantIndex: i + 1 })} · ${variant.width}×${variant.height}${pal ? ` · ${pal}` : ""}`;
    const img = document.createElement("img");
    img.src = turnImageUrl(variant);
    img.alt = `组图变体 ${i + 1}`;
    const label = document.createElement("span");
    label.textContent = `${i + 1}/${info.variantCount}${pal ? ` ${pal}` : ""}`;
    btn.append(img, label);
    btn.onclick = () => showTurn(variant);
    box.appendChild(btn);
  });
}

function renderTileInfo(turn) {
  const info = $("tileInfo");
  const box = $("tileBox");
  const groups = $("tileGroups");
  const ts = turn?.tileStats;
  groups.innerHTML = "";
  $("tilePlanGroups").innerHTML = "";
  $("tilePlanStats").textContent = "";
  state.tilePlan = null;
  if (!ts) {
    info.hidden = true;
    box.hidden = true;
    return;
  }
  info.hidden = false;
  const mergeInfo = turn.mergePlan
    ? ` · 合并 ε=${Math.round(turn.mergePlan.epsilon)}`
    : turn.merged
      ? " · 已手动合并"
      : "";
  info.textContent =
    `${ts.total} tiles · ${ts.unique} unique · ${ts.reused} reused` +
    (ts.nearGroups.length ? ` · ${ts.nearGroups.length} 组相似` : "") +
    mergeInfo;
  box.hidden = false;
  box.open = false;

  $("tileUndoBtn").hidden = !(
    turn.mergePlan ||
    (turn.merged && (turn.baseCode || turn.dsl))
  );
  const eps = Number.isFinite(ts.epsilon) ? ts.epsilon : 600;
  $("tileEpsilon").value = String(eps);
  $("tileEpsilonVal").textContent = String(Math.round(eps));

  if (!ts.nearGroups.length) {
    const p = document.createElement("div");
    p.className = "tile-note";
    p.textContent = "当前画面没有发现相似 tile（相同 tile 已自动复用）。";
    groups.appendChild(p);
    return;
  }

  for (const g of ts.nearGroups) {
    const row = document.createElement("div");
    row.className = "tile-group";
    const span = document.createElement("span");
    const members = g.members.map((m) => `tile${m}`).join(", ");
    const err = Number.isFinite(g.maxError) ? g.maxError : g.maxDiff;
    span.textContent =
      `tile${g.representative} ↔ ${members} · 最大差异 ${g.maxDiff} 像素 · ` +
      `ε ${Math.round(err)} · 共 ${g.usage} 次`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "预览合并…";
    btn.title = `查看用 tile${g.representative} 替换 ${members} 的前后变化`;
    btn.onclick = () => openMergePreview(turn, g);
    row.appendChild(span);
    if (!turn.mergePlan) row.appendChild(btn);
    groups.appendChild(row);
  }
}

let tilePlanTimer = null;
let tilePlanSeq = 0;

async function loadTilePlan(turn, epsilon) {
  if (!turn || !state.sessionId) return;
  const seq = ++tilePlanSeq;
  const hasEps =
    epsilon !== undefined &&
    epsilon !== null &&
    String(epsilon) !== "" &&
    Number.isFinite(Number(epsilon));
  $("tilePlanStats").textContent = "正在分析…";
  try {
    const data = await api(`/api/session/${state.sessionId}/turn/${turn.index}/tile-plan`, {
      method: "POST",
      body: hasEps ? { epsilon: Number(epsilon) } : {},
    });
    if (seq !== tilePlanSeq) return;
    state.tilePlan = data;
    const maxErr = Math.max(1, ...data.curve.map((p) => p.maxError));
    const slider = $("tileEpsilon");
    slider.max = String(Math.ceil(Math.max(maxErr, Number(data.epsilon)) * 1.1));
    slider.value = String(data.epsilon);
    $("tileEpsilonVal").textContent = String(Math.round(data.epsilon));
    drawTileCurve(data);
    $("tilePlanStats").textContent =
      `unique ${data.uniqueBefore} → ${data.uniqueAfter} · ${data.groups.length} 组可合并 · ` +
      `拐点 ε≈${Math.round(data.knee)} · 当前 ε=${Math.round(data.epsilon)}`;
    renderPlanGroups(data);
  } catch (e) {
    if (seq === tilePlanSeq) $("tilePlanStats").textContent = `分析失败：${e.message}`;
  }
}

function drawTileCurve(plan) {
  const canvas = $("tileCurve");
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  const pad = 10;
  ctx.clearRect(0, 0, w, h);
  const curve = plan.curve ?? [];
  if (!curve.length) return;
  const maxE = Math.max(1, ...curve.map((p) => p.maxError));
  const x = (i) => pad + (curve.length <= 1 ? 0 : (i / (curve.length - 1)) * (w - pad * 2));
  const y = (e) => pad + (1 - Math.min(1, e / maxE)) * (h - pad * 2);

  ctx.strokeStyle = "#2e2e40";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad, pad);
  ctx.lineTo(pad, h - pad);
  ctx.lineTo(w - pad, h - pad);
  ctx.stroke();

  ctx.strokeStyle = "#87F2FF";
  ctx.lineWidth = 2;
  ctx.beginPath();
  curve.forEach((p, i) => {
    const px = x(i);
    const py = y(p.maxError);
    if (i) ctx.lineTo(px, py);
    else ctx.moveTo(px, py);
  });
  ctx.stroke();

  const kneeIdx = curve.findIndex((p) => Math.abs(p.maxError - plan.knee) < 1e-6);
  if (kneeIdx >= 0) {
    ctx.fillStyle = "#FF93C4";
    ctx.beginPath();
    ctx.arc(x(kneeIdx), y(curve[kneeIdx].maxError), 4, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.strokeStyle = "#78DC52";
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(pad, y(plan.epsilon));
  ctx.lineTo(w - pad, y(plan.epsilon));
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = "#8f8fa8";
  ctx.font = "10px Consolas, monospace";
  ctx.fillText(`unique ${curve[0].clusters}`, pad, h - 2);
  ctx.fillText(`unique ${curve[curve.length - 1].clusters}`, w - pad - 62, h - 2);
  ctx.fillText(`ε ${Math.round(maxE)}`, 2, pad + 8);
}

function renderPlanGroups(plan) {
  const box = $("tilePlanGroups");
  box.innerHTML = "";
  if (!plan.groups.length) {
    const p = document.createElement("div");
    p.className = "tile-note";
    p.textContent = "当前 ε 下没有可合并的组。";
    box.appendChild(p);
    return;
  }
  for (const g of plan.groups) {
    const row = document.createElement("div");
    row.className = "tile-group";
    const span = document.createElement("span");
    const members = g.members.map((m) => `tile${m}`).join(", ");
    span.textContent =
      `tile${g.representative} ↔ ${members} · ε ${Math.round(g.maxError)} · ` +
      `平均 ${g.meanError.toFixed(1)} · 共 ${g.usage} 次`;
    row.appendChild(span);
    box.appendChild(row);
  }
}

async function openBatchPreview(turn, epsilon) {
  if (!turn || state.busy || mergePreviewLoading) return;
  const eps = Number.isFinite(Number(epsilon))
    ? Number(epsilon)
    : Number($("tileEpsilon").value) || 600;
  mergePreviewLoading = true;
  mergePreviewCtx = { turn, batch: { epsilon: eps } };
  $("mergePreview").hidden = false;
  $("mergeTitle").textContent = `批量合并预览（ε=${Math.round(eps)}）`;
  $("mergeStats").textContent = "正在生成预览…";
  resetMergePreviewImages();
  $("mergeConfirm").disabled = true;
  $("mergeConfirm").textContent = "生成中…";

  try {
    const p = await api(
      `/api/session/${state.sessionId}/turn/${turn.index}/preview-merge-batch`,
      { method: "POST", body: { epsilon: eps } },
    );
    $("mergeBefore").src = p.before;
    $("mergeAfter").src = p.after;
    $("mergeDiff").src = p.diff;
    const b = p.bounds ?? { x: 0, y: 0, w: 0, h: 0 };
    $("mergeStats").textContent =
      `将合并 ${p.groups.length} 组；改变 ${p.changedPixels} 个像素（${p.changedTiles} 个 tile）；` +
      `unique ${p.uniqueBefore} → ${p.uniqueAfter}，reused ${p.reusedBefore} → ${p.reusedAfter}；` +
      `差异范围 ${b.w}×${b.h}（预览 ${p.previewScale}×）`;
    $("mergeConfirm").disabled = p.groups.length === 0;
    $("mergeConfirm").textContent = p.groups.length ? "确认批量合并" : "无可合并";
  } catch (e) {
    $("mergeStats").textContent = `预览失败：${e.message}`;
    $("mergeConfirm").disabled = true;
    $("mergeConfirm").textContent = "确认批量合并";
  } finally {
    mergePreviewLoading = false;
  }
}

async function undoMergePlan() {
  if (!state.viewTurn || state.busy) return;
  const index = state.viewTurn.index;
  const label = turnDisplayLabel(state.viewTurn);
  if (!confirm(`撤销${label} 的合并，恢复基准画面？`)) return;
  state.busy = true;
  try {
    await api(`/api/session/${state.sessionId}/turn/${index}/merge-plan/undo`, { method: "POST" });
    await openSession(state.sessionId);
    const updated = state.session.turns.find((t) => t.index === index);
    if (updated) showTurn(updated);
    await refreshSessionList(state.sessionId);
  } catch (e) {
    alert(`撤销失败：${e.message}`);
  } finally {
    state.busy = false;
  }
}

let mergePreviewCtx = null;
let mergePreviewLoading = false;

function resetMergePreviewImages() {
  for (const id of ["mergeBefore", "mergeAfter", "mergeDiff"]) {
    $(id).removeAttribute("src");
  }
}

async function openMergePreview(turn, group) {
  if (state.busy || mergePreviewLoading) return;
  mergePreviewLoading = true;
  mergePreviewCtx = { turn, group };
  $("mergePreview").hidden = false;
  $("mergeTitle").textContent =
    `合并预览：tile${group.representative} ← ${group.members.map((m) => `tile${m}`).join(", ")}`;
  $("mergeStats").textContent = "正在生成预览…";
  resetMergePreviewImages();
  $("mergeConfirm").disabled = true;
  $("mergeConfirm").textContent = "生成中…";

  try {
    const p = await api(
      `/api/session/${state.sessionId}/turn/${turn.index}/preview-merge-tiles`,
      {
        method: "POST",
        body: { representative: group.representative, members: group.members },
      },
    );
    $("mergeBefore").src = p.before;
    $("mergeAfter").src = p.after;
    $("mergeDiff").src = p.diff;
    const b = p.bounds ?? { x: 0, y: 0, w: 0, h: 0 };
    $("mergeStats").textContent =
      `将改变 ${p.changedPixels} 个像素，涉及 ${p.changedTiles} 个 tile；` +
      `unique ${p.uniqueBefore} → ${p.uniqueAfter}，reused ${p.reusedBefore} → ${p.reusedAfter}；` +
      `差异范围 ${b.w}×${b.h}（x=${b.x}, y=${b.y}，预览 ${p.previewScale}×）`;
    $("mergeConfirm").disabled = false;
    $("mergeConfirm").textContent = "确认合并";
  } catch (e) {
    $("mergeStats").textContent = `预览失败：${e.message}`;
    $("mergeConfirm").disabled = true;
    $("mergeConfirm").textContent = "确认合并";
  } finally {
    mergePreviewLoading = false;
  }
}

function closeMergePreview() {
  $("mergePreview").hidden = true;
  mergePreviewCtx = null;
  resetMergePreviewImages();
}

async function confirmMergePreview() {
  if (!mergePreviewCtx || state.busy) return;
  const { turn, group, batch } = mergePreviewCtx;
  if (!group && !batch) return;
  state.busy = true;
  $("mergeConfirm").disabled = true;
  $("mergeConfirm").textContent = "合并中…";

  try {
    if (batch) {
      await api(`/api/session/${state.sessionId}/turn/${turn.index}/merge-tiles-batch`, {
        method: "POST",
        body: { epsilon: batch.epsilon },
      });
    } else {
      await api(`/api/session/${state.sessionId}/turn/${turn.index}/merge-tiles`, {
        method: "POST",
        body: { representative: group.representative, members: group.members },
      });
    }
    closeMergePreview();
    await openSession(state.sessionId);
    const updated = state.session.turns.find((t) => t.index === turn.index);
    if (updated) showTurn(updated);
    await refreshSessionList(state.sessionId);
  } catch (e) {
    alert(`合并失败：${e.message}`);
    $("mergeConfirm").disabled = false;
    $("mergeConfirm").textContent = batch ? "确认批量合并" : "确认合并";
  } finally {
    state.busy = false;
  }
}

function updateGridOverlay() {
  const turn = state.viewTurn;
  const showPixels = $("gridToggle").checked && !!turn;
  const showTiles = $("tileGridToggle").checked && !!turn;
  $("gridOverlay").hidden = !showPixels;
  $("tileOverlay").hidden = !showTiles;
  if (!turn) return;

  // 预览 img CSS 宽度固定为 320px；按实际显示宽度等分，避免缩放后错位
  const displayWidth = $("previewImg").clientWidth || 320;
  const cell = displayWidth / turn.width;
  if (showPixels) {
    $("gridOverlay").style.backgroundSize = `${cell}px ${cell}px`;
  }
  if (showTiles) {
    const tileCell = cell * TILE_SIZE;
    $("tileOverlay").style.backgroundSize = `${tileCell}px ${tileCell}px`;
    $("tileOverlay").title =
      `${Math.ceil(turn.width / TILE_SIZE)}×${Math.ceil(turn.height / TILE_SIZE)} tiles`;
  }
}

function renderHistory() {
  const box = $("history");
  box.innerHTML = "";
  const { groups } = historyGroups();
  if (!groups.length) {
    box.innerHTML = '<span class="meta">暂无</span>';
    return;
  }
  groups.forEach((group, groupIndex) => {
    const first = group.variants[0];
    const count = group.variants.length;
    const shown = first;
    const pal = shown.palette ? ` · ${paletteLabel(shown.palette)}` : "";
    const tier = shown.source === "trace" ? "本地描摹" : shown.tierLabel ?? MODE_LABEL[shown.mode] ?? "";
    const tiles = shown.tileStats ? ` · ${shown.tileStats.total} tiles` : "";
    const cost = group.variants.reduce((sum, t) => sum + (Number.isFinite(t.cost) ? t.cost : 0), 0);
    const title = `第 ${groupIndex + 1} 轮${count > 1 ? ` · 组图 ${count} 张` : ""} · ${shown.width}×${shown.height} · ${tier}${tiles}${pal}${Number.isFinite(cost) ? ` · ¥${cost.toFixed(4)}` : ""}`;

    const fig = document.createElement("figure");
    fig.dataset.turns = group.variants.map((t) => t.index).join(",");
    fig.dataset.group = group.groupId ?? "";
    fig.title = title;
    if (count > 1) fig.classList.add("grouped");

    const img = document.createElement("img");
    img.src = turnImageUrl(shown);
    img.alt = count > 1 ? `第 ${groupIndex + 1} 轮组图` : `turn ${first.index}`;
    const cap = document.createElement("figcaption");
    cap.textContent =
      `第 ${groupIndex + 1} 轮${count > 1 ? ` · 组图 ${count} 张` : ""} · ${shown.width}×${shown.height}${pal}` +
      (Number.isFinite(cost) ? ` · ¥${cost.toFixed(3)}` : "");
    fig.append(img, cap);

    if (count > 1) {
      const badge = document.createElement("span");
      badge.className = "group-badge";
      badge.textContent = `×${count}`;
      fig.appendChild(badge);
    }

    fig.onclick = () => {
      const idx = state.viewTurn?.index;
      const active = idx === undefined ? null : group.variants.find((t) => t.index === idx);
      showTurn(active ?? first);
    };
    box.appendChild(fig);
  });
  renderHistoryActive();
}

function renderHistoryActive() {
  const current = state.viewTurn?.index;
  document.querySelectorAll("#history figure").forEach((fig) => {
    const indices = (fig.dataset.turns || "").split(",").map(Number);
    fig.classList.toggle("active", Number.isFinite(current) && indices.includes(current));
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
  if (state.dslEditing) {
    alert("请先保存或取消 DSL 编辑，再发送新消息。");
    return;
  }
  const targetSize = readTargetSize();
  if (!targetSize) {
    alert(
      currentSizeUnit() === "tile"
        ? `画布尺寸必须是 ${MIN_SIZE / TILE_SIZE}–${MAX_SIZE / TILE_SIZE} tiles（对应 ${MIN_SIZE}–${MAX_SIZE} px）。`
        : `画布尺寸必须是 ${MIN_SIZE}–${MAX_SIZE} 之间的整数像素。`,
    );
    $("sizeWidth").focus();
    return;
  }
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
    savePrefs();
    const groupOn = $("groupToggle").checked;
    const paletteByAI = $("groupAiPalette").checked;
    const groupCount = Math.max(1, Math.min(9, Number($("groupCount").value) || 4));
    const usePerImage = groupOn && $("groupPerPalette").checked && !paletteByAI;
    const group = groupOn
      ? {
          count: groupCount,
          ...(usePerImage
            ? {
                palettes: [...$("groupPalettes").querySelectorAll("select")].map((s) => ({
                  name: s.value,
                })),
              }
            : {}),
        }
      : undefined;
    const data = await api("/api/chat", {
      method: "POST",
      body: {
        sessionId: state.sessionId,
        message: text,
        size: targetSize,
        scale: Number($("scale").value),
        mode: $("mode").value,
        costLimit: Number($("costLimit").value),
        ...(paletteByAI ? { paletteByAI: true } : {}),
        ...(group ? { group } : {}),
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
    const firstNew = Number(data.turns?.[0]?.index);
    const target = Number.isFinite(firstNew)
      ? state.session.turns.find((t) => t.index === firstNew)
      : null;
    showTurn(target ?? state.session.turns[state.session.turns.length - 1]);
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
  const selected = state.viewTurn;
  const info = groupInfoFor(selected);
  const target = info?.group.variants[0] ?? selected;
  const groupIndex = info?.groupIndex ?? selected.index;
  const groupNote = info && info.variantCount > 1 ? `（组图 ${info.variantCount} 张会一起保留）` : "";
  if (!confirm(`回到第 ${groupIndex} 轮${groupNote}？其后的轮次记录将被丢弃，会话从该图继续修改。`)) return;
  try {
    await api(`/api/session/${state.sessionId}/back`, {
      method: "POST",
      body: { turn: target.index },
    });
    await openSession(state.sessionId);
    const kept = state.session.turns.find((t) => t.index === selected.index);
    if (kept) showTurn(kept);
    $("chat").appendChild(
      bubble("hint", `已回到第 ${groupIndex} 轮${groupNote}，可在左侧继续输入以修改这张图。`),
    );
    scrollChatToBottom();
    await refreshSessionList(state.sessionId);
  } catch (e) {
    alert(`操作失败：${e.message}`);
  }
}

/* ---------------- 本地精确描摹 ---------------- */

async function runTrace() {
  const file = $("traceFile").files?.[0];
  if (!file || state.busy || !state.sessionId) return;
  state.busy = true;
  $("traceBtn").disabled = true;
  const oldText = $("traceBtn").textContent;
  $("traceBtn").textContent = "描摹中…";

  try {
    const params = new URLSearchParams();
    const w = Number($("traceWidth").value);
    const h = Number($("traceHeight").value);
    if (w) params.set("width", String(w));
    if (h) params.set("height", String(h));
    params.set("mode", $("traceResize").value);
    params.set("alpha", $("traceAlpha").value);
    params.set("scale", $("scale").value);
    params.set("name", file.name);
    if ($("traceAdaptive").checked) params.set("adaptive", "1");
    if ($("traceDither").checked) params.set("dither", "1");

    const res = await fetch(`/api/session/${state.sessionId}/trace?${params.toString()}`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    await openSession(state.sessionId);
    const updated = state.session.turns.find((t) => t.index === data.turn.index);
    if (updated) showTurn(updated);
    await refreshSessionList(state.sessionId);
    $("chat").appendChild(
      bubble(
        "hint",
        `已本地描摹 ${data.turn.width}×${data.turn.height}（${data.adaptive ? "自适应 15 色" : "会话调色板"}，¥0）。`,
      ),
    );
    scrollChatToBottom();
  } catch (e) {
    alert(`描摹失败：${e.message}`);
  } finally {
    state.busy = false;
    $("traceBtn").disabled = false;
    $("traceBtn").textContent = oldText || "开始描摹";
    $("traceFileHint").textContent = file
      ? `${file.name} · ${(file.size / 1024).toFixed(1)} KB`
      : "选择 PNG";
  }
}

/* ---------------- DSL 手动编辑 ---------------- */

function startDslEdit() {
  const turn = state.viewTurn;
  if (!turn?.dsl || state.busy || state.dslApplying) return;
  $("dslEditArea").value = turn.dsl;
  $("dslEditArea").readOnly = false;
  setDslEditMode(true);
  $("dslSaveBtn").disabled = false;
  $("dslCancelBtn").disabled = false;
  $("dslEditArea").focus();
}

function undoDslEdit() {
  if (state.dslApplying) return;
  const turn = state.viewTurn;
  if (turn?.dsl) $("dslEditArea").value = turn.dsl;
  $("dslEditArea").readOnly = false;
  setDslEditMode(false);
}

async function saveDslEdit() {
  const turn = state.viewTurn;
  if (!turn?.dsl || state.busy || state.dslApplying) return;
  const dsl = $("dslEditArea").value.trim();
  if (!dsl) {
    $("dslError").textContent = "未应用更改：DSL 不能为空。";
    $("dslError").hidden = false;
    return;
  }
  const btn = $("dslSaveBtn");
  const cancelBtn = $("dslCancelBtn");
  const area = $("dslEditArea");
  if (btn.disabled) return;
  state.dslApplying = true;
  btn.disabled = true;
  cancelBtn.disabled = true;
  area.readOnly = true;
  const label = btn.textContent;
  btn.textContent = "应用中…";
  $("dslError").hidden = true;
  try {
    const data = await api(`/api/session/${state.sessionId}/turn/${turn.index}/dsl`, {
      method: "POST",
      body: { dsl },
    });
    await openSession(state.sessionId);
    const updated = state.session.turns.find((t) => t.index === turn.index);
    if (updated) showTurn(updated);
    $("dslBox").open = true;
    const displayLabel = turnDisplayLabel(updated ?? turn);
    const group = data.turns?.length > 1 ? `（组图 ${data.turns.length} 张已同步）` : "";
    const warning = data.warning ? ` ${data.warning}` : "";
    $("chat").appendChild(
      bubble("hint", `已应用${displayLabel} 的 DSL${group}；未调用模型，未计费。${warning}`),
    );
    scrollChatToBottom();
  } catch (e) {
    $("dslError").textContent = `未应用更改：${e.message}`;
    $("dslError").hidden = false;
  } finally {
    state.dslApplying = false;
    area.readOnly = false;
    btn.disabled = false;
    cancelBtn.disabled = false;
    btn.textContent = label || "✅ 应用更改";
  }
}

/* ---------------- 事件绑定 ---------------- */

$("composer").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const text = $("input").value.trim();
  if (!text || state.busy) return;
  if (state.dslEditing) {
    alert("请先保存或取消 DSL 编辑，再发送新消息。");
    return;
  }
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
$("deleteSessionBtn").addEventListener("click", deleteCurrentSession);

$("sessionSelect").addEventListener("change", (ev) => openSession(ev.target.value));

$("gridToggle").addEventListener("change", updateGridOverlay);
$("tileGridToggle").addEventListener("change", updateGridOverlay);
$("previewImg").addEventListener("load", updateGridOverlay);
$("backBtn").addEventListener("click", backToThisTurn);

$("dslEditBtn").addEventListener("click", startDslEdit);
$("dslSaveBtn").addEventListener("click", saveDslEdit);
$("dslCancelBtn").addEventListener("click", undoDslEdit);
$("dslEditArea").addEventListener("input", () => {
  $("dslError").hidden = true;
  $("dslError").textContent = "";
});
$("dslEditArea").addEventListener("keydown", (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") {
    ev.preventDefault();
    saveDslEdit();
  } else if (ev.key === "Escape") {
    ev.preventDefault();
    undoDslEdit();
  }
});

for (const id of ["sizeWidth", "sizeHeight"]) {
  $(id).addEventListener("input", () => {
    const size = readTargetSize();
    if (size) state.lastSize = size;
    updateSizeHint();
    savePrefs();
  });
}

$("sizeUnit").addEventListener("change", () => {
  // 先按旧单位读出像素尺寸，再换单位显示，避免把 160 px 当成 160 tiles
  const previousUnit = state.sizeUnit;
  const pixels = readTargetSize(previousUnit) ?? state.lastSize;
  state.sizeUnit = currentSizeUnit();
  applySizeUnitAttrs();
  setSizeInputs(pixels.width, pixels.height);
  savePrefs();
});

$("tileBox").addEventListener("toggle", () => {
  if ($("tileBox").open && state.viewTurn?.tileStats) loadTilePlan(state.viewTurn);
});
$("tilePlanBtn").addEventListener("click", () => {
  if (state.viewTurn) loadTilePlan(state.viewTurn, Number($("tileEpsilon").value));
});
$("tileEpsilon").addEventListener("input", () => {
  $("tileEpsilonVal").textContent = $("tileEpsilon").value;
  if (tilePlanTimer) clearTimeout(tilePlanTimer);
  tilePlanTimer = setTimeout(() => {
    if (state.viewTurn) loadTilePlan(state.viewTurn, Number($("tileEpsilon").value));
  }, 250);
});
$("tileBatchPreview").addEventListener("click", () => {
  if (state.viewTurn) openBatchPreview(state.viewTurn, Number($("tileEpsilon").value));
});
$("tileUndoBtn").addEventListener("click", undoMergePlan);

$("traceFile").addEventListener("change", () => {
  const f = $("traceFile").files?.[0];
  $("traceBtn").disabled = !f;
  $("traceFileHint").textContent = f ? `${f.name} · ${(f.size / 1024).toFixed(1)} KB` : "选择 PNG";
});
$("traceAlpha").addEventListener("input", () => {
  $("traceAlphaVal").textContent = $("traceAlpha").value;
});
$("traceBtn").addEventListener("click", runTrace);

$("mergeClose").addEventListener("click", closeMergePreview);
$("mergeCancel").addEventListener("click", closeMergePreview);
$("mergeConfirm").addEventListener("click", confirmMergePreview);
$("mergePreview").addEventListener("click", (ev) => {
  if (ev.target === $("mergePreview")) closeMergePreview();
});
window.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && !$("mergePreview").hidden) closeMergePreview();
});

async function writeClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* 无权限或非安全上下文时回退到 execCommand */
    }
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  if (!ok) throw new Error("copy failed");
}

async function copyJavaScript(button, label) {
  if (!state.viewTurn) return;
  try {
    await writeClipboard(state.viewTurn.code || "");
    button.textContent = "✅ 已复制";
  } catch {
    button.textContent = "复制失败";
  }
  setTimeout(() => (button.textContent = label), 1500);
}

$("copyBtn").addEventListener("click", () => copyJavaScript($("copyBtn"), "📋 复制 JS"));
$("copyCodeBtn").addEventListener("click", () => copyJavaScript($("copyCodeBtn"), "📋 复制代码"));

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

$("palette").addEventListener("change", async () => {
  const v = $("palette").value;
  if (v === PALETTE_SELECT_CUSTOM) {
    $("customPalette").hidden = false;
    fillCustomSwatches(currentPalette()?.colors);
    return;
  }
  $("customPalette").hidden = true;
  await applyPalette({ name: v });
});

$("paletteVariantsBtn").addEventListener("click", loadPaletteVariants);
$("customApply").addEventListener("click", () => {
  const colors = [...$("customSwatches").children].map((el) => el.value.toUpperCase());
  applyPalette({ name: "custom", colors });
});
$("customReset").addEventListener("click", () => setPaletteControls());

function syncGroupPaletteControls() {
  const on = $("groupToggle").checked;
  const ai = $("groupAiPalette").checked;
  $("groupCount").disabled = !on;
  $("groupPerPalette").disabled = !on || ai;
  if (!on || ai) $("groupPerPalette").checked = false;
  renderGroupPaletteSelects();
}
$("groupToggle").addEventListener("change", syncGroupPaletteControls);
$("groupCount").addEventListener("input", syncGroupPaletteControls);
$("groupPerPalette").addEventListener("change", renderGroupPaletteSelects);
$("groupAiPalette").addEventListener("change", syncGroupPaletteControls);

/* ---------------- 启动 ---------------- */

(async function init() {
  try {
    loadPrefs();
    updateSizeHint();
    await loadPalettes();
    const id = await refreshSessionList();
    await openSession(id);
  } catch (e) {
    $("chat") && $("chat").appendChild(bubble("error", `初始化失败：${e.message}`));
  }
  $("input").focus();
})();
