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
  function commFor(shares, price) {
    var m = commMode();
    if (m === "OFF" || !(shares > 0) || !(price > 0)) return null; // empty / invalid fields → no adjust
    var rate = 0.005, min = 1;
    if (m === "CUSTOM") {
      rate = parseFloat(S.commRate); if (!(rate >= 0)) rate = 0.005;
      min = parseFloat(S.commMin); if (!(min >= 0)) min = 1;
    }
    return Math.min(Math.max(rate * shares, min), 0.01 * shares * price); // max stays IBKR's 1%-of-value cap
  }
  function r2c(v) { return Math.round((v + 1e-9) * 100) / 100; } // half-up at 2dp; epsilon absorbs FP dust (100.004999… → 100.01)
  function commAdj(side, shares, price) { // → {comm, eff} or null (OFF / fields empty)
    var c = commFor(shares, price);
    if (c == null) return null;
    var eff = r2c(side === "Sell" ? price - c / shares : price + c / shares);
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
      "body.light .enGrid input,body.light .enGrid select{background:#fff;color:#0f172a;color-scheme:light}" +
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
      /* ---- v4.6: What-if tab — read-only calculator ---- */
      "#wiOut{margin-top:10px;background:rgba(255,255,255,.02);border:1px solid var(--bd);border-radius:12px;padding:4px 12px;min-height:40px}" +
      "body.light #wiOut{background:rgba(15,23,42,.03)}" +
      ".wiRow{padding:6px 0;border-bottom:1px solid rgba(255,255,255,.05);font-size:12.4px;line-height:1.5}" +
      ".wiRow:last-child{border-bottom:0}" +
      ".wiRow .num{font-variant-numeric:tabular-nums}" +
      "#wiNote{font-size:11px;color:var(--dim);margin-top:10px}" +
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
      "}";
    document.head.appendChild(st);

    /* ----- header ＋ Add button ----- */
    var rb = $("reloadBtn");
    var eb = document.createElement("span");
    eb.className = "pill btn live"; eb.id = "entryBtn"; eb.textContent = "＋ Add";
    if (rb && rb.parentNode) rb.parentNode.insertBefore(eb, rb); else document.querySelector("header").appendChild(eb);

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
        '<p>Folds the broker commission into every saved trade — the Buy price goes up and the Sell price comes down by commission ÷ shares, so sheet P&amp;L matches the broker statement. <b>FIXED</b> = IBKR Fixed US-stock schedule: $0.005/share, $1.00 minimum, capped at 1% of trade value.</p>' +
        '<div class="enTabs" id="commTabs" style="max-width:360px">' +
        '<button class="chip" data-comm="OFF">OFF</button>' +
        '<button class="chip" data-comm="FIXED">FIXED</button>' +
        '<button class="chip" data-comm="CUSTOM">CUSTOM</button></div>' +
        '<div class="enGrid" id="commCust" style="display:none">' +
        '<div><label>Per-share rate ($)</label><input type="number" id="commRate" inputmode="decimal" step="any" min="0" placeholder="0.005"></div>' +
        '<div><label>Minimum per order ($)</label><input type="number" id="commMin" inputmode="decimal" step="any" min="0" placeholder="1.00"></div></div>' +
        '<div id="commState" style="font-size:11.5px;color:var(--dim);margin-top:8px"></div>';
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
          m === "OFF" ? "Off — prices save exactly as entered." :
          m === "FIXED" ? "Saving adjusts the price by $0.005/share ($1.00 min, 1% max) — e.g. Buy 5 @ 518.79 saves as 518.99." :
          "Saving adjusts by your per-share rate with your minimum — the 1%-of-value cap still applies.";
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
      '<h2>Add to journal</h2>' +
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
      '<div><label>Price</label><input type="number" id="enPrice" inputmode="decimal" step="any" min="0" placeholder="538.50"></div>' +
      '<div><label>Stop (col F)</label><input type="number" id="enStop" inputmode="decimal" step="any" min="0" placeholder="optional"></div>' +
      '<div><label>Pivot</label><input type="number" id="enPivot" inputmode="decimal" step="any" min="0" placeholder="optional"></div>' +
      '<div><label>Setup</label><input type="text" id="enSetup" list="enSetups" placeholder="optional" autocomplete="off"><datalist id="enSetups"></datalist></div>' +
      '<div class="full"><label>Note</label><input type="text" id="enNote" placeholder="optional" autocomplete="off"></div>' +
      "</div>" +
      '<div id="enPrev" class="num"></div>' +
      '<div class="btnrow"><button class="btn pri" id="enSubmit">Save trade</button><button class="btn sec" id="enSubmitA" style="flex:0;min-width:118px">Save + another</button><button class="btn sec" id="enClose1" style="flex:0;min-width:70px">Close</button></div>' +
      '<p style="font-size:11px;color:var(--dim);margin-top:10px">Saved straight into the <b>Transactions</b> tab of your Google Sheet. Sells are blocked if they would exceed what you hold.</p>' +
      "</div>" +

      '<div id="enPaneD" style="display:none">' +
      '<div class="enGrid">' +
      '<div><label>Date</label><input type="date" id="dnDate"></div>' +
      '<div><label>Equity (account NAV)</label><input type="number" id="dnEq" inputmode="decimal" step="any" min="0" placeholder="52678.42"></div>' +
      '<div><label>Deposit / withdrawal today</label><input type="number" id="dnFl" inputmode="decimal" step="any" placeholder="0"></div>' +
      "</div>" +
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
      '<div id="wiOut"></div>' +
      '<div class="btnrow"><button class="btn sec" id="enClose4">Close</button></div>' +
      '<p id="wiNote">Calculator only — nothing is saved. Holdings use your live avg cost; commission follows the setting in ⚙ Commission (IBKR).</p>' +
      "</div>" +
      "</div>";
    document.body.appendChild(ov);

    var panes = { T: "enPaneT", D: "enPaneD", R: "enPaneR", W: "enPaneW" };
    function enTab(w) {
      Object.keys(panes).forEach(function (k) { $(panes[k]).style.display = k === w ? "" : "none"; $("enTab" + k).classList.toggle("on", k === w); });
      msg(); if (w === "R") renderRows(); if (w === "W") { wiSyms(); wiCalc(); }
    }
    ["T", "D", "R", "W"].forEach(function (k) { $("enTab" + k).onclick = function () { enTab(k); }; });

    function msg(err, ok) {
      var e = $("enErr"), o = $("enOk");
      e.textContent = err || ""; e.classList.toggle("show", !!err);
      o.textContent = ok || ""; o.style.display = ok ? "block" : "none";
    }

    function openModal() {
      msg();
      $("enDate").value = todayISO(); $("dnDate").value = todayISO();
      refreshTickerList();
      var sets = {}; (typeof TX!=="undefined"&&TX||[]).forEach(function (t) { if (t.set) sets[t.set] = 1; });
      $("enSetups").innerHTML = Object.keys(sets).map(function (s) { return "<option value=\"" + esc(s) + "\">"; }).join("");
      updPrev();
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
      var ca = commAdj(a, sh, px), ex = ca ? ca.eff : px; // v4.5: commission-inclusive effective price drives the risk math
      if (a === "Buy" && sh > 0 && px > 0 && st > 0 && st < ex) {
        var r = sh * (ex - st);
        out.push("RISK $" + Math.round(r).toLocaleString() + (eq ? " · " + (100 * r / eq).toFixed(2) + "% NAV" : "") + " · stop " + (100 * (ex - st) / ex).toFixed(1) + "% away");
      } else if (a === "Buy" && sh > 0 && px > 0 && !$("enStop").value) out.push("No stop = unmeasured risk (shows unstopped in SCAR)");
      if (a === "Sell" && tk && net > 0) {
        var after = sh > 0 ? Math.max(0, net - Math.min(sh, net)) : net;
        out.push("HOLDING " + net + (sh > 0 ? " → " + after + " after (" + (100 * Math.min(sh, net) / net).toFixed(0) + "% reduced)" : " shares"));
      }
      if (ca) out.push("comm $" + ca.comm.toFixed(2) + " → eff " + ca.eff.toFixed(2));
      $("enPrev").textContent = out.join("  ·  ");
    }
    function prefillSell() {
      refreshTickerList();
      if ($("enAction").value === "Sell") {
        var n = netShares(($("enTicker").value || "").trim().toUpperCase());
        if (n > 0 && !$("enShares").value) $("enShares").value = n;
      }
      updPrev();
    }
    $("enAction").onchange = prefillSell; $("enTicker").onchange = prefillSell;
    ["enTicker", "enShares", "enPrice", "enStop"].forEach(function (id) { $(id).oninput = updPrev; });

    function busy(btn, on, txt) { btn.disabled = on; btn.textContent = on ? "Saving…" : txt; btn.style.opacity = on ? ".6" : "1"; }

    var lastSig = null, lastSigT = 0, dupOk = false;
    async function submitTrade(btn, keep) {
      msg();
      var p = {
        date: $("enDate").value, ticker: ($("enTicker").value || "").trim().toUpperCase(),
        side: $("enAction").value, shares: parseFloat($("enShares").value), price: parseFloat($("enPrice").value),
        stop: $("enStop").value === "" ? "" : parseFloat($("enStop").value),
        pivot: $("enPivot").value === "" ? "" : parseFloat($("enPivot").value),
        setup: $("enSetup").value || "", lot: "", notes: $("enNote").value || ""
      };
      if (!p.date) return msg("Pick a date.");
      if (!p.ticker) return msg("Ticker is required.");
      if (!(p.shares > 0)) return msg("Shares must be a positive number.");
      if (!(p.price > 0)) return msg("Price must be a positive number.");
      var ca = commAdj(p.side, p.shares, p.price); // v4.5: save the commission-inclusive price (Buy up / Sell down, 2dp)
      if (ca) p.price = ca.eff;
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
        lastSig = sig; lastSigT = Date.now(); dupOk = false;
        msg("", p.side + " " + p.shares + " " + p.ticker + " @ " + p.price + " saved ✓" + (keep ? " — next one:" : ""));
        $("enShares").value = ""; $("enPrice").value = ""; $("enNote").value = "";
        if (!keep) { $("enTicker").value = ""; $("enStop").value = ""; $("enPivot").value = ""; $("enSetup").value = ""; }
        $("enPrev").textContent = "";
        window.loadSheet && loadSheet();
      } catch (e) { msg(e.message); }
      busy(btn, false, keep ? "Save + another" : "Save trade");
      if (keep) $("enShares").focus();
    }
    $("enSubmit").onclick = function () { return submitTrade(this, false); };
    $("enSubmitA").onclick = function () { return submitTrade(this, true); };

    /* ---------- v4.5: quick-sell prefill hook — Holdings rows (index.html qsell) call this.
       Opens the Trade tab prefilled; the user reviews and taps Save — nothing auto-submits. ---------- */
    window.openTradePrefill = function (o) {
      o = o || {};
      openModal(); // date=today, ticker/setup datalists refreshed
      enTab("T");
      $("enTicker").value = o.ticker ? String(o.ticker).trim().toUpperCase() : "";
      $("enAction").value = o.side === "Sell" ? "Sell" : "Buy";
      refreshTickerList(); // sell mode → datalist flips to open positions
      $("enShares").value = o.shares != null && isFinite(o.shares) ? o.shares : "";
      $("enPrice").value = o.price != null && isFinite(o.price) && o.price > 0 ? Math.round(o.price * 100) / 100 : "";
      $("enStop").value = ""; $("enPivot").value = ""; $("enSetup").value = ""; $("enNote").value = "";
      updPrev();
      setTimeout(function () { var el = $("enShares"); try { el.focus(); el.select(); } catch (_) {} }, 60); // focus lands on shares
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
    function wiCalc() {
      var out = $("wiOut"); if (!out) return;
      var tk = ($("wiTicker").value || "").trim().toUpperCase();
      var side = $("wiSide").value;
      var sh = parseFloat($("wiShares").value), px = parseFloat($("wiPrice").value), st = parseFloat($("wiStop").value);
      var p = tk ? wiPos(tk) : null, mlt = p ? (p.mlt || 1) : 1;
      var eqL = (typeof EQABS !== "undefined" && EQABS && typeof EQ !== "undefined" && EQ.length) ? EQ[EQ.length - 1] : null;
      var inv = (typeof POS !== "undefined" && POS || []).reduce(function (a, q) { return a + q.val; }, 0);
      var row = function (id, html) { return "<div class='wiRow' id='" + id + "'>" + html + "</div>"; };
      var d$ = function (v) { return (v < 0 ? "−$" : "$") + Math.round(Math.abs(v)).toLocaleString(); };
      var L = [];
      if (!tk) { out.innerHTML = row("wiMsg", "<span style='color:var(--dim)'>Type a ticker — held positions auto-fill their live price; any other symbol works once you enter a price.</span>"); return; }
      if (p) L.push(row("wiNow", "<b>" + esc(p.disp || tk) + "</b> — holding <span class='num'>" + (Math.round(p.sh * 100) / 100) + "</span> sh @ avg <span class='num'>" + p.basis.toFixed(2) + "</span> · live <span class='num'>" + (p.px > 0 ? p.px.toFixed(2) : "—") + "</span>" + (p.est ? " <span class='g-amb'>(est)</span>" : "")));
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
        newAvg = p ? (p.sh * p.basis + sh * eff) / newSh : eff; // commission-inclusive effective price feeds the blend
        L.push(row("wiAfter", "after <b class='g-grn'>BUY " + sh + "</b>: <span class='num'>" + (Math.round(newSh * 100) / 100) + "</span> sh @ new avg <b class='num'>" + newAvg.toFixed(2) + "</b>" + (p ? "" : " (new position)")));
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
        var eN = Math.round(100 * inv / eqL), eA = Math.round(100 * (inv + (side === "Buy" ? trade$ : -trade$)) / eqL);
        L.push(row("wiVal", "position after: <b class='num'>" + d$(posVal) + "</b> · <b class='num'>" + wgt.toFixed(1) + "%</b> of equity"));
        L.push(row("wiExpo", "portfolio exposure: <span class='num'>" + eN + "%</span> → <b class='num'>" + eA + "%</b> after <span style='color:var(--dim)'>(invested " + d$(inv) + " " + (side === "Buy" ? "+" : "−") + " " + d$(trade$) + " ÷ equity " + d$(eqL) + ")</span>"));
        var MT = window._mmTier;
        if (MT && MT.b0 != null) {
          var bandTxt = (String(MT.lab || "").split(" — ")[0] || "model") + " " + MT.b0 + "–" + MT.b1 + "% band";
          if (eA >= MT.b0 && eA <= MT.b1) L.push(row("wiBand", "<b class='g-grn'>→ " + eA + "% exposure — inside the " + bandTxt + " ✓</b>"));
          else if (eA > MT.b1) L.push(row("wiBand", "<b class='g-red'>→ " + eA + "% exposure — above the " + bandTxt + " — breaks the band ✗</b>"));
          else L.push(row("wiBand", "<b class='g-amb'>→ " + eA + "% exposure — below the " + bandTxt + " — breaks the band ✗</b>"));
        }
      } else L.push(row("wiVal", "<span class='g-amb'>add Daily equity rows to size weight, exposure and the band check.</span>"));
      if (st > 0 && st < eff) {
        var risk$ = used * (eff - st) * mlt, rPct = eqL ? 100 * risk$ / eqL : null;
        var cls = rPct == null ? "g-amb" : rPct <= 0.5 ? "g-grn" : rPct <= 1 ? "g-amb" : "g-red";
        L.push(row("wiRisk", "stop risk <b class='num " + cls + "'>" + d$(risk$) + (rPct != null ? " · " + rPct.toFixed(2) + "% NAV" : "") + "</b> <span style='color:var(--dim)'>(sizing guide 0.25–0.5% NAV)</span>"));
      } else if ($("wiStop").value !== "") {
        L.push(row("wiRisk", "<span class='g-amb'>stop must sit below the (effective) price for a risk read.</span>"));
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

    $("dnSubmit").onclick = async function () {
      msg();
      var d = $("dnDate").value, eq = parseFloat($("dnEq").value), fl = $("dnFl").value === "" ? 0 : parseFloat($("dnFl").value);
      if (!d) return msg("Pick a date.");
      if (!(eq > 0)) return msg("Equity must be a positive number.");
      if (isNaN(fl)) return msg("Flow must be a number (0 if none).");
      busy(this, true, "Save equity");
      try {
        var r = await postAPI("addDaily", { date: d, equity: eq, flow: fl });
        msg("", (r.updated ? "Updated" : "Added") + " Daily " + d + " = " + eq.toLocaleString() + " ✓");
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
          try { await postAPI("deleteRow", rowMatch(t)); msg("", "Deleted " + t.disp + " row ✓"); window.loadSheet && loadSheet(); setTimeout(renderRows, 1500); }
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
            try { await postAPI("setStop", Object.assign(rowMatch(t), { stop: v })); msg("", t.sym + " stop → " + v + " ✓"); window.loadSheet && loadSheet(); setTimeout(renderRows, 1500); }
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
    if ("serviceWorker" in navigator && location.protocol === "https:") {
      try { navigator.serviceWorker.register("./sw.js"); } catch (_) {}
    }
    window.__lastLoad = Date.now();
    if (window.loadSheet) {
      var _ls = window.loadSheet;
      window.loadSheet = async function () { try { return await _ls.apply(this, arguments); } finally { window.__lastLoad = Date.now(); } };
    }
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && S.api && Date.now() - (window.__lastLoad || 0) > 10 * 60e3) { window.loadSheet && loadSheet(); }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
