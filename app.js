"use strict";
/* ポップメモ: 五十音分類・音声入力・検索・画像/PDF添付つきのメモ帳 */

// ---------- 五十音の行 ----------
const GYOU = [
  { k: "あ", chars: "あいうえおぁぃぅぇぉゔ", color: "#ff6b9d" },
  { k: "か", chars: "かきくけこ", color: "#ff9f43" },
  { k: "さ", chars: "さしすせそ", color: "#f5b800" },
  { k: "た", chars: "たちつてとっ", color: "#7bc043" },
  { k: "な", chars: "なにぬねの", color: "#3cc8be" },
  { k: "は", chars: "はひふへほ", color: "#3fa7f5" },
  { k: "ま", chars: "まみむめも", color: "#7864ff" },
  { k: "や", chars: "やゆよゃゅょ", color: "#b45cf0" },
  { k: "ら", chars: "らりるれろ", color: "#f06bc8" },
  { k: "わ", chars: "わをんゎ", color: "#ef5b5b" },
  { k: "他", chars: "", color: "#8a8499" },
];
const COLORS = ["#ffffff", "#ffe0ec", "#fff3b0", "#d6f5e3", "#d3ecff", "#e6dcff", "#ffe2c7"];
const safeColor = c => (COLORS.includes(c) ? c : "#ffffff");
const gyouColor = k => (GYOU.find(g => g.k === k) || GYOU[10]).color;

// カタカナ→ひらがな、濁点・半濁点を除去（が→か）、小書き文字はそのまま行判定に使う
function toHira(s) {
  return s.replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
}
function fold(s) {
  return toHira((s || "").normalize("NFKC")).toLowerCase();
}
function gyouOf(note) {
  const src = (note.yomi || "").trim() || (note.title || "").trim();
  if (!src) return "他";
  const first = fold(src).normalize("NFD").replace(/[゙゚]/g, "").normalize("NFC").charAt(0);
  const g = GYOU.find(g => g.chars.includes(first));
  return g ? g.k : "他";
}

// ---------- IndexedDB ----------
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("pop-memo", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("notes", { keyPath: "id" });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function run(mode, fn) {
  return new Promise((res, rej) => {
    const t = db.transaction("notes", mode);
    let out;
    const r = fn(t.objectStore("notes"));
    r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out);
    t.onerror = t.onabort = () => rej(t.error || new Error("db"));
  });
}
const dbAll = () => run("readonly", s => s.getAll());
const dbPut = n => run("readwrite", s => s.put(n));
const dbDel = id => run("readwrite", s => s.delete(id));

// ---------- 状態 ----------
const $ = id => document.getElementById(id);
let notes = [];
let filter = "all";      // all | 行のキー
let query = "";
let showTrash = false;
let cur = null;          // 編集中のメモ
let curIsNew = false;
let settings = {};
try { settings = JSON.parse(localStorage.getItem("pm-settings") || "{}") || {}; } catch {}
settings.sort = settings.sort || "updated";
settings.theme = settings.theme || "auto";
const saveSettings = () => localStorage.setItem("pm-settings", JSON.stringify(settings));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function toast(msg, ms = 2600) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  t.style.animation = "none"; void t.offsetWidth; t.style.animation = "";
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms);
}
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- テーマ ----------
function applyTheme() { document.documentElement.dataset.theme = settings.theme; }

// ---------- 一覧 ----------
function noteText(n) {
  return [n.title, n.yomi, n.text, ...(n.checks || []).map(c => c.t), ...(n.atts || []).map(a => a.name)].join("\n");
}
function visibleNotes() {
  const q = fold(query).trim();
  let arr = notes.filter(n => showTrash ? !!n.deletedAt : !n.deletedAt);
  if (filter !== "all") arr = arr.filter(n => gyouOf(n) === filter);
  if (q) arr = arr.filter(n => fold(noteText(n)).includes(q));
  const by = settings.sort;
  arr.sort((a, b) => {
    if (!showTrash && !!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    if (by === "title") return fold(a.yomi || a.title).localeCompare(fold(b.yomi || b.title), "ja");
    return (b[by] || 0) - (a[by] || 0);
  });
  return arr;
}
function highlight(text, q) {
  if (!q) return esc(text);
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  let out = "", last = 0, m;
  while ((m = re.exec(text)) && m[0]) { out += esc(text.slice(last, m.index)) + "<mark>" + esc(m[0]) + "</mark>"; last = m.index + m[0].length; }
  return out + esc(text.slice(last));
}

let thumbUrls = [], attUrls = [];
const makeUrl = (list, blob) => { const u = URL.createObjectURL(blob); list.push(u); return u; };
const revokeAll = list => { list.forEach(u => URL.revokeObjectURL(u)); list.length = 0; };

let io;
function observeFade() {
  if (io) io.disconnect();
  io = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      const el = e.target;
      el.classList.add("in");
      el.addEventListener("animationend", () => el.classList.add("done"), { once: true });
      io.unobserve(el);
    });
  }, { threshold: 0.08, rootMargin: "0px 0px -6% 0px" });
  document.querySelectorAll(".fade-up:not(.in)").forEach((el, i) => {
    el.style.setProperty("--d", Math.min(i % 8, 6) * 55 + "ms");
    io.observe(el);
  });
}

function renderRows() {
  const counts = {};
  notes.filter(n => !n.deletedAt).forEach(n => { const k = gyouOf(n); counts[k] = (counts[k] || 0) + 1; });
  const total = notes.filter(n => !n.deletedAt).length;
  const chips = [`<button class="row-chip ${filter === "all" ? "active" : ""}" data-k="all" style="background:#2b2340;color:#fff">ぜんぶ<small>${total}</small></button>`];
  GYOU.forEach(g => {
    chips.push(`<button class="row-chip ${filter === g.k ? "active" : ""}" data-k="${g.k}" style="background:${g.color};color:#fff">${g.k}${g.k === "他" ? "" : "行"}${counts[g.k] ? `<small>${counts[g.k]}</small>` : ""}</button>`);
  });
  $("rows").innerHTML = chips.join("");
}

function render() {
  revokeAll(thumbUrls);
  renderRows();
  const arr = visibleNotes();
  const q = query.trim();
  $("listTitle").textContent = (showTrash ? "🗑️ ゴミ箱（30日で自動削除）" : "") +
    (q ? ` 「${q}」の検索結果 ${arr.length}件` : (showTrash ? "" : (filter === "all" ? "すべてのメモ" : `${filter}${filter === "他" ? "" : "行"}のメモ`) + ` ${arr.length}件`));
  $("list").innerHTML = arr.map(n => {
    const g = gyouOf(n);
    const img = (n.atts || []).find(a => a.kind === "image");
    const pdfs = (n.atts || []).filter(a => a.kind === "pdf").length;
    const done = (n.checks || []).filter(c => c.done).length;
    const body = (n.text || "").slice(0, 160);
    return `<article class="card fade-up" data-id="${esc(n.id)}" style="--c:${safeColor(n.color)}">
      ${n.pinned ? '<span class="pin">📌</span>' : ""}
      <h3>${highlight(n.title || "（無題）", q)}</h3>
      ${body ? `<p>${highlight(body, q)}</p>` : ""}
      ${img ? `<img class="th" data-th="${esc(n.id)}" alt="">` : ""}
      <div class="meta"><span style="color:${gyouColor(g)}">● ${g}${g === "他" ? "" : "行"}</span>
        ${(n.checks || []).length ? `<span>☑ ${done}/${n.checks.length}</span>` : ""}
        ${pdfs ? `<span>📎 PDF${pdfs}</span>` : ""}</div>
    </article>`;
  }).join("");
  // 画像サムネイルを blob URL で設定
  arr.forEach(n => {
    const img = (n.atts || []).find(a => a.kind === "image");
    const el = img && document.querySelector(`[data-th="${CSS.escape(n.id)}"]`);
    if (el) el.src = makeUrl(thumbUrls, img.blob);
  });
  const empty = $("empty");
  empty.hidden = arr.length > 0;
  if (!arr.length) {
    empty.innerHTML = q ? '<span class="big">🔎</span>見つからなかったよ'
      : showTrash ? '<span class="big">🧺</span>ゴミ箱は空っぽ'
      : '<span class="big">📝</span>右下の ＋ でメモを作ろう！';
  }
  observeFade();
}

async function reload() { notes = await dbAll(); render(); }

// 30日経ったゴミ箱を整理
async function purgeTrash() {
  const lim = Date.now() - 30 * 864e5;
  for (const n of notes) if (n.deletedAt && n.deletedAt < lim) { await dbDel(n.id); window.Sync?.forget(n.id); }
}

// ---------- 編集 ----------
function newNote() {
  const now = Date.now();
  return { id: uid(), title: "", yomi: "", text: "", color: "#ffffff", pinned: false, checks: [], atts: [], created: now, updated: now, deletedAt: null };
}
function openEditor(n, isNew) {
  cur = n; curIsNew = !!isNew;
  $("edTitle").value = n.title; $("edYomi").value = n.yomi; $("edText").value = n.text;
  $("edPin").classList.toggle("on", n.pinned);
  renderColors(); renderChecks(); renderAtts(); updateGyouBadge();
  $("editor").hidden = false;
  document.body.style.overflow = "hidden";
  autosize();
  if (isNew) $("edTitle").focus();
}
function autosize() { const t = $("edText"); t.style.height = "auto"; t.style.height = Math.max(90, t.scrollHeight) + "px"; }
function updateGyouBadge() {
  const t = { ...cur, title: $("edTitle").value, yomi: $("edYomi").value };
  const g = gyouOf(t);
  const b = $("edGyou"); b.textContent = g + (g === "他" ? "" : "行"); b.style.background = gyouColor(g);
}
function renderColors() {
  $("colors").innerHTML = COLORS.map(c => `<button class="color-dot ${cur.color === c ? "sel" : ""}" data-c="${c}" style="background:${c};border:2px solid rgba(0,0,0,.1)" aria-label="色"></button>`).join("");
}
function renderChecks() {
  $("checks").innerHTML = (cur.checks || []).map((c, i) => `<div class="chk ${c.done ? "done" : ""}" data-i="${i}">
    <input type="checkbox" ${c.done ? "checked" : ""}><input type="text" value="${esc(c.t)}" placeholder="やること"><button class="btn-mini" data-rm="${i}">✕</button></div>`).join("");
}
function renderAtts() {
  revokeAll(attUrls);
  $("atts").innerHTML = (cur.atts || []).map((a, i) => `<div class="att" data-i="${i}">
    ${a.kind === "image" ? `<img data-ai="${i}" alt="">` : (a.thumb ? `<img data-ai="${i}" data-thumb="1" alt="">` : '<div class="pdfbox">📄</div>')}
    <div class="nm">${a.kind === "pdf" ? "📎 " : ""}${esc(a.name)}</div><button class="rm" data-rm="${i}" aria-label="削除">✕</button></div>`).join("");
  document.querySelectorAll("#atts img[data-ai]").forEach(el => {
    const a = cur.atts[+el.dataset.ai];
    el.src = makeUrl(attUrls, el.dataset.thumb ? a.thumb : a.blob);
  });
}
let saveQ = Promise.resolve();
let saveTimer;
// 保存は直列化し、編集中メモはローカル参照で扱う（画面を閉じても取り違えない）
function commit(n = cur, isNew = curIsNew) {
  if (!n) return saveQ;
  if (n === cur) {
    n.title = $("edTitle").value.trim();
    n.yomi = $("edYomi").value.trim();
    n.text = $("edText").value;
  }
  n.checks = (n.checks || []).filter(c => c.t.trim());
  const empty = !n.title && !n.text.trim() && !n.checks.length && !(n.atts || []).length;
  saveQ = saveQ.then(async () => {
    try {
      if (empty) { if (!isNew || n.saved) { await dbDel(n.id); window.Sync?.forget(n.id); } n.saved = false; }
      else { n.updated = Date.now(); await dbPut(n); n.saved = true; if (n === cur) curIsNew = false; window.Sync?.notify(n.id); }
    } catch { toast("保存に失敗しました。容量がいっぱいかもしれません"); }
  });
  return saveQ;
}
async function closeEditor() {
  stopMic(true);
  clearTimeout(saveTimer);
  await commit();
  $("editor").hidden = true; document.body.style.overflow = "";
  cur = null; await reload();
}
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(() => commit(), 500); }

// ---------- 添付 ----------
async function shrinkImage(file) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const max = 1600, r = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * r); c.height = Math.round(bmp.height * r);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise(res => c.toBlob(b => res(b || file), "image/jpeg", 0.85));
  } catch { return file; }
}
let pdfjsP;
function loadPdfJs() {
  if (!pdfjsP) pdfjsP = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "vendor/pdf.min.js";
    s.onload = () => { pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js"; res(pdfjsLib); };
    s.onerror = rej; document.head.appendChild(s);
  });
  return pdfjsP;
}
async function pdfThumb(file) {
  try {
    const lib = await loadPdfJs();
    const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
    const page = await pdf.getPage(1);
    const vp0 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 360 / vp0.width });
    const c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height;
    await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    return await new Promise(res => c.toBlob(res, "image/jpeg", 0.8));
  } catch { return null; }
}
async function addFiles(files, kind) {
  const n = cur;
  for (const f of files) {
    if (kind === "image") n.atts.push({ id: uid(), kind, name: f.name || "画像", blob: await shrinkImage(f) });
    else n.atts.push({ id: uid(), kind, name: f.name || "PDF", blob: f, thumb: await pdfThumb(f) });
  }
  if (cur === n) { renderAtts(); scheduleSave(); } else { await commit(n, false); reload(); }
  toast("追加したよ 🎉");
}
function openAtt(i) {
  const a = cur.atts[i];
  if (a.kind === "image") {
    $("viewerImg").src = makeUrl(attUrls, a.blob); $("viewer").hidden = false;
  } else {
    const w = window.open(URL.createObjectURL(new Blob([a.blob], { type: "application/pdf" })), "_blank");
    if (!w) toast("PDFを開けませんでした。ポップアップを許可してね");
  }
}

// ---------- 音声入力 ----------
// iPhone標準の音声認識（Siriと同じ変換）を直接使う。話した内容がリアルタイムでメモ欄に出て、
// 漢字・カタカナへの変換もその認識結果に含まれる。キーボードは出さない。
let rec = null, recWanted = false, recBase = null, recRestarts = 0;
const MIC_ERR = {
  "not-allowed": "マイクの許可がありません。iPhoneの「設定」→「Safari」→「マイク」で許可してね",
  "service-not-allowed": "音声認識がオフです。「設定」→「一般」→「キーボード」→「音声入力」をオンにしてね",
  "audio-capture": "マイクが使えません。他のアプリがマイクを使っていないか確認してね",
  "network": "通信できないため音声認識できません。ネット接続を確認してね",
  "language-not-supported": "日本語の音声認識が使えません",
};
function setRecUI(on) {
  $("tMic").classList.toggle("rec", on);
  $("tMic").querySelector("b").textContent = on ? "停止" : "音声";
  $("edText").classList.toggle("recording", on);
  $("edText").readOnly = on; // 読み取り専用にしてキーボードが出ないようにする
  if (on) document.activeElement?.blur();
}
function stopMic(silent) {
  recWanted = false;
  if (rec) { try { rec.stop(); } catch {} }
  setRecUI(false);
  if (!silent) scheduleSave();
}
function toggleMic() {
  if (recWanted) { stopMic(); return; }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { toast("このブラウザは音声認識に対応していません。Safariで開いてみてね", 4500); return; }
  const ta = $("edText");
  const pos = ta.selectionStart ?? ta.value.length;
  recBase = { before: ta.value.slice(0, pos), after: ta.value.slice(ta.selectionEnd ?? pos) };
  recWanted = true; recRestarts = 0;
  setRecUI(true);
  startRec(SR);
  toast("話してね🎤 もう一度押すと止まります", 3000);
}
function startRec(SR) {
  const ta = $("edText");
  rec = new SR();
  rec.lang = "ja-JP"; rec.interimResults = true; rec.continuous = true; rec.maxAlternatives = 1;
  rec.onresult = e => {
    // このセッションの認識結果を最初から組み立てる（確定分＋途中経過）
    const said = Array.from(e.results).map(r => r[0].transcript).join("");
    ta.value = recBase.before + said + recBase.after;
    const caret = (recBase.before + said).length;
    ta.selectionStart = ta.selectionEnd = caret;
    autosize(); scheduleSave();
    ta.scrollTop = ta.scrollHeight;
    document.querySelector(".ed-body").scrollTop = ta.offsetTop + ta.scrollHeight;
    recRestarts = 0;
  };
  rec.onerror = e => {
    if (e.error === "no-speech" || e.error === "aborted") return; // 無音は再開で対応
    recWanted = false; setRecUI(false);
    toast(MIC_ERR[e.error] || `音声認識でエラー（${e.error}）。キーボードのマイクも使えます`, 5500);
  };
  rec.onend = () => {
    // iPhoneは無音で自動終了するので、止めていなければ続きから再開する
    if (recWanted && recRestarts < 5) {
      recRestarts++;
      recBase = { before: ta.value.slice(0, ta.selectionStart ?? ta.value.length), after: recBase.after };
      try { startRec(SR); return; } catch {}
    }
    if (recWanted) toast("音声認識が止まりました。もう一度🎤を押してね");
    recWanted = false; setRecUI(false);
  };
  try { rec.start(); } catch (err) { recWanted = false; setRecUI(false); toast("音声認識を開始できませんでした"); }
}

// ---------- 外部から来たメモの検証（バックアップ読み込み／クラウド受信で共用） ----------
const SAFE_ID = /^[\w-]{1,64}$/;
function sanitizeNote(n, forceId) {
  const num = v => (Number.isFinite(+v) ? +v : Date.now());
  const id = String(forceId ?? n.id ?? "").replace(/[^\w-]/g, "").slice(0, 64) || uid();
  const str = v => (typeof v === "string" ? v : "");
  return {
    id, title: str(n.title), yomi: str(n.yomi), text: str(n.text), color: safeColor(n.color), pinned: !!n.pinned,
    checks: (Array.isArray(n.checks) ? n.checks : []).filter(c => c && typeof c === "object").map(c => ({ t: str(c.t), done: !!c.done })),
    atts: (Array.isArray(n.atts) ? n.atts : []).filter(a => a && SAFE_ID.test(String(a.id)) && (a.kind === "image" || a.kind === "pdf"))
      .map(a => ({ ...a, id: String(a.id), name: str(a.name) || (a.kind === "pdf" ? "PDF" : "画像") })),
    created: num(n.created), updated: num(n.updated), deletedAt: n.deletedAt ? num(n.deletedAt) : null, saved: true,
  };
}

// ---------- バックアップ ----------
const blobToData = b => new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });
const dataToBlob = async d => (await fetch(d)).blob();
async function exportAll() {
  const out = [];
  for (const n of notes) {
    const atts = [];
    for (const a of n.atts || []) atts.push({ ...a, blob: await blobToData(a.blob), thumb: a.thumb ? await blobToData(a.thumb) : null });
    out.push({ ...n, atts });
  }
  const blob = new Blob([JSON.stringify({ app: "pop-memo", v: 1, notes: out })], { type: "application/json" });
  const file = new File([blob], `ポップメモ_${new Date().toISOString().slice(0, 10)}.json`, { type: "application/json" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); localStorage.setItem("pm-lastBackup", Date.now()); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
  localStorage.setItem("pm-lastBackup", Date.now());
}
async function importAll(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== "pop-memo") throw new Error();
    for (const raw of data.notes) {
      const n = sanitizeNote(raw);
      for (const a of n.atts) { a.blob = await dataToBlob(a.blob); a.thumb = a.thumb ? await dataToBlob(a.thumb) : null; }
      await dbPut(n); window.Sync?.notify(n.id);
    }
    await reload(); toast(`${data.notes.length}件 読み込みました 🎉`);
  } catch { toast("読み込めませんでした。ポップメモのバックアップか確認してね"); }
}
async function showStorage() {
  const el = $("storageInfo");
  try {
    const e = await navigator.storage.estimate();
    const mb = x => (x / 1048576).toFixed(1);
    const p = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    const last = +localStorage.getItem("pm-lastBackup");
    el.textContent = `使用量 ${mb(e.usage)}MB / 上限の目安 ${mb(e.quota)}MB ・ 永続保存: ${p ? "あり" : "なし"} ・ 最終バックアップ: ${last ? new Date(last).toLocaleDateString("ja-JP") : "まだ"}`;
  } catch { el.textContent = "容量情報を取得できませんでした"; }
}

// ---------- ボタンの波紋 ----------
document.addEventListener("pointerdown", e => {
  const b = e.target.closest(".icon-btn,.pill-btn,.fab,.tool");
  if (!b) return;
  const r = b.getBoundingClientRect(), s = Math.max(r.width, r.height);
  const d = document.createElement("span"); d.className = "ripple";
  d.style.cssText = `width:${s}px;height:${s}px;left:${e.clientX - r.left - s / 2}px;top:${e.clientY - r.top - s / 2}px`;
  b.appendChild(d); setTimeout(() => d.remove(), 600);
});

// ---------- クラウド自動バックアップのUI ----------
function renderCloud() {
  const S = window.Sync; if (!S) return;
  const on = !!S.email;
  $("cloudOff").hidden = on; $("cloudOn").hidden = !on;
  if (!on) return;
  const t = { syncing: "同期中…", ok: "同期済み ✅", error: "同期できませんでした ⚠️", login: "再ログインが必要です", off: "" }[S.status] || "";
  const last = S.last ? new Date(S.last).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "まだ";
  $("cloudInfo").textContent = `${S.email} ・ ${t} ・ 最終同期 ${last}` + (S.status === "error" ? `（${S.error}。ネットが戻れば自動で再試行します）` : "");
  $("cloudBadge").textContent = S.status === "ok" ? "☁️✓" : S.status === "syncing" ? "☁️…" : S.status === "error" ? "☁️⚠" : "☁️";
}
function bindCloud() {
  const S = window.Sync; if (!S) return;
  S.onStatus(renderCloud);
  const go = async signup => {
    const email = $("cloudEmail").value.trim(), pw = $("cloudPw").value;
    if (!email || pw.length < 8) { toast("メールアドレスと、8文字以上のパスワードを入れてね"); return; }
    try { toast("通信中…"); await S.login(email, pw, signup); $("cloudPw").value = ""; toast("自動バックアップをONにしました 🎉"); }
    catch (e) { toast(/Invalid login/i.test(e.message) ? "メールかパスワードが違うようです" : /already/i.test(e.message) ? "そのメールは登録済みです。「ログイン」を押してね" : "失敗: " + e.message, 4000); }
    renderCloud();
  };
  $("btnLogin").addEventListener("click", () => go(false));
  $("btnSignup").addEventListener("click", () => go(true));
  $("btnSyncNow").addEventListener("click", () => S.sync());
  $("btnLogout").addEventListener("click", async () => { if (confirm("自動バックアップをOFFにしますか？（クラウド上のデータは残ります）")) { await S.logout(); renderCloud(); } });
  renderCloud();
}

// ---------- イベント ----------
function bind() {
  $("rows").addEventListener("click", e => {
    const b = e.target.closest(".row-chip"); if (!b) return;
    filter = b.dataset.k; render();
  });
  $("search").addEventListener("input", e => { query = e.target.value; render(); });
  $("list").addEventListener("click", e => {
    const c = e.target.closest(".card"); if (!c) return;
    const n = notes.find(x => x.id === c.dataset.id);
    if (showTrash) {
      if (confirm("このメモをゴミ箱から戻しますか？\n（キャンセルで完全に削除するか選べます）")) {
        n.deletedAt = null; n.updated = Date.now(); dbPut(n).then(() => { window.Sync?.notify(n.id); return reload(); });
      } else if (confirm("完全に削除しますか？ 元に戻せません。")) dbDel(n.id).then(() => { window.Sync?.forget(n.id); return reload(); });
      return;
    }
    openEditor(n, false);
  });
  $("fab").addEventListener("click", () => openEditor(newNote(), true));
  $("btnTrash").addEventListener("click", () => {
    showTrash = !showTrash; $("btnTrash").classList.toggle("on", showTrash); render();
    if (showTrash) toast("ゴミ箱を表示中。もう一度押すと戻ります");
  });
  $("btnSettings").addEventListener("click", () => {
    $("selSort").value = settings.sort; $("selTheme").value = settings.theme;
    $("sheet").hidden = false; showStorage();
  });
  $("sheetClose").addEventListener("click", () => ($("sheet").hidden = true));
  $("btnHelp").addEventListener("click", () => { $("manual").hidden = false; $("manual").querySelector(".manual-body").scrollTop = 0; });
  $("manualClose").addEventListener("click", () => ($("manual").hidden = true));
  $("sheet").addEventListener("click", e => { if (e.target === $("sheet")) $("sheet").hidden = true; });
  $("selSort").addEventListener("change", e => { settings.sort = e.target.value; saveSettings(); render(); });
  $("selTheme").addEventListener("change", e => { settings.theme = e.target.value; saveSettings(); applyTheme(); });
  $("btnExport").addEventListener("click", exportAll);
  bindCloud();
  $("btnImport").addEventListener("click", () => $("fileImport").click());
  $("fileImport").addEventListener("change", e => { if (e.target.files[0]) importAll(e.target.files[0]); e.target.value = ""; });

  // 編集画面
  $("edBack").addEventListener("click", closeEditor);
  $("edTitle").addEventListener("input", () => { updateGyouBadge(); scheduleSave(); });
  $("edYomi").addEventListener("input", () => { updateGyouBadge(); scheduleSave(); });
  $("edText").addEventListener("input", () => { autosize(); scheduleSave(); });
  $("edPin").addEventListener("click", () => { cur.pinned = !cur.pinned; $("edPin").classList.toggle("on", cur.pinned); scheduleSave(); });
  $("edDel").addEventListener("click", async () => {
    if (!confirm("このメモをゴミ箱に入れますか？")) return;
    clearTimeout(saveTimer);
    const n = cur; n.title = $("edTitle").value.trim(); n.yomi = $("edYomi").value.trim(); n.text = $("edText").value;
    saveQ = saveQ.then(async () => { n.deletedAt = Date.now(); n.updated = Date.now(); await dbPut(n); window.Sync?.notify(n.id); }); await saveQ;
    $("editor").hidden = true; document.body.style.overflow = ""; cur = null; await reload(); toast("ゴミ箱に入れました");
  });
  $("colors").addEventListener("click", e => {
    const d = e.target.closest(".color-dot"); if (!d) return;
    cur.color = d.dataset.c; renderColors(); scheduleSave();
  });
  $("tMic").addEventListener("click", toggleMic);
  $("tImg").addEventListener("click", () => $("fileImg").click());
  $("tPdf").addEventListener("click", () => $("filePdf").click());
  $("fileImg").addEventListener("change", e => { addFiles([...e.target.files], "image"); e.target.value = ""; });
  $("filePdf").addEventListener("change", e => { addFiles([...e.target.files], "pdf"); e.target.value = ""; });
  $("tCheck").addEventListener("click", () => {
    cur.checks.push({ t: "", done: false }); renderChecks();
    const ins = document.querySelectorAll("#checks input[type=text]"); ins[ins.length - 1].focus(); scheduleSave();
  });
  $("checks").addEventListener("input", e => {
    const row = e.target.closest(".chk"); if (!row) return;
    if (e.target.type === "text") cur.checks[+row.dataset.i].t = e.target.value;
    scheduleSave();
  });
  $("checks").addEventListener("change", e => {
    const row = e.target.closest(".chk"); if (!row || e.target.type !== "checkbox") return;
    cur.checks[+row.dataset.i].done = e.target.checked; row.classList.toggle("done", e.target.checked); scheduleSave();
  });
  $("checks").addEventListener("click", e => {
    const b = e.target.closest("[data-rm]"); if (!b) return;
    cur.checks.splice(+b.dataset.rm, 1); renderChecks(); scheduleSave();
  });
  $("atts").addEventListener("click", e => {
    const rm = e.target.closest(".rm");
    if (rm) { if (confirm("この添付を外しますか？")) { cur.atts.splice(+rm.dataset.rm, 1); renderAtts(); scheduleSave(); } return; }
    const a = e.target.closest(".att"); if (a) openAtt(+a.dataset.i);
  });
  $("viewerClose").addEventListener("click", () => ($("viewer").hidden = true));
  // アプリが裏に回る時に保存
  document.addEventListener("visibilitychange", () => { if (document.hidden && cur) commit(); });
  addEventListener("pagehide", () => { if (cur) commit(); });
}

// ---------- 起動 ----------
(async function init() {
  applyTheme(); bind();
  db = await openDB();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  notes = await dbAll(); await purgeTrash(); notes = await dbAll(); render();
  if ("serviceWorker" in navigator && location.protocol.startsWith("http") && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  // 1週間バックアップしていなければ促す
  const last = +localStorage.getItem("pm-lastBackup") || 0;
  if (notes.length && !localStorage.getItem("pm-cloud") && Date.now() - last > 7 * 864e5) setTimeout(() => toast("⚙️ 設定で自動バックアップをONにすると安心だよ", 4000), 1500);
})();
