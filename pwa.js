/* ============================================================================
   pwa.js — PWA layer for Talal's Trading Journal
   Injected right after the block that defines $, LS, S, save, fetchTab.
   Adds: Apps-Script API data mode (one bundle fetch), connect UI, entry modal
   (add trade / daily equity / delete row / edit stop), service worker,
   iOS safe-area, auto-refresh. Zero data or secrets live in this file.
   ========================================================================== */
"use strict";
(function () {
  window.__pwa = 1;
  var APP_VERSION = "v8.1"; /* shown in ⚙ settings — bump with every release (ties to sw.js VERSION) */
  window.APP_VERSION = APP_VERSION;

  /* ---------- one-tap setup via URL hash: #api=<encoded exec url>&key=<key> ---------- */
  try {
    if (location.hash && location.hash.indexOf("api=") > -1) {
      var hp = new URLSearchParams(location.hash.slice(1));
      var hu = hp.get("api"), hk = hp.get("key");
      if (hu && /^https:\/\/script\.google(usercontent)?\.com\/.+/.test(hu)) {
        S.api = hu; S.key = hk || ""; S.src = "sheet"; if (!S.id) S.id = "api";
        save();
        history.replaceState(null, "", location.pathname + location.search);
      }
    }
  } catch (_) {}
  if (S.api && !S.id) { S.id = "api"; save(); }

  /* ---------- API data mode: one bundle GET replaces 7 gviz fetches ---------- */
  var _fetchTab = window.fetchTab, _bundleP = null;
  window.fetchTab = async function (t) {
    if (!S.api) return _fetchTab(t);
    if (!_bundleP) {
      _bundleP = fetch(S.api + (S.api.indexOf("?") > -1 ? "&" : "?") + "api=data&key=" + encodeURIComponent(S.key || "") + "&_=" + Date.now(), { redirect: "follow" })
        .then(function (r) { if (!r.ok) throw new Error("API HTTP " + r.status); return r.json(); })
        .then(function (j) { if (j && j.error) throw new Error("API: " + j.error); return j; });
    }
    try {
      var b = await _bundleP;
      queueMicrotask(function () { _bundleP = null; }); // all 7 callers share one fetch; next refresh refetches
      var x = b[t] || "";
      try { localStorage.setItem(LS + "_" + t, x); } catch (_) {}
      return x;
    } catch (e) { _bundleP = null; throw e; }
  };

  /* ---------- writes ---------- */
  async function postAPI(action, payload) {
    if (!S.api) throw new Error("Not connected — tap ⚙ and connect the live API first.");
    var body = JSON.stringify(Object.assign({ key: S.key || "" }, payload, { action: action }));
    var r = await fetch(S.api, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: body, redirect: "follow" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    var j = await r.json().catch(function () { return { error: "Bad server response" }; });
    if (j.error) throw new Error(j.error);
    return j;
  }
  window.postAPI = postAPI;

  /* ---------- helpers ---------- */
  function iso(d) { var p = function (n) { return String(n).padStart(2, "0"); }; return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()); }
  function todayISO() { return iso(new Date()); }
  function netShares(sym) {
    var n = 0; (typeof TX!=="undefined"&&TX||[]).forEach(function (t) { if (t.sym === sym) n += (t.act === "B" ? t.sh : -t.sh); });
    return Math.round(n * 1e6) / 1e6;
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  /* ---------- v4.5: IBKR commission auto-include ----------
     Folds the broker commission into the SAVED price (Buy up / Sell down by comm ÷ shares)
     so sheet P&L matches the broker statement. FIXED = IBKR Fixed US-stock schedule:
     $0.005/share, $1.00 minimum, capped at 1% of trade value. CUSTOM keeps the 1% cap.
     Settings persist on S (commMode / commRate / commMin) via save() — same pattern as S.api. */
  function commMode() { var m = S.commMode; return m === "OFF" || m === "CUSTOM" ? m : "FIXED"; }
  function isOccTicker() { /* v8.0: the entry form is on an option leg (OCC symbol) — commissions are per CONTRACT, not per share */
    try { var t = document.getElementById("enTicker"); return !!(t && /^[A-Z.]+ \d{6}[CP]\d{8}$/i.test(String(t.value || "").trim().replace(/\s+/g, " "))); } catch (_) { return false; }
  }
  function commFor(shares, price) {
    var m = commMode();
    if (m === "OFF" || !(shares > 0) || !(price > 0)) return null; // empty / invalid fields → no adjust
    if (isOccTicker()) return Math.max(0.65 * shares, 1); // v8.0: IBKR Fixed US options — $0.65 per contract, $1 minimum (a 0.00 expiry row never gets here: price must be > 0)
    var rate = 0.005, min = 1;
    if (m === "CUSTOM") {
      rate = parseFloat(S.commRate); if (!(rate >= 0)) rate = 0.005;
      min = parseFloat(S.commMin); if (!(min >= 0)) min = 1;
    }
    return Math.min(Math.max(rate * shares, min), 0.01 * shares * price); // max stays IBKR's 1%-of-value cap
  }
  function r2c(v) { return Math.round((v + 1e-9) * 100) / 100; } // half-up at 2dp; epsilon absorbs FP dust (100.004999… → 100.01)
  window.commPerShare = function (shares, price) { /* v5.9g: exit-commission per share — the sell-plan ladder + breakeven nudge price their targets commission-true with this */
    var c = commFor(shares, price);
    return c == null ? 0 : c / shares;
  };
  function commAdj(side, shares, price) { // → {comm, eff} or null (OFF / fields empty)
    var c = commFor(shares, price);
    if (c == null) return null;
    var per = isOccTicker() ? shares * 100 : shares; // v8.0: an option premium is per share of the 100-share contract
    var eff = r2c(side === "Sell" ? price - c / per : price + c / per);
    if (!(eff > 0)) eff = price; // never a zero/negative price — pure guard, unreachable under the 1% cap
    return { comm: c, eff: eff };
  }

  /* ---------- DOM (runs after full parse; boot() has already fired) ---------- */
  function init() {
    if (document.getElementById("entryBtn")) return;

    /* ----- CSS: safe-area + entry modal ----- */
    var st = document.createElement("style");
    st.textContent =
      "body{padding-top:calc(24px + env(safe-area-inset-top,0px));padding-bottom:calc(24px + env(safe-area-inset-bottom,0px))}" +
      "@media(max-width:1100px){body{padding:12px;padding-top:calc(12px + env(safe-area-inset-top,0px));padding-bottom:calc(12px + env(safe-area-inset-bottom,0px))}}" +
      ".enGrid{display:grid;grid-template-columns:1fr 1fr;gap:4px 10px;margin-top:10px}" +
      ".enGrid label{font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--dim);margin-top:6px;display:block}" +
      ".enGrid input,.enGrid select{width:100%;margin:2px 0 0;padding:10px;background:#0e1420;color:var(--tx);border:1px solid var(--bd);border-radius:9px;font:600 13px Inter;outline:none;color-scheme:dark}" +
      "body.light .enGrid input,body.light .enGrid select,body.light .enRow input{background:#fff;color:#0f172a;color-scheme:light}" +
      "body.light .enTabs{background:rgba(15,23,42,.04)}" +
      "body.light .enOk{background:rgba(11,138,95,.08);border-color:rgba(11,138,95,.35);color:#0b6b4f}" +
      "body.light .enRow{border-bottom-color:rgba(15,23,42,.09)}" +
      "body.light .enRow .b{background:rgba(15,23,42,.04)}" +
      "body.light .enRow .b.del{color:#c2344c}" +
      "body.light .enRow .b.arm{background:rgba(201,65,65,.12);color:#c2344c}" +
      "body.light .enRow .b.st{color:#0b6b4f}" +
      "body.light #entryModal .btnrow{background:#fff}" +
      "body.light .wiRow,body.light .wiHead{border-bottom-color:rgba(15,23,42,.09)}" +
      "body.light #tabbar button.on{color:#0b6b4f}" +
      ".enGrid .full{grid-column:1/-1}" +
      ".enTabs{display:flex;gap:4px;background:rgba(255,255,255,.03);border:1px solid var(--bd);border-radius:12px;padding:4px;margin:2px 0 6px}" +
      ".enOk{display:none;background:rgba(52,211,153,.1);border:1px solid rgba(52,211,153,.35);color:#7ef0c6;border-radius:12px;padding:10px 14px;font-size:12.5px;margin-top:12px}" +
      ".enRow{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.05);font-size:12.5px}" +
      ".enRow .b{border:1px solid var(--bd);background:rgba(255,255,255,.04);color:var(--mut);border-radius:8px;padding:5px 9px;font:700 11px Inter;cursor:pointer}" +
      ".enRow .b.del{color:#ffb3bf;border-color:rgba(251,113,133,.4)}" +
      ".enRow .b.arm{background:rgba(251,113,133,.18);color:#ff8fa0;border-color:rgba(251,113,133,.7)}" +
      ".enRow .b.st{color:#7ef0c6;border-color:rgba(52,211,153,.4)}" +
      ".enRow input{width:84px;padding:5px 7px;background:#0e1420;color:var(--tx);border:1px solid var(--bd);border-radius:8px;font:600 12px Inter}" +
      "#entryModal .modal{max-width:520px;max-height:88vh;overflow:auto}" +
      "#entryModal .btnrow{position:sticky;bottom:-28px;background:#0d1320;padding:10px 0 6px;margin-bottom:-10px}" +
      ".enTabs .chip{flex:1;min-height:42px}" +
      "#enPrev{font-size:11.5px;color:var(--cyn);margin-top:8px;min-height:14px}" +
      /* ---- v5.5: one-tap sells — fraction chips (Sell side, held ticker) + realized-result toast ---- */
      "#enFracRow{display:flex;align-items:center;gap:6px;margin:6px 0 2px;flex-wrap:wrap}" +
      "#enFracRow .flbl{font-size:11px;color:var(--dim);font-weight:700;letter-spacing:.04em}" +
      ".fchip{border:1px solid var(--bd);background:none;color:var(--mut);border-radius:999px;padding:6px 13px;font:700 12px Inter;cursor:pointer;touch-action:manipulation}" +
      ".fchip.on{border-color:var(--cyn);color:var(--cyn);background:rgba(45,212,160,.10)}" +
      "#tjToast{position:fixed;right:18px;bottom:18px;z-index:70;background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:12px 16px;box-shadow:0 18px 50px -12px rgba(0,0,0,.45);font:600 13px Inter;color:var(--tx);cursor:pointer;max-width:340px;transition:opacity .35s,transform .35s}" +
      "#tjToast.hide{opacity:0;transform:translateY(8px)}" +
      "#tjToast .t1{font-weight:800;letter-spacing:.02em}" +
      "#tjToast .t2{margin-top:3px}" +
      "#tjToast .t3{margin-top:5px;font-size:11px;color:var(--dim);font-weight:600}" +
      /* ---- v4.6: What-if tab — read-only calculator ---- */
      "#wiOut{margin-top:10px;background:rgba(255,255,255,.02);border:1px solid var(--bd);border-radius:12px;padding:4px 12px;min-height:40px}" +
      "body.light #wiOut{background:rgba(15,23,42,.03)}" +
      ".wiRow{padding:6px 0;border-bottom:1px solid rgba(255,255,255,.05);font-size:12.4px;line-height:1.5}" +
      ".wiRow:last-child{border-bottom:0}" +
      ".wiRow .num{font-variant-numeric:tabular-nums}" +
      ".wiHead{padding:9px 0 3px;font-size:9.5px;font-weight:800;letter-spacing:.09em;color:var(--dim);text-transform:uppercase;border-bottom:1px solid rgba(255,255,255,.05)}" + /* v4.6b: portfolio-block header */
      "#wiNote{font-size:11px;color:var(--dim);margin-top:10px}" +
      /* ---- v7.9: OFFSET PLANNER — pick losses, plan the cover ---- */
      "#ofTg{margin-top:10px}" +
      "#ofList{max-height:250px;overflow-y:auto;margin-top:8px;background:rgba(255,255,255,.02);border:1px solid var(--bd);border-radius:12px;padding:5px}" +
      "body.light #ofList{background:rgba(15,23,42,.03)}" +
      ".ofRow{display:flex;gap:8px;align-items:baseline;padding:6px 8px;border-radius:9px;cursor:pointer;font-size:12.2px;border:1px solid transparent;user-select:none}" +
      ".ofRow .ck{width:15px;flex:none;color:var(--dim)}" +
      ".ofRow.sel{background:rgba(240,106,106,.09);border-color:rgba(240,106,106,.4)}" +
      ".ofRow.sel .ck{color:#f06a6a;font-weight:800}" +
      ".ofRow .sym{font-weight:700;min-width:54px}" +
      ".ofRow .dt{color:var(--dim);flex:1;font-size:11px}" +
      ".ofChips{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px}" +
      ".ofChips .chip{min-height:34px;padding:5px 12px;font-size:11.5px}" +
      ".ofForm{display:flex;gap:6px;align-items:center;margin-top:7px;flex-wrap:wrap}" +
      ".ofForm select,.ofForm input{flex:1;min-width:90px}" +
      ".ofForm .btn{padding:8px 14px;min-height:38px}" +
      ".ofItem{display:flex;gap:8px;align-items:baseline;padding:5px 2px;font-size:12.2px;border-bottom:1px solid rgba(255,255,255,.05)}" +
      ".ofItem:last-child{border-bottom:0}" +
      ".ofItem .rm{cursor:pointer;color:var(--dim);font-weight:800;padding:0 6px;flex:none}" +
      ".ofItem .rm:hover{color:#f06a6a}" +
      ".ofItem .what{flex:1}" +
      "@media(max-width:520px){#entryModal{align-items:end;padding:0}#entryModal .modal{max-width:none;width:100%;border-radius:20px 20px 0 0;max-height:92dvh;padding-bottom:calc(16px + env(safe-area-inset-bottom,0px))}}" +
      "@media(display-mode:standalone){#dataPill{display:inline-block}}" +

      /* ---- iOS app chrome round (2026-07-16): tab bar, pull-to-refresh, touch polish ---- */
      "*{-webkit-tap-highlight-color:transparent}" +
      "button,.chip,.pill,.btn{touch-action:manipulation}" +
      "div[style*='overflow-x'],div[style*='overflow:auto']{-webkit-overflow-scrolling:touch;overscroll-behavior-x:contain}" +
      "#tabbar{display:none;position:fixed;left:0;right:0;bottom:0;z-index:40;background:rgba(9,12,19,.94);backdrop-filter:blur(20px) saturate(1.4);-webkit-backdrop-filter:blur(20px) saturate(1.4);border-top:1px solid var(--bd);padding:6px 6px calc(6px + env(safe-area-inset-bottom,0px));justify-content:space-around}" +
      "body.light #tabbar{background:rgba(245,247,251,.94)}" +
      "#tabbar button{flex:1;max-width:104px;border:0;background:none;color:var(--mut);font:600 10px Inter;display:flex;flex-direction:column;align-items:center;gap:3px;padding:5px 2px;border-radius:12px;cursor:pointer}" +
      "#tabbar button .ic{font-size:19px;line-height:1.15}" +
      "#tabbar button.on{color:#7ef0c6}" +
      "#tabbar button:active{opacity:.65}" +
      "#tabbar #tbAdd .ic{width:36px;height:36px;border-radius:999px;background:linear-gradient(135deg,#34d399,#22d3ee);color:#06251c;display:grid;place-items:center;font-weight:800;margin-top:-16px;box-shadow:0 6px 18px -6px rgba(52,211,153,.55)}" +
      "#ptr{position:fixed;top:calc(4px + env(safe-area-inset-top,0px));left:50%;z-index:60;transform:translate(-50%,-70px);background:#0d1320;border:1px solid var(--bd);border-radius:999px;padding:9px 16px;font:700 12px Inter;color:var(--cyn);box-shadow:0 10px 30px -10px rgba(0,0,0,.6);transition:transform .25s;pointer-events:none;white-space:nowrap}" +
      "body.light #ptr{background:#fff}" +
      "@media(max-width:640px){" +
        "html{-webkit-text-size-adjust:100%}" +
        "body{padding-bottom:calc(88px + env(safe-area-inset-bottom,0px))}" +
        "#tabbar{display:flex}" +
        "#pgChips,#entryBtn,#reloadBtn{display:none}" +
        ".chips{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;max-width:100%}" +
        ".chips::-webkit-scrollbar{display:none}" +
        ".chip{padding:11px 13px;font-size:13px;white-space:nowrap}" +
        ".pill{padding:8px 13px;font-size:12px;display:inline-flex;align-items:center}" +
        "select,input[type=date],input[type=text],input[type=number]{font-size:16px;min-height:42px}" +
        ".enGrid input,.enGrid select{font-size:16px;min-height:44px}" +
        ".enRow input{font-size:16px;width:110px}" +
        ".enRow .b{padding:9px 12px}" +
        ".btn{min-height:48px}" +
        ".fchip{padding:10px 16px;font-size:14px}" + /* v5.5: thumb-sized fraction chips */
        "#tjToast{left:12px;right:12px;bottom:calc(96px + env(safe-area-inset-bottom,0px));max-width:none}" + /* v5.5: toast clears the tab bar */
      "}";
    document.head.appendChild(st);

    /* ----- header ＋ Add button ----- */
    var rb = $("reloadBtn");
    var eb = document.createElement("span");
    eb.className = "pill btn live"; eb.id = "entryBtn"; eb.textContent = "＋ Add";
    if (rb && rb.parentNode) rb.parentNode.insertBefore(eb, rb); else document.querySelector("header").appendChild(eb);

    /* ----- v5.9i: version visible in the QUICK ⚙ panel too (he shouldn't dig for it) ----- */
    { var co = $("connOpen");
      if (co && co.parentNode && !$("appVerQ")) {
        var vq = document.createElement("div");
        vq.id = "appVerQ";
        vq.style.cssText = "font-size:10.5px;color:var(--dim);margin-top:8px;text-align:center";
        vq.textContent = "Journal " + APP_VERSION;
        co.parentNode.appendChild(vq);
      } }

    /* ----- setup modal: live-API section ----- */
    var sm = document.querySelector("#setup .modal");
    if (sm) {
      var sec = document.createElement("div");
      sec.innerHTML =
        '<div style="border-top:1px solid var(--bd);margin:16px 0 10px"></div>' +
        '<h2 style="font-size:16px">Live connection (phone &amp; PWA)</h2>' +
        '<p>Paste your private <b>Apps Script web-app URL</b> and <b>access key</b>. Data then loads through your own Google account server-side — the sheet does not need public sharing, and you can add entries from any device.</p>' +
        '<input type="text" id="apiUrl" placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off">' +
        '<input type="text" id="apiKey" placeholder="Access key" autocomplete="off">' +
        '<div id="apiState" style="font-size:11.5px;color:var(--dim);margin:2px 0 6px"></div>' +
        '<div class="btnrow"><button class="btn pri" id="apiConnectBtn">Connect live API</button>' +
        '<button class="btn sec" id="apiForgetBtn" style="min-width:90px;flex:0">Forget</button></div>' +

        /* v4.5: commission auto-include — persisted on S like the API settings above */
        '<div style="border-top:1px solid var(--bd);margin:16px 0 10px"></div>' +
        '<h2 style="font-size:16px">Commission (IBKR)</h2>' +
        '<p><b>v7.5: saves no longer auto-add commission.</b> Type the EXACT charge in the trade form (empty = price already includes it). These rates power the planning tools only — What-if, risk previews, the sell ladder, and the estimate hint. <b>FIXED</b> = IBKR Fixed US-stock schedule: $0.005/share, $1.00 minimum, capped at 1% of trade value.</p>' +
        '<div class="enTabs" id="commTabs" style="max-width:360px">' +
        '<button class="chip" data-comm="OFF">OFF</button>' +
        '<button class="chip" data-comm="FIXED">FIXED</button>' +
        '<button class="chip" data-comm="CUSTOM">CUSTOM</button></div>' +
        '<div class="enGrid" id="commCust" style="display:none">' +
        '<div><label>Per-share rate ($)</label><input type="number" id="commRate" inputmode="decimal" step="any" min="0" placeholder="0.005"></div>' +
        '<div><label>Minimum per order ($)</label><input type="number" id="commMin" inputmode="decimal" step="any" min="0" placeholder="1.00"></div></div>' +
        '<div id="commState" style="font-size:11.5px;color:var(--dim);margin-top:8px"></div>' +
        /* v5.9d: visible version label — bumped every release so "am I on the latest?" is one tap away */
        '<div style="border-top:1px solid var(--bd);margin:16px 0 10px"></div>' +
        '<div id="appVer" style="font-size:11.5px;color:var(--dim)">Journal <b>' + APP_VERSION + '</b> · checks for updates every time you open it</div>';
      sm.appendChild(sec);
      var stateLine = function () {
        $("apiState").textContent = S.api ? ("Connected: …" + S.api.slice(-30) + (S.key ? " · key •••" + String(S.key).slice(-4) : "")) : "Not connected.";
        if (S.api) $("apiUrl").value = S.api; if (S.key) $("apiKey").value = S.key;
      };
      stateLine();
      $("apiConnectBtn").onclick = function () {
        var u = ($("apiUrl").value || "").trim(), k = ($("apiKey").value || "").trim();
        if (!/^https:\/\/script\.google(usercontent)?\.com\/.+/.test(u)) { alert("That doesn't look like an Apps Script web-app URL (…script.google.com/macros/s/…/exec)."); return; }
        S.api = u; S.key = k; S.src = "sheet"; if (!S.id) S.id = "api"; save(); stateLine();
        $("setup").classList.remove("show"); window.loadSheet && loadSheet();
      };
      $("apiForgetBtn").onclick = function () { delete S.api; delete S.key; if (S.id === "api") S.id = ""; save(); stateLine(); };

      /* v4.5: commission section wiring */
      var commSync = function () {
        var m = commMode();
        sec.querySelectorAll("#commTabs .chip").forEach(function (b) { b.classList.toggle("on", b.dataset.comm === m); });
        $("commCust").style.display = m === "CUSTOM" ? "" : "none";
        if (m === "CUSTOM") { $("commRate").value = S.commRate != null && S.commRate !== "" ? S.commRate : 0.005; $("commMin").value = S.commMin != null && S.commMin !== "" ? S.commMin : 1; }
        $("commState").textContent =
          m === "OFF" ? "Estimates off — planning tools show raw prices; saves always use the exact box." :
          m === "FIXED" ? "Estimates use $0.005/share ($1.00 min, 1% max) in planning tools; saves use the exact box." :
          "Estimates use your per-share rate + minimum in planning tools; saves use the exact box.";
      };
      sec.querySelectorAll("#commTabs .chip").forEach(function (b) {
        b.onclick = function () { S.commMode = b.dataset.comm; save(); commSync(); };
      });
      ["commRate", "commMin"].forEach(function (id) {
        $(id).oninput = function () {
          var v = parseFloat(this.value);
          S[id] = isFinite(v) && v >= 0 ? v : ""; // S.commRate / S.commMin
          save();
        };
      });
      commSync();
    }

    /* ----- entry modal ----- */
    var ov = document.createElement("div");
    ov.className = "overlay"; ov.id = "entryModal";
    ov.innerHTML =
      '<div class="modal">' +
      '<h2 id="enTitle">Add to journal</h2>' +
      '<div class="enTabs">' +
      '<button class="chip on" data-en="T" id="enTabT">Trade</button>' +
      '<button class="chip" data-en="D" id="enTabD">Daily equity</button>' +
      '<button class="chip" data-en="R" id="enTabR">Fix rows</button>' +
      '<button class="chip" data-en="W" id="enTabW">What-if</button>' +
      "</div>" +
      '<div class="err" id="enErr"></div><div class="enOk" id="enOk"></div>' +

      '<div id="enPaneT">' +
      '<div class="enGrid">' +
      '<div><label>Date</label><input type="date" id="enDate"></div>' +
      '<div><label>Ticker</label><input type="text" id="enTicker" list="enTickers" placeholder="AMD" autocapitalize="characters" autocomplete="off"><datalist id="enTickers"></datalist></div>' +
      '<div><label>Action</label><select id="enAction"><option>Buy</option><option>Sell</option></select></div>' +
      '<div><label>Shares</label><input type="number" id="enShares" inputmode="decimal" step="any" min="0" placeholder="10"></div>' +
      /* v5.5: fraction chips — visible only when the side is Sell and the ticker is an open position */
      '<div class="full" id="enFracRow" style="display:none"><span class="flbl">of <span id="enFracN" class="num"></span> held:</span>' +
      '<button type="button" class="fchip" data-f="f13">⅓</button><button type="button" class="fchip" data-f="f12">½</button>' +
      '<button type="button" class="fchip" data-f="f23">⅔</button><button type="button" class="fchip" data-f="all">ALL</button></div>' +
      '<div><label>Price</label><input type="number" id="enPrice" inputmode="decimal" step="any" min="0" placeholder="538.50"></div>' +
      '<div><label>Stop (col F)</label><input type="number" id="enStop" inputmode="decimal" step="any" min="0" placeholder="optional"></div>' +
      '<div><label>Pivot</label><input type="number" id="enPivot" inputmode="decimal" step="any" min="0" placeholder="optional"></div>' +
      '<div><label>Setup</label><input type="text" id="enSetup" list="enSetups" placeholder="optional" autocomplete="off"><datalist id="enSetups"></datalist></div>' +
      '<div class="full"><label>Note</label><input type="text" id="enNote" placeholder="optional" autocomplete="off"></div>' +
      /* v5.9e: per-trade commission tick — defaults to the ⚙ setting on every open; untick when the
         typed price ALREADY includes commission (e.g. statement "avg price incl. commission"). */
      /* v7.5: EXACT commission per trade — no more auto-adding. Empty = the typed price is saved
         untouched (he already included it); a $ amount = exactly that charge folds into the price
         (Buy up, Sell down by comm ÷ shares). The ⚙ rates live on only as planning estimates. */
      '<div class="full"><label>Commission ($ — exact charge from IBKR)</label><input type="number" id="enComm" inputmode="decimal" step="any" min="0" placeholder="empty = price saves exactly as typed">' +
      '<div id="enCommHint" style="font-size:11px;color:var(--dim);margin-top:3px"></div></div>' +
      "</div>" +
      '<div id="enPrev" class="num"></div>' +
      '<div class="btnrow"><button class="btn pri" id="enSubmit">Save trade</button><button class="btn sec" id="enSubmitA" style="flex:0;min-width:118px">Save + another</button><button class="btn sec" id="enClose1" style="flex:0;min-width:70px">Close</button></div>' +
      '<p style="font-size:11px;color:var(--dim);margin-top:10px">Saved straight into the <b>Transactions</b> tab of your Google Sheet. Sells are blocked if they would exceed what you hold.</p>' +
      "</div>" +

      '<div id="enPaneD" style="display:none">' +
      '<div class="enGrid">' +
      /* v5.9h: entry mode — NET LIQ (type the broker's account value) or CASH + POSITIONS
         (type settled cash; the app adds open positions at live/last prices and saves the sum).
         The Daily tab always stores EQUITY either way — curve, MAs and RS are untouched. */
      '<div class="full"><div class="enTabs" id="dnMode" style="max-width:380px;margin-bottom:2px">' +
      '<button type="button" class="chip" data-dn="NAV">NET LIQ</button>' +
      '<button type="button" class="chip" data-dn="CASH">CASH + POSITIONS</button></div></div>' +
      '<div><label>Date</label><input type="date" id="dnDate"></div>' +
      '<div><label id="dnEqLbl">Equity (account NAV)</label><input type="number" id="dnEq" inputmode="decimal" step="any" min="0" placeholder="52678.42"></div>' +
      '<div><label>Deposit / withdrawal today</label><input type="number" id="dnFl" inputmode="decimal" step="any" placeholder="0"></div>' +
      "</div>" +
      '<div id="dnPrev" class="num" style="font-size:11.5px;color:var(--dim);margin-top:6px"></div>' +
      '<div class="btnrow"><button class="btn pri" id="dnSubmit">Save equity</button><button class="btn sec" id="enClose2">Close</button></div>' +
      '<p style="font-size:11px;color:var(--dim);margin-top:10px">Adds or updates that date’s row in the <b>Daily</b> tab (powers the equity curve). Positive flow = deposit, negative = withdrawal.</p>' +
      "</div>" +

      '<div id="enPaneR" style="display:none">' +
      '<p style="margin-top:0">Latest transaction rows. <b>Delete</b> needs a second tap to confirm. <b>Stop</b> edits the stop-loss on a buy row (your risk math uses it).</p>' +
      '<div id="enRows"></div>' +
      '<div class="btnrow"><button class="btn sec" id="enClose3">Close</button></div>' +
      "</div>" +

      /* v4.6: What-if — sizes a hypothetical add/trim against live equity + the model band; never posts */
      '<div id="enPaneW" style="display:none">' +
      '<div class="enGrid">' +
      '<div><label>Ticker</label><input type="text" id="wiTicker" list="wiTickers" placeholder="AVGO" autocapitalize="characters" autocomplete="off"><datalist id="wiTickers"></datalist></div>' +
      '<div><label>Side</label><select id="wiSide"><option>Buy</option><option>Sell</option></select></div>' +
      '<div><label>Shares</label><input type="number" id="wiShares" inputmode="decimal" step="any" min="0" placeholder="10"></div>' +
      '<div><label>Price</label><input type="number" id="wiPrice" inputmode="decimal" step="any" min="0" placeholder="live auto-fills"></div>' +
      '<div class="full"><label>Stop price (optional — risk line)</label><input type="number" id="wiStop" inputmode="decimal" step="any" min="0" placeholder="optional"></div>' +
      "</div>" +
      '<div id="wiGuard9" style="margin:6px 0 2px"></div>' + /* v7.3: period profit guard — tick to show/hide */
      '<div id="wiOut"></div>' +
      /* ---- v7.9: OFFSET PLANNER — tap real closed losses → target, then plan sells (realized now) and stop raises (locked only if filled) until it's covered. Calculator only. ---- */
      '<button class="chip" id="ofTg" type="button">Offset planner ▸</button>' +
      '<div id="ofBody" style="display:none">' +
      '<p style="margin:7px 0 0;font-size:11.5px;color:var(--dim)">Tap the closed trades you want to make back — usually the losses; wins in between just stay unticked. Then add partial sells or stop raises until the target is covered. Nothing here posts or saves.</p>' +
      '<div class="ofChips" id="ofScopeRow"></div>' +
      '<div id="ofList"></div>' +
      '<div id="ofPlan"></div>' +
      "</div>" +
      '<div class="btnrow"><button class="btn sec" id="enClose4">Close</button></div>' +
      '<p id="wiNote">Calculator only — nothing is saved. Holdings use your live avg cost; commission follows the setting in ⚙ Commission (IBKR).</p>' +
      "</div>" +
      "</div>";
    document.body.appendChild(ov);

    var panes = { T: "enPaneT", D: "enPaneD", R: "enPaneR", W: "enPaneW" };
    function enTab(w) {
      Object.keys(panes).forEach(function (k) { $(panes[k]).style.display = k === w ? "" : "none"; $("enTab" + k).classList.toggle("on", k === w); });
      msg(); if (w === "R") renderRows(); if (w === "W") { wiSyms(); wiCalc(); ofRender(); } // v7.9: planner re-reads the ledger on every visit
    }
    ["T", "D", "R", "W"].forEach(function (k) { $("enTab" + k).onclick = function () { enTab(k); }; });

    function msg(err, ok) {
      var e = $("enErr"), o = $("enOk");
      e.textContent = err || ""; e.classList.toggle("show", !!err);
      o.textContent = ok || ""; o.style.display = ok ? "block" : "none";
    }

    var noteAuto = null; // v5.5: the exact note the stopped-out prefill wrote — cleared on the next fresh open unless the user edited it
    function openModal() {
      msg();
      $("enTitle").textContent = "Add to journal"; // v5.5: the stopped-out prefill retitles — every normal open resets it
      if (noteAuto !== null && $("enNote").value === noteAuto) $("enNote").value = ""; // untouched machine note never leaks into the next trade
      noteAuto = null;
      $("enDate").value = todayISO(); $("dnDate").value = todayISO();
      $("dnEq").value = ""; $("dnFl").value = ""; // v7.1: every fresh open re-derives the carried cash — stale typed values are exactly the drift this kills
      refreshTickerList();
      var sets = {}; (typeof TX!=="undefined"&&TX||[]).forEach(function (t) { if (t.set) sets[t.set] = 1; });
      $("enSetups").innerHTML = Object.keys(sets).map(function (s) { return "<option value=\"" + esc(s) + "\">"; }).join("");
      $("enComm").value = ""; commHintSync(); // v7.5: exact-commission box starts empty every open; hint shows the ⚙ estimate
      updPrev();
      fracSync();
      ov.classList.add("show");
    }
    eb.onclick = openModal;
    ["enClose1", "enClose2", "enClose3", "enClose4"].forEach(function (id) { $(id).onclick = function () { ov.classList.remove("show"); }; });
    ov.addEventListener("click", function (e) { if (e.target === ov) ov.classList.remove("show"); });

    /* live preview + ADD detection + sell prefill (GPT UX round) */
    function lastBuyOf(tk) {
      var arr = (typeof TX !== "undefined" && TX || []);
      for (var i = arr.length - 1; i >= 0; i--) if (arr[i].sym === tk && arr[i].act === "B") return arr[i];
      return null;
    }
    function openSyms() {
      var m = {}; (typeof TX !== "undefined" && TX || []).forEach(function (t) { m[t.sym] = (m[t.sym] || 0) + (t.act === "B" ? t.sh : -t.sh); });
      return Object.keys(m).filter(function (s) { return m[s] > 1e-9; }).map(function (s) { return { sym: s, sh: Math.round(m[s] * 100) / 100 }; });
    }
    function refreshTickerList() {
      if ($("enAction").value === "Sell") {
        $("enTickers").innerHTML = openSyms().map(function (o) { return "<option value=\"" + esc(o.sym) + "\" label=\"" + o.sh + " held\">"; }).join("");
      } else {
        var tks = {}; (typeof POS !== "undefined" && POS || []).forEach(function (p) { if (p && p.sym) tks[p.sym] = 1; });
        (typeof TX !== "undefined" && TX || []).slice(-60).reverse().forEach(function (t) { tks[t.sym] = 1; });
        $("enTickers").innerHTML = Object.keys(tks).slice(0, 40).map(function (s) { return "<option value=\"" + esc(s) + "\">"; }).join("");
      }
    }
    /* v5.9e: reset the tick to the ⚙ setting on every modal open (deliberately not sticky —
       a forgotten override would silently mis-price every later trade). */
    function commHintSync() { /* v7.5: reference only — the ⚙ formula's estimate for the typed size, to copy when it matches the statement */
      var el = $("enCommHint"); if (!el) return;
      var sh = parseFloat($("enShares").value), px = parseFloat($("enPrice").value);
      var c = commFor(sh, px);
      el.textContent = c == null ? (commMode() === "OFF" ? "⚙ estimates are OFF — type the exact charge or leave empty" : "type shares + price to see the ⚙ estimate") :
        "⚙ estimate for this size: $" + c.toFixed(2) + " — type the EXACT charge from the statement (or leave empty if your price already includes it)";
    }
    function updPrev() {
      var a = $("enAction").value, tk = ($("enTicker").value || "").trim().toUpperCase();
      var sh = parseFloat($("enShares").value), px = parseFloat($("enPrice").value), st = parseFloat($("enStop").value);
      var out = [];
      var eq = (typeof DAILY !== "undefined" && DAILY && DAILY.length) ? DAILY[DAILY.length - 1].eq : null;
      var net = tk ? netShares(tk) : 0;
      if (a === "Buy" && net > 0) {
        $("enSubmit").textContent = "Save ADD-ON buy";
        var lb = lastBuyOf(tk);
        if (lb) { if (!$("enStop").value && lb.stop) $("enStop").value = lb.stop; if (!$("enPivot").value && lb.pivot) $("enPivot").value = lb.pivot; if (!$("enSetup").value && lb.set) $("enSetup").value = lb.set; }
      } else $("enSubmit").textContent = "Save trade";
      /* v7.5: the risk preview prices off the EXACT typed commission (empty box → price as typed) */
      var cIn = $("enComm") ? $("enComm").value : "", cAmt = cIn === "" ? null : parseFloat(cIn);
      var ex = px;
      if (cAmt != null && isFinite(cAmt) && cAmt >= 0 && sh > 0 && px > 0) ex = r2c(a === "Sell" ? px - cAmt / sh : px + cAmt / sh);
      if (a === "Buy" && sh > 0 && px > 0 && st > 0 && st < ex) {
        var r = sh * (ex - st);
        out.push("RISK $" + Math.round(r).toLocaleString() + (eq ? " · " + (100 * r / eq).toFixed(2) + "% NAV" : "") + " · stop " + (100 * (ex - st) / ex).toFixed(1) + "% away");
      } else if (a === "Buy" && sh > 0 && px > 0 && !$("enStop").value) out.push("No stop = unmeasured risk (shows unstopped in SCAR)");
      if (a === "Sell" && tk && net > 0) {
        var after = sh > 0 ? Math.max(0, net - Math.min(sh, net)) : net;
        out.push("HOLDING " + net + (sh > 0 ? " → " + after + " after (" + (100 * Math.min(sh, net) / net).toFixed(0) + "% reduced)" : " shares"));
      }
      if (cAmt != null && isFinite(cAmt) && cAmt >= 0 && sh > 0 && px > 0) out.push("comm $" + cAmt.toFixed(2) + " → eff " + ex.toFixed(2));
      else if (sh > 0 && px > 0) out.push("no commission typed — saves exactly as typed");
      commHintSync();
      $("enPrev").textContent = out.join("  ·  ");
    }
    function prefillSell() {
      refreshTickerList();
      if ($("enAction").value === "Sell") {
        var n = netShares(($("enTicker").value || "").trim().toUpperCase());
        if (n > 0 && !$("enShares").value) $("enShares").value = n;
      }
      updPrev();
      fracSync();
    }
    $("enAction").onchange = prefillSell; $("enTicker").onchange = prefillSell;
    ["enTicker", "enShares", "enPrice", "enStop"].forEach(function (id) {
      $(id).oninput = function () { updPrev(); if (id === "enTicker" || id === "enShares") fracSync(); }; // v5.5: chips track the ticker + shares live
    });
    { var _ec = $("enComm"); if (_ec) _ec.oninput = updPrev; } // v7.5: preview follows the exact amount live

    /* ---- v5.5: fraction chips — ⅓ ½ ⅔ ALL of the held shares, Sell side only ----
       N = remaining shares from the app's POS for the typed ticker (the same live rows the
       Holdings table shows). A chip only ever writes into the shares field — the user still
       reviews and taps Save. Buy side or a ticker that isn't held → the row hides. The active
       mark follows the field value, so typing 30 by hand lights ⅓ when 30 IS a third. */
    var FRACS = { f13: 1 / 3, f12: 1 / 2, f23: 2 / 3, all: 1 };
    function fracPos() {
      if ($("enAction").value !== "Sell") return null;
      var tk = ($("enTicker").value || "").trim().toUpperCase(); if (!tk) return null;
      return (typeof POS !== "undefined" && POS || []).find(function (q) { return q.sym === tk; }) || null;
    }
    function fracVal(n, f) { return f === 1 ? n : Math.max(1, Math.floor(n * f)); } // ALL = the exact remainder; fractions floor, never 0
    function fracSync() {
      var row = $("enFracRow"); if (!row) return;
      var p = fracPos();
      if (!p || !(p.sh > 0)) { row.style.display = "none"; return; }
      row.style.display = "";
      $("enFracN").textContent = Math.round(p.sh * 100) / 100;
      var cur = parseFloat($("enShares").value);
      row.querySelectorAll(".fchip").forEach(function (b) {
        b.classList.toggle("on", isFinite(cur) && cur > 0 && Math.abs(fracVal(p.sh, FRACS[b.dataset.f]) - cur) < 1e-9);
      });
    }
    ov.querySelectorAll("#enFracRow .fchip").forEach(function (b) {
      b.onclick = function () {
        var p = fracPos(); if (!p) return;
        $("enShares").value = fracVal(p.sh, FRACS[b.dataset.f]);
        updPrev(); fracSync();
      };
    });

    function busy(btn, on, txt) { btn.disabled = on; btn.textContent = on ? "Saving…" : txt; btn.style.opacity = on ? ".6" : "1"; }

    /* ---- v5.5: post-save result toast — after a SELL lands, a small card shows what was
       sold and the realized result vs basis. FIFO consumes the oldest open lots' cost when
       S.lots is FIFO; AVG uses the blended basis — the same numbers the Holdings table runs
       on. Basis unknown (ticker not among the open positions) → the realized line is simply
       omitted. Fixed-position, tap or ~7s to dismiss; never blocks the modal or the refresh. */
    function sellToast(p, snap) {
      try {
        var old = document.getElementById("tjToast"); if (old) old.remove();
        var line2 = "";
        if (snap && snap.basis > 0) {
          var mlt = snap.mlt || 1, left = p.shares, cost = 0;
          if (S.lots === "AVG") cost = p.shares * snap.basis;
          else { // FIFO: the sold shares take the oldest open lots' cost, oldest first
            for (var i = 0; i < snap.lots.length && left > 1e-9; i++) {
              var k = Math.min(snap.lots[i].sh, left); cost += k * snap.lots[i].px; left -= k;
            }
            if (left > 1e-9) cost += left * snap.basis; // past the open lots (the oversell guard already blocks this) — blended basis for the rest
          }
          if (cost > 0) {
            var real = (p.shares * p.price - cost) * mlt, pct = 100 * (p.shares * p.price - cost) / cost;
            line2 = "<div class='t2'>realized <b class='num " + (real >= 0 ? "g-grn" : "g-red") + "'>" +
              (real >= 0 ? "+" : "−") + "$" + Math.abs(real).toFixed(2) + " · " +
              (pct >= 0 ? "+" : "−") + Math.abs(pct).toFixed(1) + "%</b></div>";
          }
        }
        var el = document.createElement("div");
        el.id = "tjToast"; el.setAttribute("role", "status");
        el.innerHTML = "<div class='t1'>SOLD " + p.shares + " " + esc(p.ticker) + " @ " + (+p.price).toFixed(2) + "</div>" +
          line2 + "<div class='t3'>account value updates automatically</div>";
        document.body.appendChild(el);
        var gone = function () { if (!el.parentNode) return; el.classList.add("hide"); setTimeout(function () { if (el.parentNode) el.remove(); }, 380); };
        el.addEventListener("click", gone);
        setTimeout(gone, 7000);
      } catch (_) {}
    }

    var lastSig = null, lastSigT = 0, dupOk = false;
    /* v5.9c: local echo — append the saved trade to the cached Transactions so the v5.9
       instant paint can never show a position you already sold (or miss a buy), even if
       the refresh below never completes (app closed, dead network). The next successful
       sync overwrites the whole cache with the sheet's truth, so the echo is temporary. */
    /* v5.9f: one shared cache-repaint — every write echoes into localStorage, then this
       repaints the whole app from the caches so no screen can show a pre-write snapshot. */
    function reRenderFromCache() {
      var c = function (t) { return localStorage.getItem(LS + "_" + t); };
      if (window.loadSheetData && c("Transactions") && c("Daily") && c("Prices")) {
        loadSheetData(c("Transactions"), c("Daily"), c("Prices"), c("Live") || "Ticker,Price", c("Signals") || "", c("Leaders") || "", c("Yields") || "", c("Macro") || "", c("Earnings") || "");
        if (window.render) render();
      }
    }
    function echoTrade(p) {
      try {
        var k = LS + "_Transactions", cur = localStorage.getItem(k);
        if (!cur) return;
        var cell = function (v) { return String(v == null ? "" : v).replace(/[,\r\n]+/g, " "); };
        var line = [p.date, p.ticker, p.side, p.shares, p.price, p.stop, p.pivot, p.setup, p.lot || "", "", "", "", p.notes || ""].map(cell).join(",");
        localStorage.setItem(k, cur.replace(/\n+$/, "") + "\n" + line);
        reRenderFromCache();
      } catch (e) {}
    }
    /* v5.9f: find the cached Transactions line for a Fix-rows match {date,ticker,side,shares,price}
       — same fields the server matches on. Matching only reads cols 0-4, so quoted notes are safe. */
    function cacheRowIndex(m) {
      var cur = localStorage.getItem(LS + "_Transactions");
      if (!cur) return { lines: null, idx: -1 };
      var lines = cur.split("\n"), want = /^s/i.test(m.side) ? "S" : "B";
      for (var i = 1; i < lines.length; i++) {
        var c = lines[i].split(",");
        if ((c[0] || "").slice(0, 10) === m.date &&
            (c[1] || "").trim().toUpperCase() === m.ticker &&
            ((c[2] || "").trim().charAt(0).toUpperCase() === want) &&
            parseFloat(c[3]) === m.shares && parseFloat(c[4]) === m.price) return { lines: lines, idx: i };
      }
      return { lines: lines, idx: -1 };
    }
    function echoDelete(m) { /* v5.9f: deleted rows vanish from Holdings + Fix list instantly */
      try {
        var f = cacheRowIndex(m);
        if (f.idx > -1) { f.lines.splice(f.idx, 1); localStorage.setItem(LS + "_Transactions", f.lines.join("\n")); reRenderFromCache(); }
      } catch (e) {}
    }
    function echoStop(m, v) { /* v5.9f: stop edits show instantly (skips quoted lines — sync fixes those) */
      try {
        var f = cacheRowIndex(m);
        if (f.idx > -1 && f.lines[f.idx].indexOf('"') === -1) {
          var c = f.lines[f.idx].split(","); c[5] = v; f.lines[f.idx] = c.join(",");
          localStorage.setItem(LS + "_Transactions", f.lines.join("\n")); reRenderFromCache();
        }
      } catch (e) {}
    }
    function echoDaily(d, eq, fl) { /* v5.9f: equity saves paint instantly (append/replace, in-order only) */
      try {
        var k = LS + "_Daily", cur = localStorage.getItem(k);
        if (!cur) return;
        var lines = cur.replace(/\n+$/, "").split("\n"), done = false;
        for (var i = 1; i < lines.length; i++) { if ((lines[i] || "").slice(0, 10) === d) { lines[i] = d + "," + eq + "," + (fl || 0); done = true; break; } }
        if (!done) { var last = (lines[lines.length - 1] || "").slice(0, 10); if (d >= last) lines.push(d + "," + eq + "," + (fl || 0)); else return; }
        localStorage.setItem(k, lines.join("\n")); reRenderFromCache();
      } catch (e) {}
    }
    async function submitTrade(btn, keep) {
      msg();
      var p = {
        date: $("enDate").value, ticker: ($("enTicker").value || "").trim().toUpperCase().replace(/\s+/g, " "),
        side: $("enAction").value, shares: parseFloat($("enShares").value), price: parseFloat($("enPrice").value),
        stop: $("enStop").value === "" ? "" : parseFloat($("enStop").value),
        pivot: $("enPivot").value === "" ? "" : parseFloat($("enPivot").value),
        setup: $("enSetup").value || "", lot: "", notes: $("enNote").value || ""
      };
      if (!p.date) return msg("Pick a date.");
      if (!p.ticker) return msg("Ticker is required.");
      if (!(p.shares > 0)) return msg("Shares must be a positive number.");
      var occ8 = /^[A-Z.]+ \d{6}[CP]\d{8}$/.test(p.ticker); /* v8.0: option leg — a 0.00 close is how an expiry / assignment is booked */
      if (!(p.price > 0) && !(occ8 && p.price === 0)) return msg("Price must be a positive number" + (occ8 ? " (0 only for an expired / assigned contract)." : "."));
      /* v5.5: oversell guard + basis snapshot — POS is read BEFORE the save, so the toast's
         realized math uses the position exactly as it stood at the moment of the sale. */
      var snap = null;
      if (p.side === "Sell") {
        var sp = (typeof POS !== "undefined" && POS || []).find(function (q) { return q.sym === p.ticker; });
        if (sp) {
          if (p.shares > sp.sh + 1e-9) return msg("only " + (Math.round(sp.sh * 100) / 100) + " held — selling more would go short");
          snap = { basis: sp.basis, mlt: sp.mlt || 1, lots: (sp.lots || []).map(function (L) { return { sh: L.sh, px: L.px }; }) };
        }
      }
      /* v7.5: EXACT commission — the box's $ amount folds in (Buy up / Sell down by comm ÷ shares);
         empty box = the typed price IS the saved price. No formula ever touches a save again. */
      var cIn5 = $("enComm").value, cAmt5 = cIn5 === "" ? null : parseFloat(cIn5);
      if (cIn5 !== "" && !(cAmt5 >= 0)) return msg("Commission must be zero or a positive amount — or leave it empty.");
      var per8 = occ8 ? p.shares * 100 : p.shares; /* v8.0: an option premium is per share of the 100-share contract */
      if (cAmt5 != null && p.price > 0 && cAmt5 > 0.05 * per8 * p.price) return msg("That commission is over 5% of the trade value — check the amount.");
      if (cAmt5 != null && cAmt5 > 0 && p.price > 0) p.price = r2c(p.side === "Sell" ? Math.max(0, p.price - cAmt5 / per8) : p.price + cAmt5 / per8);
      var sig = [p.date, p.ticker, p.side, p.shares, p.price].join("|");
      if (sig === lastSig && Date.now() - lastSigT < 30000 && !dupOk) {
        dupOk = true;
        return msg("Looks identical to the trade you just saved. Tap Save again if it's really a second fill.");
      }
      if (p.side === "Buy" && p.stop === "") msg("", "Tip: buys without a stop show as unstopped in SCAR / Playbook. Saving anyway…");
      var lbl = btn.textContent;
      busy(btn, true, lbl);
      try {
        await postAPI("addTrade", p);
        echoTrade(p); /* v5.9c: holdings update this second — no waiting on the slow refetch */
        lastSig = sig; lastSigT = Date.now(); dupOk = false;
        msg("", p.side + " " + p.shares + " " + p.ticker + " @ " + p.price + " saved ✓" + (keep ? " — next one:" : ""));
        if (p.side === "Sell") sellToast(p, snap); // v5.5: realized-result toast — non-blocking, sells only
        $("enShares").value = ""; $("enPrice").value = ""; $("enNote").value = ""; $("enComm").value = ""; // v7.5: exact charge never carries into the next fill
        if (!keep) { $("enTicker").value = ""; $("enStop").value = ""; $("enPivot").value = ""; $("enSetup").value = ""; }
        $("enPrev").textContent = "";
        fracSync(); // v5.5: shares just cleared — drop the active chip mark (row hides with the ticker on a full clear)
        /* v7.0: the account just changed — force the equity step so it can't be forgotten.
           Same-modal switch (not a popup): the Daily pane opens prefilled for today with the
           cash/NAV chips ready. "Save + another" skips the switch (more fills coming) — the
           sticky banner still nags on every device until a Daily row lands. */
        if (!keep && window.eqDue9 && window.eqDue9()) {
          enTab("D"); dnModeUI(); $("dnDate").value = todayISO();
          msg("", p.side + " " + p.shares + " " + p.ticker + " saved ✓ — one more step: update your equity (cash or NAV) so today's record is true.");
          setTimeout(function () { var el = $("dnEq"); try { el.focus(); } catch (_) {} }, 80);
        }
        window.loadSheet && loadSheet();
      } catch (e) { msg(e.message); }
      busy(btn, false, keep ? "Save + another" : "Save trade");
      if (keep) $("enShares").focus();
    }
    $("enSubmit").onclick = function () { return submitTrade(this, false); };
    $("enSubmitA").onclick = function () { return submitTrade(this, true); };

    /* ---------- v4.5: quick-sell prefill hook — Holdings rows (index.html qsell) call this.
       Opens the Trade tab prefilled; the user reviews and taps Save — nothing auto-submits.
       v5.5: o.stopped (index.html qstop) marks a stopped-out exit — the header says so and the
       note starts as "stop hit" (anything the user types after it is kept); the saved row is
       otherwise a completely normal Sell (price = the stop, commission applies as usual). ---------- */
    window.openTradePrefill = function (o) {
      o = o || {};
      openModal(); // date=today, ticker/setup datalists refreshed, title reset
      enTab("T");
      $("enTicker").value = o.ticker ? String(o.ticker).trim().toUpperCase() : "";
      $("enAction").value = o.side === "Sell" ? "Sell" : "Buy";
      refreshTickerList(); // sell mode → datalist flips to open positions
      $("enShares").value = o.shares != null && isFinite(o.shares) ? o.shares : "";
      $("enPrice").value = o.price != null && isFinite(o.price) && o.price > 0 ? Math.round(o.price * 100) / 100 : (o.price === 0 ? "0" : ""); /* v8.0: an explicit 0 = expired / assigned option close */
      $("enStop").value = ""; $("enPivot").value = ""; $("enSetup").value = ""; $("enNote").value = "";
      if (o.stopped) {
        var nv = $("enNote").value;
        $("enNote").value = nv ? nv + " — stop hit" : "stop hit";
        noteAuto = $("enNote").value; // remembered so an unsaved close doesn't leak "stop hit" into the next open
        $("enTitle").textContent = "SELL — stopped out";
      }
      updPrev();
      fracSync(); // v5.5: held ticker on the Sell side → the fraction row appears (ALL lights when shares = the full position)
      setTimeout(function () { var el = $("enShares"); try { el.focus(); el.select(); } catch (_) {} }, 60); // focus lands on shares
    };

    window.openEquityEntry = function () { /* v7.0: the equity-nag banner lands HERE — straight into the Daily-equity pane, today's date, cash/NAV chips ready */
      openModal(); enTab("D"); dnModeUI();
      setTimeout(function () { var el = $("dnEq"); try { el.focus(); } catch (_) {} }, 80);
    };

    /* ---------- v4.6: What-if tab — read-only position calculator (never posts) ----------
       New avg with commission folded in (same commAdj a real save would apply), position
       weight of equity, portfolio exposure after vs the market-model band (_mmTier), and
       stop-risk vs the 0.25–0.5%-NAV sizing guide. Recomputes on every input; no network. */
    function wiPos(tk) { return (typeof POS !== "undefined" && POS || []).find(function (p) { return p.sym === tk; }) || null; }
    function wiLivePx(tk) {
      var p = wiPos(tk); if (p && p.px > 0) return p.px; // held → the same live-or-last-close price the Holdings table shows
      var lv = (typeof LIVE !== "undefined" && LIVE) ? LIVE[tk] : null;
      return (lv != null && lv > 0) ? lv : null;
    }
    function wiSyms() {
      var dl = $("wiTickers"); if (!dl) return;
      dl.innerHTML = (typeof POS !== "undefined" && POS || []).map(function (p) { return "<option value=\"" + esc(p.sym) + "\" label=\"" + (Math.round(p.sh * 100) / 100) + " held\">"; }).join("");
    }
    var wiMan = false; // price typed by hand — autofill stops overriding until the ticker changes again
    function wiAutoPx() {
      var tk = ($("wiTicker").value || "").trim().toUpperCase();
      var lp = wiLivePx(tk);
      if (lp != null) { $("wiPrice").value = Math.round(lp * 100) / 100; wiMan = false; }
      else if (!wiMan) $("wiPrice").value = "";
    }
    function wiGuard9() { /* v7.3: profit guard — realized $ inside the journal-selected period vs this idea's stop risk.
       "Don't risk more than the period already paid you": banked ≤ 0 → the risk is fresh capital, size accordingly. */
      var el = $("wiGuard9"); if (!el) return;
      var on = S.wiGuard !== "OFF";
      var r = window.realizedWin9 ? window.realizedWin9() : null;
      var head = '<label style="display:flex;gap:6px;align-items:center;font-size:11px;color:var(--dim);cursor:pointer"><input type="checkbox" id="wiGuardTick"' + (on ? " checked" : "") + '> profit guard <span style="opacity:.8">(period from the journal: ' + esc(S.tf || "YTD") + ')</span></label>';
      var body = "";
      if (on && r) {
        var dG = function (v) { return (v < 0 ? "−$" : "+$") + Math.round(Math.abs(v)).toLocaleString(); };
        body = "realized " + esc(S.tf || "") + ": <b class='num " + (r.sum >= 0 ? "g-grn" : "g-red") + "'>" + dG(r.sum) + "</b>" + (r.n ? " <span style='color:var(--dim)'>(" + r.n + " sell" + (r.n > 1 ? "s" : "") + ")</span>" : "");
        var sh9 = parseFloat($("wiShares").value), px9 = parseFloat($("wiPrice").value), st9 = parseFloat($("wiStop").value);
        if ($("wiSide").value === "Buy" && sh9 > 0 && px9 > 0 && st9 > 0) {
          var ca9 = commAdj("Buy", sh9, px9), ef9 = ca9 ? ca9.eff : px9; // planning estimate (⚙ rates) — saves use the exact box
          if (st9 < ef9) {
            var rk9 = sh9 * (ef9 - st9);
            body += " · this idea risks <b class='num'>$" + Math.round(rk9).toLocaleString() + "</b> → " +
              (r.sum <= 0 ? "<b class='g-amb'>nothing banked this period — that risk is fresh capital</b>"
                : rk9 <= r.sum ? "<b class='g-grn'>✓ stays under the period's profit</b>"
                : "<b class='g-red'>⚠ exceeds it by $" + Math.round(rk9 - r.sum).toLocaleString() + "</b>");
          } else body += " <span class='g-amb'>· stop must sit below the (effective) price to compare</span>";
        } else body += " <span style='color:var(--dim)'>· enter shares, price and a stop to compare the risk</span>";
      }
      el.innerHTML = head + (body ? "<div class='wiRow' id='wiGuardLine'>" + body + "</div>" : "");
      var tk9 = $("wiGuardTick"); if (tk9) tk9.onchange = function () { S.wiGuard = tk9.checked ? "ON" : "OFF"; save(); wiGuard9(); };
    }
    function wiCalc() {
      wiGuard9(); // v7.3: the guard lives above the output and re-reads on every input change
      var out = $("wiOut"); if (!out) return;
      var tk = ($("wiTicker").value || "").trim().toUpperCase();
      var side = $("wiSide").value;
      var sh = parseFloat($("wiShares").value), px = parseFloat($("wiPrice").value), st = parseFloat($("wiStop").value);
      var p = tk ? wiPos(tk) : null, mlt = p ? (p.mlt || 1) : 1;
      /* v7.4: campaigns that already banked a piece lead with the NET break-even — "the PANW you
         calculate the 307.12, not the original 324.47." tradeBE is the whole campaign's true
         break-even on the saved (commission-inclusive) prices; untouched positions keep plain avg. */
      var net4 = p && p.soldSh > 0 && p.tradeBE != null && isFinite(p.tradeBE) ? p.tradeBE : null;
      var eqL = (typeof EQABS !== "undefined" && EQABS && typeof EQ !== "undefined" && EQ.length) ? EQ[EQ.length - 1] : null;
      var inv = (typeof POS !== "undefined" && POS || []).reduce(function (a, q) { return a + q.val; }, 0);
      var row = function (id, html) { return "<div class='wiRow' id='" + id + "'>" + html + "</div>"; };
      var d$ = function (v) { return (v < 0 ? "−$" : "$") + Math.round(Math.abs(v)).toLocaleString(); };
      var L = [];
      if (!tk) { out.innerHTML = row("wiMsg", "<span style='color:var(--dim)'>Type a ticker — held positions auto-fill their live price; any other symbol works once you enter a price.</span>"); return; }
      if (p) L.push(row("wiNow", "<b>" + esc(p.disp || tk) + "</b> — holding <span class='num'>" + (Math.round(p.sh * 100) / 100) + "</span> sh @ " + (net4 != null ? "<b class='num'>" + net4.toFixed(2) + "</b> <span style='color:var(--dim)'>NET</span> · initial <span class='num'>" + p.basis.toFixed(2) + "</span>" : "avg <span class='num'>" + p.basis.toFixed(2) + "</span>") + " · live <span class='num'>" + (p.px > 0 ? p.px.toFixed(2) : "—") + "</span>" + (p.est ? " <span class='g-amb'>(est)</span>" : "")));
      else L.push(row("wiNow", "<b>" + esc(tk) + "</b> — not held today" + (wiLivePx(tk) != null ? " · live <span class='num'>" + wiLivePx(tk).toFixed(2) + "</span>" : "")));
      if (!(px > 0)) { L.push(row("wiMsg", "<span class='g-amb'>enter a price</span> — no live quote for " + esc(tk) + ".")); out.innerHTML = L.join(""); return; }
      if (!(sh > 0)) { L.push(row("wiMsg", "<span style='color:var(--dim)'>enter shares to size the trade.</span>")); out.innerHTML = L.join(""); return; }
      if (side === "Sell" && !p) { L.push(row("wiMsg", "<span class='g-red'>you don't hold " + esc(tk) + "</span> — nothing to sell here.")); out.innerHTML = L.join(""); return; }
      var used = sh, clamped = false;
      if (side === "Sell") { used = Math.min(sh, p.sh); clamped = used < sh; } // the executable order is the clamped size — commission prices off it
      var ca = commAdj(side, used, px), comm = ca ? ca.comm : 0, eff = ca ? ca.eff : px; // OFF → zero commission, raw price
      var newSh, newAvg, real$ = null;
      if (side === "Buy") {
        newSh = (p ? p.sh : 0) + sh;
        /* v7.4: the blend base is the NET break-even when profit is already banked; the plain-avg
           blend stays visible for reference. Untouched positions behave exactly as before. */
        var base4 = p ? (net4 != null ? net4 : p.basis) : null;
        newAvg = p ? (p.sh * base4 + sh * eff) / newSh : eff; // commission-inclusive effective price feeds the blend
        var plain4 = (p && net4 != null) ? (p.sh * p.basis + sh * eff) / newSh : null;
        L.push(row("wiAfter", "after <b class='g-grn'>BUY " + sh + "</b>: <span class='num'>" + (Math.round(newSh * 100) / 100) + "</span> sh @ new " + (plain4 != null ? "<b>NET</b> b/e " : "avg ") + "<b class='num'>" + newAvg.toFixed(2) + "</b>" + (plain4 != null ? " <span style='color:var(--dim)'>(banked profit counted · plain avg " + plain4.toFixed(2) + ")</span>" : "") + (p ? "" : " (new position)")));
      } else {
        newSh = p.sh - used; newAvg = p.basis;
        real$ = used * (eff - p.basis) * mlt; // sold piece vs avg — avg itself never moves on a sell
        L.push(row("wiAfter", "after <b class='g-red'>SELL " + used + (clamped ? " (clamped to held)" : "") + "</b>: <span class='num'>" + (Math.round(newSh * 100) / 100) + "</span> sh · avg unchanged <span class='num'>" + newAvg.toFixed(2) + "</span> · realized <b class='num " + (real$ >= 0 ? "g-grn" : "g-red") + "'>" + (real$ >= 0 ? "+" : "−") + "$" + Math.abs(real$).toFixed(2) + "</b>"));
      }
      L.push(row("wiComm", commMode() === "OFF"
        ? "<span style='color:var(--dim)'>commission OFF — $0.00, raw price used</span>"
        : "comm <span class='num'>$" + comm.toFixed(2) + "</span> → eff <span class='num'>" + eff.toFixed(2) + "</span> folded into " + (side === "Buy" ? "the new avg" : "the sale proceeds")));
      if (eqL) {
        var posVal = newSh * px * mlt, wgt = 100 * posVal / eqL, trade$ = used * px * mlt;
        L.push(row("wiVal", "position after: <b class='num'>" + d$(posVal) + "</b> · <b class='num'>" + wgt.toFixed(1) + "%</b> of equity"));
      } else L.push(row("wiVal", "<span class='g-amb'>add Daily equity rows to size weight, exposure and the band check.</span>"));
      if (st > 0 && st < eff) {
        var risk$ = used * (eff - st) * mlt, rPct = eqL ? 100 * risk$ / eqL : null;
        var cls = rPct == null ? "g-amb" : rPct <= 0.5 ? "g-grn" : rPct <= 1 ? "g-amb" : "g-red";
        L.push(row("wiRisk", "stop risk <b class='num " + cls + "'>" + d$(risk$) + (rPct != null ? " · " + rPct.toFixed(2) + "% NAV" : "") + "</b> <span style='color:var(--dim)'>(sizing guide 0.25–0.5% NAV)</span>"));
      } else if ($("wiStop").value !== "") {
        L.push(row("wiRisk", "<span class='g-amb'>stop must sit below the (effective) price for a risk read.</span>"));
      }
      /* ---- v4.6b: PORTFOLIO AFTER THIS TRADE — before → after for the decision metrics.
         All local: POS values + per-lot stops (ADD-GATE rule — a lot with no stop is unmeasured
         and excluded from the covered risk) + live equity eqL. Equity stays marked at eqL; a buy
         spends cost+commission, a sell credits proceeds−commission, so cash = eqL − investedAfter
         − comm on both sides. The simulated shares mark at the What-if price and carry the
         What-if stop when provided; sells consume lots FIFO (same order deriveAll retires them).
         The old standalone exposure line lives here now (same string) — no duplication. ---- */
      if (eqL) {
        var invA = inv + (side === "Buy" ? trade$ : -trade$);
        var eN = Math.round(100 * inv / eqL), eA = Math.round(100 * invA / eqL);
        L.push("<div class='wiHead' id='wiPortHead'>Portfolio after this trade</div>");
        L.push(row("wiExpo", "portfolio exposure: <span class='num'>" + eN + "%</span> → <b class='num'>" + eA + "%</b> after <span style='color:var(--dim)'>(invested " + d$(inv) + " " + (side === "Buy" ? "+" : "−") + " " + d$(trade$) + " ÷ equity " + d$(eqL) + ")</span>"));
        var cashN = eqL - inv, cashA = eqL - invA - comm;
        L.push(row("wiCash", "cash remaining: <span class='num'>" + d$(cashN) + "</span> → <b class='num" + (cashA < 0 ? " g-red" : "") + "'>" + d$(cashA) + "</b>" + (cashA < 0 ? " <span class='g-red'>— more than your cash (margin)</span>" : "")));
        var isFull = side === "Sell" && newSh <= 1e-9;
        var cntN = POS.length, cntA = cntN + (side === "Buy" && !p ? 1 : 0) - (isFull ? 1 : 0);
        L.push(row("wiCount", "open positions: <span class='num'>" + cntN + "</span> → <b class='num'>" + cntA + "</b><span style='color:var(--dim)'>" + (side === "Buy" && !p ? " (+" + esc(tk) + " new)" : isFull ? " (" + esc(tk) + " closed)" : "") + "</span>"));
        var wN = null, wNs = "", wA = null, wAs = "";
        POS.forEach(function (q) {
          var w0 = 100 * q.val / eqL; if (wN == null || w0 > wN) { wN = w0; wNs = q.sym; }
          var w1 = 100 * (q.sym === tk ? posVal : q.val) / eqL; if (wA == null || w1 > wA) { wA = w1; wAs = q.sym; }
        });
        if (!p && side === "Buy" && (wA == null || wgt > wA)) { wA = wgt; wAs = tk; }
        if (wA != null) {
          var wCls = wA > 35 ? "g-red" : wA > 25 ? "g-amb" : "g-grn"; // spec thresholds: amber >25% of equity, red >35%
          L.push(row("wiLgWt", "largest position: " + (wN == null ? "—" : "<span class='num'>" + esc(wNs) + " " + wN.toFixed(1) + "%</span>") + " → <b class='num " + wCls + "'>" + (wAs === wNs ? "" : esc(wAs) + " ") + wA.toFixed(1) + "%</b>" + (wA > 25 ? " <span class='" + wCls + "'>" + (wA > 35 ? "— concentration red line" : "— concentrated") + "</span>" : "")));
        }
        var stV = st > 0 ? st : null, riskN = 0, riskA = 0, unA = 0; // unA = open lots with no stop AFTER the trade (the row's caveat)
        POS.forEach(function (q) {
          var qm = q.mlt || 1, ls = (q.lots && q.lots.length) ? q.lots : [{ sh: q.sh, stop: q.stop }];
          ls.forEach(function (Lx) { if (Lx.stop != null) riskN += Lx.sh * (q.px - Lx.stop) * qm; });
          if (q.sym !== tk) { ls.forEach(function (Lx) { if (Lx.stop == null) unA++; else riskA += Lx.sh * (q.px - Lx.stop) * qm; }); return; }
          var la = ls.map(function (Lx) { return { sh: Lx.sh, stop: Lx.stop }; });
          if (side === "Sell") { var left = used; for (var i2 = 0; i2 < la.length && left > 1e-9; i2++) { var k2 = Math.min(la[i2].sh, left); la[i2].sh -= k2; left -= k2; } }
          else la.push({ sh: used, stop: stV });
          la.forEach(function (Lx) { if (Lx.sh <= 1e-9) return; if (Lx.stop == null) unA++; else riskA += Lx.sh * (px - Lx.stop) * qm; });
        });
        if (!p && side === "Buy") { if (stV != null) riskA += used * (px - stV) * mlt; else unA++; }
        var rN$ = Math.max(0, riskN), rA$ = Math.max(0, riskA); // stops locked above price = profits, not risk — floor at $0 like SCAR
        L.push(row("wiAllRisk", "all-stops risk: <span class='num'>" + d$(rN$) + " · " + (100 * rN$ / eqL).toFixed(1) + "%</span> → <b class='num'>" + d$(rA$) + " · " + (100 * rA$ / eqL).toFixed(1) + "% NAV</b>" + (unA ? " <span class='g-amb'>· " + unA + " lot" + (unA > 1 ? "s" : "") + " unmeasured</span>" : "") + " <span style='color:var(--dim)'>(if every stop hits)</span>"));
        var MT = window._mmTier;
        if (MT && MT.b0 != null) {
          var bandTxt = (String(MT.lab || "").split(" — ")[0] || "model") + " " + MT.b0 + "–" + MT.b1 + "% band";
          if (eA >= MT.b0 && eA <= MT.b1) L.push(row("wiBand", "<b class='g-grn'>→ " + eA + "% exposure — inside the " + bandTxt + " ✓</b>"));
          else if (eA > MT.b1) L.push(row("wiBand", "<b class='g-red'>→ " + eA + "% exposure — above the " + bandTxt + " — breaks the band ✗</b>"));
          else L.push(row("wiBand", "<b class='g-amb'>→ " + eA + "% exposure — below the " + bandTxt + " — breaks the band ✗</b>"));
        }
      }
      out.innerHTML = L.join("");
    }
    $("wiTicker").oninput = function () { wiAutoPx(); wiCalc(); };
    $("wiTicker").onchange = function () { wiAutoPx(); wiCalc(); };
    $("wiPrice").oninput = function () { wiMan = $("wiPrice").value !== ""; wiCalc(); };
    ["wiShares", "wiStop"].forEach(function (id) { $(id).oninput = wiCalc; });
    $("wiSide").onchange = wiCalc;

    /* v4.6: lot-ladder header link (index.html qwhatif) lands here — same hook shape as openTradePrefill */
    window.openWhatIf = function (sym) {
      openModal(); enTab("W");
      $("wiTicker").value = sym ? String(sym).trim().toUpperCase() : "";
      $("wiShares").value = ""; $("wiStop").value = ""; $("wiSide").value = "Buy"; // clean slate — the link prefills the ticker only
      wiMan = false; wiAutoPx(); wiCalc();
      setTimeout(function () { var el = $("wiShares"); try { el.focus(); el.select(); } catch (_) {} }, 60);
    };

    /* ---------- v7.9: OFFSET PLANNER — "which losses am I making back, and what exactly covers them?"
       List = the same closed campaigns deriveAll posts (commission-inclusive prices, RECON rows excluded),
       each with its exact ±$ (t.dol). Tapping rows builds the target; the plan side adds partial SELLS
       (realized the moment you'd execute, vs your live avg basis) and STOP RAISES (locked in ONLY IF the
       stop fills — a gap can open lower, so the two subtotals are never mixed). Plan items store intent
       only (sym + shares / sym + stop); every dollar is re-derived from the LIVE position on each render,
       so price moves, lot-mode changes and real fills keep the plan honest. Pure calculator: nothing
       posts, nothing saves, selection resets on reload. ---------- */
    var ofSel = {}, ofItems = [], ofScope = "P", ofNote = ""; // P = journal period selector · A = all history
    function ofKey(t) { return t.sym + "|" + (+t.dout) + "|" + (+t.din); }
    function dP9(v) { var a = Math.abs(v), s = a >= 1000 ? Math.round(a).toLocaleString() : a.toFixed(2); return (v < 0 ? "−$" : "+$") + s; }
    function ofClosedAll() {
      return (typeof TRADES !== "undefined" && TRADES || []).filter(function (t) { return !t.open && !t.recon && t.pct != null && t.dol != null; });
    }
    function ofTrades() {
      var all = ofClosedAll();
      if (ofScope === "P" && typeof win === "function") {
        try { var w = win(); if (w && w[2] && w[3]) all = all.filter(function (t) { return t.dout >= w[2] && t.dout <= w[3]; }); } catch (e) {}
      }
      return all.sort(function (a, b) { return b.dout - a.dout; });
    }
    function ofSellSh(sym, skip) { // shares already claimed by planned sells of this symbol
      var s = 0; ofItems.forEach(function (it, i) { if (it.k === "S" && it.sym === sym && i !== skip) s += it.sh; }); return s;
    }
    function ofRender() {
      var body = $("ofBody"); if (!body || body.style.display === "none") return;
      var sr = $("ofScopeRow");
      if (sr) {
        sr.innerHTML =
          '<button class="chip' + (ofScope === "P" ? " on" : "") + '" id="ofScP" type="button">period · ' + esc(S.tf || "YTD") + "</button>" +
          '<button class="chip' + (ofScope === "A" ? " on" : "") + '" id="ofScA" type="button">all history</button>' +
          '<button class="chip" id="ofAllL" type="button">tick every loss</button>' +
          '<button class="chip" id="ofClr" type="button">clear</button>';
        $("ofScP").onclick = function () { ofScope = "P"; ofRender(); };
        $("ofScA").onclick = function () { ofScope = "A"; ofRender(); };
        $("ofAllL").onclick = function () { ofTrades().forEach(function (t) { if (t.dol < 0) ofSel[ofKey(t)] = 1; }); ofRender(); };
        $("ofClr").onclick = function () { ofSel = {}; ofRender(); };
      }
      var list = $("ofList"), T9 = ofTrades();
      if (list) {
        if (!T9.length) list.innerHTML = '<div style="color:var(--dim);font-size:12px;padding:6px">no closed trades ' + (ofScope === "P" ? "in this period — widen the period selector (top of the journal) or switch to all history." : "yet.") + "</div>";
        else {
          var CAP = 60, shown = T9.slice(0, CAP);
          list.innerHTML = shown.map(function (t) {
            var k = ofKey(t), on = !!ofSel[k];
            return '<div class="ofRow' + (on ? " sel" : "") + '" data-k="' + esc(k) + '"><span class="ck">' + (on ? "✓" : "○") + '</span><span class="sym">' + esc(t.disp || t.sym) + '</span><span class="dt">' + (typeof hvDate === "function" ? hvDate(t.dout) : "") + " · " + (t.pct >= 0 ? "+" : "") + t.pct.toFixed(1) + "%" + (t.R != null && isFinite(t.R) ? " · " + (t.R > 0 ? "+" : "") + t.R.toFixed(1) + "R" : "") + '</span><b class="num ' + (t.dol >= 0 ? "g-grn" : "g-red") + '">' + dP9(t.dol) + "</b></div>";
          }).join("") + (T9.length > CAP ? '<div style="color:var(--dim);font-size:11px;padding:4px 8px">… ' + (T9.length - CAP) + " older trades hidden — narrow the period to reach them.</div>" : "");
          list.querySelectorAll(".ofRow").forEach(function (r) {
            r.onclick = function () { var k = r.getAttribute("data-k"); if (ofSel[k]) delete ofSel[k]; else ofSel[k] = 1; ofRender(); };
          });
        }
      }
      ofPlanUI();
    }
    function ofPlanUI() {
      var el = $("ofPlan"); if (!el) return;
      var selT = ofClosedAll().filter(function (t) { return ofSel[ofKey(t)]; }); // selection survives scope switches
      var sum = selT.reduce(function (a, t) { return a + t.dol; }, 0);
      var target = sum < 0 ? -sum : 0;
      var H = [];
      H.push('<div class="wiHead">Target</div>');
      if (!selT.length) H.push('<div class="wiRow" style="color:var(--dim)">nothing ticked yet — tap the losses above and the target builds here.</div>');
      else if (sum >= 0) H.push('<div class="wiRow">ticked ' + selT.length + " trade" + (selT.length > 1 ? "s" : "") + ": net <b class='num g-grn'>" + dP9(sum) + "</b> — nothing to offset. Untick the winners.</div>");
      else H.push('<div class="wiRow">ticked ' + selT.length + " trade" + (selT.length > 1 ? "s" : "") + ": <b class='num g-red'>" + dP9(sum) + "</b> → to make back: <b class='num'>$" + (target >= 1000 ? Math.round(target).toLocaleString() : target.toFixed(2)) + "</b></div>");
      // ---- plan forms (open positions only) ----
      var Ps = (typeof POS !== "undefined" && POS || []);
      H.push('<div class="wiHead">The cover</div>');
      if (!Ps.length) H.push('<div class="wiRow" style="color:var(--dim)">no open positions to plan with.</div>');
      else {
        var opts = Ps.map(function (p) { return '<option value="' + esc(p.sym) + '">' + esc(p.disp || p.sym) + " · " + (Math.round(p.sh * 100) / 100) + " held</option>"; }).join("");
        H.push('<div class="ofForm"><select id="ofSSym">' + opts + '</select><input type="number" id="ofSSh" inputmode="decimal" step="any" min="0" placeholder="shares"><button class="btn sec" id="ofSAdd" type="button">+ sell</button></div>');
        H.push('<div class="ofForm"><select id="ofPSym">' + opts + '</select><input type="number" id="ofPStop" inputmode="decimal" step="any" min="0" placeholder="new stop $"><button class="btn sec" id="ofPAdd" type="button">+ stop raise</button></div>');
      }
      if (ofNote) { H.push('<div class="wiRow g-amb" style="font-size:11.5px">' + ofNote + "</div>"); ofNote = ""; }
      // ---- items + live-derived dollars ----
      var sellNow = 0, lockIf = 0, comm9 = 0, sold$ = 0, fullCloses = 0, rows9 = [];
      ofItems.forEach(function (it, i) {
        var p = wiPos(it.sym), m = p ? (p.mlt || 1) : 1, txt, val = null, cls = "g-mut";
        if (!p) txt = "<b>" + esc(it.sym) + "</b> — no longer held; remove this line.";
        else if (it.k === "S") {
          var px = p.px > 0 ? p.px : null;
          if (px == null) txt = "<b>SELL " + it.sh + " " + esc(it.sym) + "</b> — no live price yet.";
          else {
            var ca = commAdj("Sell", it.sh, px), eff = ca ? ca.eff : px, cm = ca ? ca.comm : 0;
            val = it.sh * (eff - p.basis) * m; sellNow += val; comm9 += cm; sold$ += it.sh * px * m;
            cls = val >= 0 ? "g-grn" : "g-red";
            txt = "<b>SELL " + it.sh + " " + esc(it.sym) + "</b> @ ~" + px.toFixed(2) + " <span style='color:var(--dim)'>(avg " + p.basis.toFixed(2) + ")</span> → realized now <b class='num " + cls + "'>" + dP9(val) + "</b>";
          }
        } else {
          var shLeft = Math.max(0, p.sh - ofSellSh(it.sym));
          val = (it.stop - p.basis) * shLeft * m;
          var atLive = p.px > 0 && it.stop >= p.px;
          if (val > 0) { lockIf += val; cls = "g-grn"; }
          txt = "<b>STOP " + esc(it.sym) + " → " + it.stop.toFixed(2) + "</b> on " + (Math.round(shLeft * 100) / 100) + " sh <span style='color:var(--dim)'>(avg " + p.basis.toFixed(2) + ")</span> → " +
            (val > 0 ? "locks <b class='num g-grn'>" + dP9(val) + "</b> <span style='color:var(--dim)'>if it fills</span>" : "<span class='g-amb'>still a " + dP9(val) + " floor — a stop below your avg can't offset anything</span>") +
            (atLive ? " <span class='g-red'>· at/above the live price — that would trigger immediately (that's just a sell)</span>" : "");
        }
        rows9.push('<div class="ofItem"><span class="what">' + txt + '</span><span class="rm" data-i="' + i + '" title="remove">×</span></div>');
      });
      if (rows9.length) H.push(rows9.join(""));
      Ps.forEach(function (q) { var ps9 = ofSellSh(q.sym); if (ps9 > 0 && ps9 >= q.sh - 1e-9) fullCloses++; }); // full close = the SUM of planned lines empties the position, however it's split
      // ---- progress ----
      if (target > 0) {
        var covered = sellNow + lockIf, pctC = Math.max(0, Math.min(100, 100 * covered / target));
        H.push('<div class="wiHead">Covered</div>');
        H.push('<div class="wiRow"><b class="num">' + dP9(covered) + "</b> of the $" + (target >= 1000 ? Math.round(target).toLocaleString() : target.toFixed(2)) + " target" +
          (covered >= target ? " — <b class='g-grn'>✓ covered" + (covered - target > 0.5 ? ", " + dP9(covered - target) + " beyond" : "") + "</b>" : " — <b class='g-amb'>" + dP9(covered - target).replace("−$", "$") + " still short</b>") +
          '<span class="meter" style="display:block;height:7px;margin-top:6px"><i style="background:' + (covered >= target ? "#2dd4a0" : "#fab219") + ";width:" + pctC.toFixed(0) + '%"></i></span>' +
          (lockIf > 0 ? "<div style='font-size:11px;color:var(--dim);margin-top:5px'>of which " + dP9(sellNow) + " realized the moment you sell · " + dP9(lockIf) + " only if those stops fill — a gap can fill lower, so treat it as a floor, not cash.</div>" : "") + "</div>");
      }
      // ---- portfolio after the planned sells (stops change nothing until they fill) ----
      var eqL9 = (typeof EQABS !== "undefined" && EQABS && typeof EQ !== "undefined" && EQ.length) ? EQ[EQ.length - 1] : null;
      if (eqL9 && sold$ > 0) {
        var inv9 = Ps.reduce(function (a, q) { return a + q.val; }, 0), invA9 = inv9 - sold$;
        var eN9 = Math.round(100 * inv9 / eqL9), eA9 = Math.round(100 * invA9 / eqL9);
        var d9 = function (v) { return (v < 0 ? "−$" : "$") + Math.round(Math.abs(v)).toLocaleString(); };
        H.push('<div class="wiHead">Portfolio after the planned sells</div>');
        var MT9 = window._mmTier, bandTx = "";
        if (MT9 && MT9.b0 != null) {
          var bn9 = (String(MT9.lab || "").split(" — ")[0] || "model") + " " + MT9.b0 + "–" + MT9.b1 + "% band";
          bandTx = eA9 >= MT9.b0 && eA9 <= MT9.b1 ? " · <b class='g-grn'>inside the " + bn9 + " ✓</b>" : eA9 > MT9.b1 ? " · <b class='g-red'>above the " + bn9 + " ✗</b>" : " · <b class='g-amb'>below the " + bn9 + " — selling past what the model asks ✗</b>";
        }
        H.push('<div class="wiRow">exposure <span class="num">' + eN9 + "%</span> → <b class='num'>" + eA9 + "%</b>" + bandTx + "</div>");
        H.push('<div class="wiRow">cash ' + d9(eqL9 - inv9) + " → <b class='num'>" + d9(eqL9 - invA9 - comm9) + "</b>" + (fullCloses ? " · <span style='color:var(--dim)'>" + fullCloses + " position" + (fullCloses > 1 ? "s" : "") + " fully closed</span>" : "") + "</div>");
      }
      el.innerHTML = H.join("");
      // handlers
      var sa = $("ofSAdd"); if (sa) sa.onclick = function () {
        var sym = $("ofSSym").value, sh = parseFloat($("ofSSh").value), p = wiPos(sym);
        if (!p) { ofNote = "pick a held position."; return ofPlanUI(); }
        if (!(sh > 0)) { ofNote = "enter the shares to sell."; return ofPlanUI(); }
        var avail = p.sh - ofSellSh(sym);
        if (avail <= 1e-9) { ofNote = "already selling the whole " + esc(sym) + " position in this plan."; return ofPlanUI(); }
        if (sh > avail + 1e-9) { ofNote = esc(sym) + ": clamped to the " + (Math.round(avail * 100) / 100) + " sh still unplanned."; sh = avail; }
        ofItems.push({ k: "S", sym: sym, sh: Math.round(sh * 10000) / 10000 }); ofPlanUI();
      };
      var pa = $("ofPAdd"); if (pa) pa.onclick = function () {
        var sym = $("ofPSym").value, st = parseFloat($("ofPStop").value), p = wiPos(sym);
        if (!p) { ofNote = "pick a held position."; return ofPlanUI(); }
        if (!(st > 0)) { ofNote = "enter the new stop price."; return ofPlanUI(); }
        var ex = -1; ofItems.forEach(function (it, i) { if (it.k === "P" && it.sym === sym) ex = i; });
        if (ex > -1) { ofItems[ex].stop = st; ofNote = esc(sym) + " stop updated."; } else ofItems.push({ k: "P", sym: sym, stop: st });
        ofPlanUI();
      };
      el.querySelectorAll(".ofItem .rm").forEach(function (x) {
        x.onclick = function () { ofItems.splice(parseInt(x.getAttribute("data-i"), 10), 1); ofPlanUI(); };
      });
    }
    $("ofTg").onclick = function () {
      var b = $("ofBody"), on = b.style.display === "none";
      b.style.display = on ? "" : "none";
      this.textContent = on ? "Offset planner ▾" : "Offset planner ▸";
      this.classList.toggle("on", on);
      if (on) ofRender();
    };

    /* ----- v5.9h: CASH + POSITIONS entry mode (persisted per device on S.dnMode) ----- */
    function dnModeGet() { return S.dnMode === "CASH" ? "CASH" : "NAV"; }
    function dnPosVal() {
      var tot = 0, parts = [], bad = false;
      (typeof POS !== "undefined" && POS || []).forEach(function (p) {
        var px = (p.px > 0 ? p.px : wiLivePx(p.sym));
        if (!(px > 0)) { parts.push(p.sym + ": no price"); bad = true; return; }
        tot += p.sh * px; parts.push(p.sym + " " + (Math.round(p.sh * 100) / 100) + "×" + px.toFixed(2));
      });
      return { tot: tot, parts: parts, bad: bad };
    }
    function dnPrevUI() {
      var el = $("dnPrev"); if (!el) return;
      if (dnModeGet() !== "CASH") { el.textContent = ""; return; }
      var c = parseFloat($("dnEq").value), pv = dnPosVal();
      if (pv.bad) { el.textContent = "⚠ missing a price (" + pv.parts.join(" · ") + ") — use NET LIQ today"; return; }
      if (!(c >= 0) || $("dnEq").value === "") { el.textContent = pv.parts.length ? "open positions now: $" + Math.round(pv.tot).toLocaleString() + " (" + pv.parts.join(" · ") + ")" : "no open positions — cash IS the equity"; return; }
      el.textContent = "cash " + Math.round(c).toLocaleString() + (pv.parts.length ? " + positions " + Math.round(pv.tot).toLocaleString() + " (" + pv.parts.join(" · ") + ")" : "") + " → saves equity " + Math.round(c + pv.tot).toLocaleString();
    }
    function dnModeUI() {
      var m = dnModeGet();
      document.querySelectorAll("#dnMode .chip").forEach(function (b) { b.classList.toggle("on", b.dataset.dn === m); });
      var lbl = $("dnEqLbl"); if (lbl) lbl.textContent = m === "CASH" ? "Cash left (settled)" : "Equity (account NAV)";
      var inp = $("dnEq"); if (inp) inp.placeholder = m === "CASH" ? "45824.31" : "52678.42";
      /* v7.1: carried-cash prefill — on a no-trade day cash CANNOT have changed, so the box starts
         at the derived value (last log minus positions at that date, walked through every trade
         since; commissions ride along in eff prices). Fills only an EMPTY box (never overwrites
         typing), CASH mode only, and skips negative/none (margin, no anchor). Interest/fees/
         dividends do land without trades — just edit the number those days. */
      if (m === "CASH" && inp && inp.value === "" && window.cashNow9) {
        var c9 = window.cashNow9();
        if (c9 != null && isFinite(c9) && c9 >= 0) { inp.value = c9; inp.title = "carried from your last log + trades since — edit if IBKR shows different"; }
      }
      dnPrevUI();
    }
    document.querySelectorAll("#dnMode .chip").forEach(function (b) { b.onclick = function () { S.dnMode = b.dataset.dn; save(); dnModeUI(); }; });
    { var _de = $("dnEq"); if (_de) _de.addEventListener("input", dnPrevUI); }
    { var _td = $("enTabD"); if (_td) _td.addEventListener("click", function () { setTimeout(dnModeUI, 30); }); }
    dnModeUI();

    $("dnSubmit").onclick = async function () {
      msg();
      var d = $("dnDate").value, typed = parseFloat($("dnEq").value), fl = $("dnFl").value === "" ? 0 : parseFloat($("dnFl").value);
      if (!d) return msg("Pick a date.");
      var cashMode = dnModeGet() === "CASH";
      if (cashMode ? !(typed >= 0) : !(typed > 0)) return msg(cashMode ? "Cash must be zero or a positive number." : "Equity must be a positive number.");
      if (isNaN(fl)) return msg("Flow must be a number (0 if none).");
      var eq = typed;
      if (cashMode) { /* v5.9h: equity = typed settled cash + open positions at live/last prices */
        var pv = dnPosVal();
        if (pv.bad) return msg("Missing a live price for an open position — switch to NET LIQ for today.");
        eq = Math.round((typed + pv.tot) * 100) / 100;
        if (!(eq > 0)) return msg("Computed equity is zero — check the cash amount.");
      }
      busy(this, true, "Save equity");
      try {
        var r = await postAPI("addDaily", { date: d, equity: eq, flow: fl });
        echoDaily(d, eq, fl); /* v5.9f: the curve updates this second */
        msg("", (r.updated ? "Updated" : "Added") + " Daily " + d + " = " + eq.toLocaleString() + (cashMode ? " ✓ (cash " + typed.toLocaleString() + " + positions)" : " ✓"));
        window.loadSheet && loadSheet();
      } catch (e) { msg(e.message); }
      busy(this, false, "Save equity");
    };

    /* ----- fix rows (delete / edit stop) ----- */
    function rowMatch(t) { return { date: iso(t.d), ticker: t.sym, side: t.act, shares: t.sh, price: t.px }; }
    function renderRows() {
      var rows = (typeof TX!=="undefined"&&TX||[]).slice(-15).reverse();
      var el = $("enRows");
      if (!rows.length) { el.innerHTML = "<div class='sub2' style='color:var(--dim)'>No transactions loaded.</div>"; return; }
      el.innerHTML = rows.map(function (t, i) {
        var recon = /recon/i.test(t.note || "");
        var lbl = "<span class='num' style='color:var(--dim)'>" + iso(t.d).slice(5) + "</span> <b>" + esc(t.disp) + "</b> " +
          "<span class='" + (t.act === "B" ? "g-grn" : "g-red") + "'>" + (t.act === "B" ? "Buy" : "Sell") + "</span> " +
          "<span class='num'>" + t.sh + " @ " + t.px + "</span>" + (t.stop ? " <span class='num' style='color:var(--dim)'>SL " + t.stop + "</span>" : "");
        var btns = recon ? "<span style='margin-left:auto;color:var(--dim);font-size:10px'>🔒 RECON</span>" :
          "<span style='margin-left:auto;display:flex;gap:6px'>" +
          (t.act === "B" ? "<button class='b st' data-st='" + i + "'>Stop</button>" : "") +
          "<button class='b del' data-del='" + i + "'>Delete</button></span>";
        return "<div class='enRow' data-row='" + i + "'>" + lbl + btns + "</div>";
      }).join("");
      el.querySelectorAll("[data-del]").forEach(function (b) {
        b.onclick = async function () {
          var i = +b.dataset.del, t = rows[i];
          if (!b.classList.contains("arm")) { b.classList.add("arm"); b.textContent = "Confirm delete"; setTimeout(function () { b.classList.remove("arm"); b.textContent = "Delete"; }, 4000); return; }
          msg(); b.disabled = true; b.textContent = "Deleting…";
          try { await postAPI("deleteRow", rowMatch(t)); echoDelete(rowMatch(t)); msg("", "Deleted " + t.disp + " row ✓"); renderRows(); window.loadSheet && loadSheet(); } /* v5.9f: echo first — the list + Holdings update this second, the slow sync just confirms */
          catch (e) { msg(e.message); b.disabled = false; b.classList.remove("arm"); b.textContent = "Delete"; }
        };
      });
      el.querySelectorAll("[data-st]").forEach(function (b) {
        b.onclick = async function () {
          var i = +b.dataset.st, t = rows[i], row = el.querySelector("[data-row='" + i + "']");
          if (row.querySelector("input")) return;
          var inp = document.createElement("input");
          inp.type = "number"; inp.step = "any"; inp.placeholder = "new stop"; inp.value = t.stop || "";
          b.replaceWith(inp);
          var sv = document.createElement("button"); sv.className = "b st"; sv.textContent = "Save";
          inp.after(sv); inp.focus();
          sv.onclick = async function () {
            var v = parseFloat(inp.value);
            if (!(v > 0)) return msg("Stop must be a positive number.");
            msg(); sv.disabled = true; sv.textContent = "…";
            try { /* v6.3: before a raise overwrites the stop, remember the campaign's initial risk — the R-ladder anchors to it */
              if (t.act === "B" && t.stop != null && t.px > 0 && t.stop < t.px) {
                var M0 = {}; try { M0 = JSON.parse(localStorage.getItem(LS + "_r0") || "{}"); } catch (e0) {}
                var k0 = t.sym + "|" + iso(t.d) + "|" + t.px;
                if (!(M0[k0] > 0)) { M0[k0] = t.stop; localStorage.setItem(LS + "_r0", JSON.stringify(M0)); }
              }
            } catch (e9) {}
            try { await postAPI("setStop", Object.assign(rowMatch(t), { stop: v })); echoStop(rowMatch(t), v); msg("", t.sym + " stop → " + v + " ✓"); renderRows(); window.loadSheet && loadSheet(); } /* v5.9f: instant echo */
            catch (e) { msg(e.message); sv.disabled = false; sv.textContent = "Save"; }
          };
        };
      });
    }

    /* ----- mobile bottom tab bar (≤640px; desktop unchanged) ----- */
    var pgc = $("tabJ") && $("tabJ").closest(".chips"); if (pgc) pgc.id = "pgChips";
    var tb = document.createElement("nav"); tb.id = "tabbar";
    tb.innerHTML =
      '<button data-tb="J"><span class="ic">▦</span>Journal</button>' +
      '<button data-tb="M"><span class="ic">∿</span>Market</button>' +
      '<button id="tbAdd"><span class="ic">＋</span>Add</button>' +
      '<button data-tb="F"><span class="ic">▲</span>Perf</button>' +
      '<button id="tbRe"><span class="ic">⟳</span>Refresh</button>';
    document.body.appendChild(tb);
    function tbSync() {
      ["J", "M", "F"].forEach(function (k) {
        var c = $("tab" + k), b = tb.querySelector('[data-tb="' + k + '"]');
        if (c && b) b.classList.toggle("on", c.classList.contains("on"));
      });
    }
    tb.querySelectorAll("[data-tb]").forEach(function (b) {
      b.onclick = function () { var c = $("tab" + b.dataset.tb); if (c) { c.click(); window.scrollTo(0, 0); tbSync(); } };
    });
    ["tabJ", "tabM", "tabF"].forEach(function (id) { var c = $(id); if (c) c.addEventListener("click", function () { setTimeout(tbSync, 0); }); });
    $("tbAdd").onclick = openModal;
    $("tbRe").onclick = function () {
      var ic = this.querySelector(".ic");
      ic.style.transition = "transform .6s"; ic.style.transform = "rotate(360deg)";
      setTimeout(function () { ic.style.transition = "none"; ic.style.transform = ""; }, 650);
      var r = $("reloadBtn"); if (r) r.click(); else window.loadSheet && loadSheet();
    };
    tbSync();

    /* ----- pull-to-refresh (phone only, page at top, no modal open) ----- */
    var ptr = document.createElement("div"); ptr.id = "ptr"; ptr.textContent = "↓ Pull to refresh";
    document.body.appendChild(ptr);
    var pY = null, pArm = false;
    function ptrOK() { return window.matchMedia("(max-width:640px)").matches && !document.querySelector(".overlay.show"); }
    document.addEventListener("touchstart", function (e) {
      pY = (window.scrollY <= 0 && ptrOK()) ? e.touches[0].clientY : null; pArm = false;
    }, { passive: true });
    document.addEventListener("touchmove", function (e) {
      if (pY == null) return;
      var dy = e.touches[0].clientY - pY;
      if (dy > 0 && window.scrollY <= 0) {
        ptr.style.transition = "none";
        ptr.style.transform = "translate(-50%," + (Math.min(dy / 2.4, 84) - 70) + "px)";
        pArm = dy > 130;
        ptr.textContent = pArm ? "⟳ Release to refresh" : "↓ Pull to refresh";
      }
    }, { passive: true });
    document.addEventListener("touchend", function () {
      if (pY == null) return;
      ptr.style.transition = "transform .25s";
      if (pArm) {
        ptr.textContent = "⟳ Refreshing…";
        ptr.style.transform = "translate(-50%,14px)";
        var r = $("reloadBtn"); if (r) r.click(); else window.loadSheet && loadSheet();
        setTimeout(function () { ptr.style.transform = "translate(-50%,-70px)"; }, 1100);
      } else ptr.style.transform = "translate(-50%,-70px)";
      pY = null; pArm = false;
    }, { passive: true });

    /* ----- service worker + auto-refresh ----- */
    /* v5.1: auto-reload once when a new service worker takes control — kills the "reopen
       twice" update dance. sw.js is skipWaiting+clients.claim, so the moment an updated SW
       activates it controls this page while the old shell is still painted; one reload shows
       the new build. Guards: (a) module-scoped swReloaded flag → can never loop; (b) on the
       very first install there was no previous controller (swHadCtrl false) — that initial
       claim is not an update, so no reload; (c) if an entry form is open (+Add / setup
       overlay) the reload is deferred until it closes so a half-typed trade is never lost.
       reg.update() runs at registration and again whenever the app returns to the
       foreground (visibilitychange → visible, throttled to ≥60s) so a phone that reopens
       the PWA finds a new deploy immediately instead of on the next cold start.
       (__swTestAllow lets the localhost test rig exercise this path; production stays https-only.) */
    if ("serviceWorker" in navigator && (location.protocol === "https:" || window.__swTestAllow === true)) {
      var swHadCtrl = !!navigator.serviceWorker.controller, swReloaded = false, swPending = false;
      var swFormOpen = function () { return !!document.querySelector(".overlay.show"); };
      navigator.serviceWorker.addEventListener("controllerchange", function () {
        if (!swHadCtrl) { swHadCtrl = true; return; } // first-ever install claiming the page — not an update
        if (swReloaded || swPending) return;          // one reload per takeover, never a loop
        if (swFormOpen()) {                           // don't interrupt a form mid-entry
          swPending = true;
          var iv = setInterval(function () {
            if (!swFormOpen()) { clearInterval(iv); if (!swReloaded) { swReloaded = true; location.reload(); } }
          }, 500);
          return;
        }
        swReloaded = true; location.reload();
      });
      try {
        navigator.serviceWorker.register("./sw.js").then(function (reg) {
          var swChk = function () { try { reg.update().catch(function () {}); } catch (_) {} };
          swChk(); window.__swLastChk = Date.now();
          document.addEventListener("visibilitychange", function () {
            if (document.visibilityState === "visible" && Date.now() - (window.__swLastChk || 0) >= 60e3) { window.__swLastChk = Date.now(); swChk(); }
          });
        }).catch(function () {});
      } catch (_) {}
    }
    window.__lastLoad = Date.now();
    if (window.loadSheet) {
      var _ls = window.loadSheet;
      window.loadSheet = async function () { try { return await _ls.apply(this, arguments); } finally { window.__lastLoad = Date.now(); } };
    }
    document.addEventListener("visibilitychange", function () {
      /* v6.5: retry gates on the last SUCCESSFUL sync, not the last attempt — a download the phone killed
         (screen lock / app switch) used to stamp __lastLoad and block retries for 10 minutes. Now: back in
         the foreground with no completed sync in the last 3 minutes ⇒ try again (loadSheet self-guards). */
      if (document.visibilityState !== "visible" || !S.api || window._syncing) return;
      var okAge = window._lastSync ? Date.now() - (+window._lastSync) : Infinity;
      if (okAge > 3 * 60e3) { window.loadSheet && loadSheet(); }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
