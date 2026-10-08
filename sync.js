"use strict";
/* クラウド自動バックアップ（Supabase）。
   - ログイン後は、メモの保存・起動・復帰・オンライン復帰のたびに自動で同期する
   - 競合は「更新日時が新しい方を採用」。添付は Storage、メモ本体は notes テーブル */
(() => {
  const SB_URL = "https://igmwdbeyboolxfzlqczq.supabase.co";
  const SB_KEY = "sb_publishable_CAGDMrzQNJbw_dDk2TqjmA_rYBaM9hf"; // ブラウザ公開用キー（RLSで保護）
  const BUCKET = "attachments";
  const LS_ON = "pm-cloud", LS_DIRTY = "pm-dirty", LS_DEL = "pm-pendingDel", LS_LAST = "pm-lastSync";

  let sb = null, user = null, running = null, timer = null, status = "off", errMsg = "";
  const readSet = k => { try { return new Set(JSON.parse(localStorage.getItem(k) || "[]")); } catch { return new Set(); } };
  const writeSet = (k, s) => localStorage.setItem(k, JSON.stringify([...s]));
  const listeners = [];
  const setStatus = (s, msg = "") => { status = s; errMsg = msg; listeners.forEach(f => f(s, msg)); };

  function loadLib() {
    if (window.supabase) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "vendor/supabase.min.js";
      s.onload = res; s.onerror = () => rej(new Error("ライブラリを読み込めませんでした（オフライン？）"));
      document.head.appendChild(s);
    });
  }
  async function client() {
    if (sb) return sb;
    await loadLib();
    sb = window.supabase.createClient(SB_URL, SB_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
    sb.auth.onAuthStateChange((_e, session) => { user = session?.user || null; });
    return sb;
  }

  // ---------- 1件のメモを送る ----------
  const folder = id => `${user.id}/${id}`;
  async function pushNote(n) {
    const c = await client();
    for (const a of n.atts || []) {
      if (a.synced) continue;
      const opt = { upsert: true, contentType: a.blob.type || undefined };
      let r = await c.storage.from(BUCKET).upload(`${folder(n.id)}/${a.id}`, a.blob, opt);
      if (r.error) throw r.error;
      if (a.thumb) { r = await c.storage.from(BUCKET).upload(`${folder(n.id)}/${a.id}.thumb`, a.thumb, { upsert: true, contentType: "image/jpeg" }); if (r.error) throw r.error; }
      a.synced = true;
    }
    // 外した添付をクラウドからも消す
    const keep = new Set((n.atts || []).flatMap(a => [a.id, a.id + ".thumb"]));
    const ls = await c.storage.from(BUCKET).list(folder(n.id));
    const stale = (ls.data || []).filter(f => !keep.has(f.name)).map(f => `${folder(n.id)}/${f.name}`);
    if (stale.length) await c.storage.from(BUCKET).remove(stale);

    const data = { ...n, atts: (n.atts || []).map(a => ({ id: a.id, kind: a.kind, name: a.name, hasThumb: !!a.thumb })) };
    delete data.saved;
    const { error } = await c.from("notes").upsert({ id: n.id, data, updated: n.updated }, { onConflict: "user_id,id" });
    if (error) throw error;
    // synced フラグだけを端末側の最新データへ反映（編集中の内容を古いコピーで上書きしない）
    const latest = (await dbAll()).find(x => x.id === n.id);
    if (latest) {
      const ok = new Set((n.atts || []).filter(a => a.synced).map(a => a.id));
      (latest.atts || []).forEach(a => { if (ok.has(a.id)) a.synced = true; });
      await dbPut(latest);
    }
  }
  async function removeRemote(id) {
    const c = await client();
    const ls = await c.storage.from(BUCKET).list(folder(id));
    if (ls.data?.length) await c.storage.from(BUCKET).remove(ls.data.map(f => `${folder(id)}/${f.name}`));
    const { error } = await c.from("notes").delete().eq("id", id);
    if (error) throw error;
  }
  // ---------- 1件のメモを受け取る ----------
  async function pullNote(row) {
    const c = await client();
    const n = sanitizeNote(row.data || {}, row.id); // 受信データは必ず検証してから保存
    n.updated = Number(row.updated) || n.updated;
    const atts = [];
    for (const m of n.atts) {
      const b = await c.storage.from(BUCKET).download(`${folder(n.id)}/${m.id}`);
      if (b.error) throw b.error;
      let thumb = null;
      if (m.hasThumb === true) { const t = await c.storage.from(BUCKET).download(`${folder(n.id)}/${m.id}.thumb`); if (!t.error) thumb = t.data; }
      atts.push({ id: m.id, kind: m.kind, name: m.name, blob: b.data, thumb, synced: true });
    }
    n.atts = atts; n.saved = true;
    await dbPut(n);
  }

  // ---------- 全体の同期 ----------
  async function runSync() {
    const c = await client();
    const { data: s } = await c.auth.getSession();
    user = s.session?.user || null;
    if (!user) { setStatus("login"); return; }
    setStatus("syncing");
    // 1) 保留中の削除
    const del = readSet(LS_DEL);
    for (const id of [...del]) { await removeRemote(id); del.delete(id); writeSet(LS_DEL, del); }
    // 2) 差分の比較
    const { data: rows, error } = await c.from("notes").select("id,updated,data");
    if (error) throw error;
    const remote = new Map(rows.map(r => [r.id, r]));
    const local = new Map((await dbAll()).map(n => [n.id, n]));
    const dirty = readSet(LS_DIRTY);
    let pulled = 0;
    for (const [id, r] of remote) {
      const l = local.get(id);
      if (typeof cur !== "undefined" && cur && cur.id === id) continue; // 編集中は触らない
      if (!l || (r.updated > l.updated && !dirty.has(id))) { await pullNote(r); pulled++; }
    }
    for (const [id, l] of local) {
      const r = remote.get(id);
      if (!r || dirty.has(id) || l.updated > r.updated) { await pushNote(l); dirty.delete(id); writeSet(LS_DIRTY, dirty); }
    }
    localStorage.setItem(LS_LAST, Date.now());
    setStatus("ok");
    if (pulled && window.reload) await window.reload();
  }
  function sync() {
    if (!localStorage.getItem(LS_ON)) return Promise.resolve();
    if (running) return running;
    running = runSync().catch(e => { setStatus("error", e.message || String(e)); }).finally(() => { running = null; });
    return running;
  }

  // ---------- app.js から呼ぶ ----------
  const Sync = {
    onStatus: f => listeners.push(f),
    get status() { return status; }, get error() { return errMsg; },
    get email() { return localStorage.getItem(LS_ON) || ""; },
    get last() { return +localStorage.getItem(LS_LAST) || 0; },
    sync,
    // メモ保存のたびに呼ぶ（少し待ってまとめて送る）
    notify(id) {
      if (!localStorage.getItem(LS_ON)) return;
      const d = readSet(LS_DIRTY); d.add(id); writeSet(LS_DIRTY, d);
      clearTimeout(timer); timer = setTimeout(sync, 2000);
    },
    // 完全削除したメモ
    forget(id) {
      if (!localStorage.getItem(LS_ON)) return;
      const d = readSet(LS_DEL); d.add(id); writeSet(LS_DEL, d);
      const dd = readSet(LS_DIRTY); dd.delete(id); writeSet(LS_DIRTY, dd);
      clearTimeout(timer); timer = setTimeout(sync, 1000);
    },
    async login(email, password, signup) {
      const c = await client();
      const r = signup ? await c.auth.signUp({ email, password }) : await c.auth.signInWithPassword({ email, password });
      if (r.error) throw r.error;
      if (!r.data.session) throw new Error("確認メールが必要な設定になっています。管理者に連絡してください");
      localStorage.setItem(LS_ON, email);
      await sync();
    },
    async logout() {
      const c = await client();
      await c.auth.signOut();
      localStorage.removeItem(LS_ON); localStorage.removeItem(LS_LAST);
      setStatus("off");
    },
  };
  window.Sync = Sync;

  // 自動実行のきっかけ
  addEventListener("online", sync);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) sync(); });
  addEventListener("load", () => { if (localStorage.getItem(LS_ON)) { setStatus("syncing"); sync(); } });
})();
