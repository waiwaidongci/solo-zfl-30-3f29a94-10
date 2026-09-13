/* 界面层：只通过 DiveStore 数据层读写，不直接碰 localStorage。 */
(function () {
  "use strict";

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var store = new DiveStore(DiveStore.localStorageStorage());
  var typeNames = { ceramic: "陶片", wood: "木构件", metal: "金属件", unknown: "未知物" };
  var state = {
    view: "map",
    selectedMarkId: null,
    pendingXY: null,
    selectedDiveId: null,
    diveDraft: null,
    filterType: "",
    filterDive: "",
    listMode: "list",
    currentDiveCode: ""
  };

  /* ---------------- 通用 ---------------- */

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function toast(message, kind) {
    var box = $("#toast");
    var el = document.createElement("div");
    el.className = "toast " + (kind || "info");
    el.textContent = message;
    box.appendChild(el);
    setTimeout(function () { el.remove(); }, 4200);
  }

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime || "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  function stamp() { return new Date().toISOString().replace(/[:.]/g, "-"); }
  function diveSealed(diveOrCode) {
    var code = typeof diveOrCode === "string" ? diveOrCode : diveOrCode && diveOrCode.code;
    var d = store.state.dives.find(function (x) { return x.code === code; });
    return !!(d && store.state.seals[d.id]);
  }
  function sealOfCode(code) {
    var d = store.state.dives.find(function (x) { return x.code === code; });
    return d ? store.state.seals[d.id] : null;
  }

  /* ---------------- 标签页 ---------------- */

  $("#tabs").addEventListener("click", function (e) {
    var btn = e.target.closest(".tab");
    if (!btn) return;
    state.view = btn.dataset.view;
    $$(".tab").forEach(function (t) { t.classList.toggle("active", t === btn); });
    $$(".view").forEach(function (v) { v.classList.toggle("active", v.id === "view-" + state.view); });
    render();
  });

  /* ---------------- 启动横幅（坏数据/恢复/迁移） ---------------- */

  function renderLoadBanners() {
    var box = $("#loadBanners");
    box.innerHTML = "";
    if (!store.notices.length) return;
    var map = {
      STATE_CORRUPT: "err", BACKUP_CORRUPT: "err", STATE_FUTURE_VERSION: "err", LEGACY_CORRUPT: "err",
      RESTORED_FROM_BACKUP: "warn", MIGRATED_V1: "warn", STATE_LEGACY: "info", FRESH_STATE: "info"
    };
    var wrap = document.createElement("div");
    wrap.style.cssText = "padding:8px 12px 0;";
    store.notices.forEach(function (n) {
      var d = document.createElement("div");
      d.className = "banner " + (map[n.type] || "info");
      d.textContent = "[" + n.type + "] " + n.detail;
      wrap.appendChild(d);
    });
    box.appendChild(wrap);
  }

  /* ================= 地图视图 ================= */

  var mapEl = $("#map");
  for (var i = 0; i < 7; i++) {
    var rib = document.createElement("div");
    rib.className = "rib";
    rib.style.left = (28 + i * 7) + "%";
    mapEl.appendChild(rib);
  }

  function filteredMarks() {
    return store.state.marks.filter(function (m) {
      if (state.filterType && m.type !== state.filterType) return false;
      if (state.filterDive && m.dive !== state.filterDive) return false;
      return true;
    });
  }

  function renderMap() {
    $$(".marker", mapEl).forEach(function (el) { el.remove(); });
    filteredMarks().forEach(function (m) {
      var el = document.createElement("button");
      el.type = "button";
      el.className = "marker " + m.type +
        (m.id === state.selectedMarkId ? " selected" : "") +
        (diveSealed(m.dive) ? " sealed" : "");
      el.style.left = (m.x == null ? 50 : m.x) + "%";
      el.style.top = (m.y == null ? 50 : m.y) + "%";
      el.title = m.code + (diveSealed(m.dive) ? "（已封存·只读）" : "");
      el.textContent = String(m.code || "??").slice(0, 2);
      el.onclick = function (ev) { ev.stopPropagation(); editMark(m.id); };
      mapEl.appendChild(el);
    });
  }

  function renderMarkList() {
    var data = filteredMarks();
    var titleEl = $("#listTitle");
    var listEl = $("#list");
    if (state.listMode === "timeline") {
      titleEl.textContent = "潜次时间线";
      listEl.className = "timeline";
      var groups = data.reduce(function (g, m) { (g[m.dive] || (g[m.dive] = [])).push(m); return g; }, {});
      listEl.innerHTML = Object.keys(groups).sort().map(function (code) {
        var items = groups[code];
        var seal = sealOfCode(code);
        var head = "<b>" + esc(code) + "</b> " +
          (seal ? '<span class="pill ok">已封存 ' + esc(seal.code) + "</span>" : '<span class="pill warn">未封存</span>') +
          '<div class="muted">新增 ' + items.length + " 个标记</div>";
        return '<div class="item ' + (seal ? "sealed" : "") + '">' + head +
          items.map(function (x) { return "<div>" + esc(x.code) + " · " + typeNames[x.type] + " · " + esc(x.depth) + "m</div>"; }).join("") +
          "</div>";
      }).join("");
      return;
    }
    titleEl.textContent = "标记列表";
    listEl.className = "list";
    listEl.innerHTML = data.map(function (m) {
      var sealed = diveSealed(m.dive);
      return '<div class="item ' + (m.id === state.selectedMarkId ? "active" : "") + " " + (sealed ? "sealed" : "") +
        '" data-id="' + esc(m.id) + '"><b>' + esc(m.code) + "</b> " +
        '<span class="pill">' + typeNames[m.type] + "</span> " +
        (sealed ? '<span class="pill ok">已封存</span>' : "") +
        '<div class="muted">' + esc(m.dive) + " · " + esc(m.depth) + "m · " + esc(m.orientation) + "</div>" +
        "<div>" + esc(m.condition) + "</div></div>";
    }).join("");
    $$("[data-id]", listEl).forEach(function (el) {
      el.onclick = function () { editMark(el.dataset.id); };
    });
  }

  var markForm = $("#markForm");

  function fillDiveOptions() {
    var codes = store.state.dives.map(function (d) { return d.code; }).filter(Boolean).sort();
    if (!state.currentDiveCode || codes.indexOf(state.currentDiveCode) < 0) state.currentDiveCode = codes[0] || "";

    var diveSelect = markForm.querySelector("select[name=dive]");
    var keepDive = diveSelect.value;
    diveSelect.innerHTML = '<option value="">（未登记潜次）</option>' + codes.map(function (c) {
      var sealed = !!sealOfCode(c);
      return '<option value="' + esc(c) + '"' + (sealed ? " disabled" : "") + ">" +
        esc(c) + (sealed ? "（已封存·只读）" : "") + "</option>";
    }).join("");
    if (keepDive) diveSelect.value = keepDive;

    var filterSel = $("#filterDive");
    var keepFilter = filterSel.value;
    filterSel.innerHTML = '<option value="">全部潜次</option>' + codes.map(function (c) {
      return '<option value="' + esc(c) + '">' + esc(c) + (sealOfCode(c) ? "（已封存）" : "") + "</option>";
    }).join("");
    filterSel.value = keepFilter;

    var reviewSel = $("#reviewDive");
    var keepReview = reviewSel.value;
    var sealedCodes = codes.filter(function (c) { return sealOfCode(c); });
    reviewSel.innerHTML = sealedCodes.map(function (c) {
      return '<option value="' + esc(c) + '">' + esc(c) + " · " + esc(sealOfCode(c).code) + "</option>";
    }).join("");
    if (keepReview && sealedCodes.indexOf(keepReview) >= 0) reviewSel.value = keepReview;

    var cur = $("#currentDive");
    cur.innerHTML = codes.map(function (c) {
      return '<option value="' + esc(c) + '">' + esc(c) + (sealOfCode(c) ? "（已封存）" : "") + "</option>";
    }).join("");
    cur.value = state.currentDiveCode;
  }

  function setMarkFormReadonly(readOnly) {
    $$("input,select,textarea,button", markForm).forEach(function (el) {
      if (el.id === "deleteMarkBtn" || el.type === "submit" || el.tagName === "BUTTON") el.disabled = readOnly;
      else el.disabled = readOnly;
    });
    $("#markLockBanner").innerHTML = readOnly
      ? '<div class="banner locked">🔒 该标记所属潜次已封存：原标记只能查看。复查变更请前往「复查台」追加。</div>'
      : "";
  }

  function editMark(id) {
    var m = store.state.marks.find(function (x) { return x.id === id; });
    if (!m) return;
    state.selectedMarkId = id;
    state.pendingXY = { x: m.x, y: m.y };
    markForm.reset();
    ["id", "code", "type", "dive", "depth", "orientation", "attribution", "condition", "note"].forEach(function (k) {
      if (markForm[k]) markForm[k].value = m[k] == null ? "" : m[k];
    });
    markForm.refs.value = (m.refs || []).join(", ");
    setMarkFormReadonly(diveSealed(m.dive));
    render();
  }

  function resetMarkForm(x, y) {
    state.selectedMarkId = null;
    state.pendingXY = { x: x, y: y };
    markForm.reset();
    markForm.id.value = "";
    markForm.code.value = "M-" + String(store.state.marks.length + 1).padStart(3, "0");
    var codes = store.state.dives.map(function (d) { return d.code; }).filter(Boolean).sort();
    var firstOpen = codes.filter(function (c) { return !sealOfCode(c); })[0] || "";
    var targetCode = state.currentDiveCode && !sealOfCode(state.currentDiveCode) ? state.currentDiveCode : firstOpen;
    state.currentDiveCode = targetCode || state.currentDiveCode;
    markForm.dive.value = targetCode;
    markForm.attribution.value = affiliationOfCode(targetCode);
    markForm.refs.value = "";
    setMarkFormReadonly(false);
  }

  function affiliationOfCode(code) {
    var d = store.state.dives.find(function (x) { return x.code === code; });
    return d ? d.affiliation || "" : "";
  }

  mapEl.addEventListener("click", function (ev) {
    if (ev.target.closest(".marker")) return;
    var rect = mapEl.getBoundingClientRect();
    var x = Number(((ev.clientX - rect.left) / rect.width * 100).toFixed(2));
    var y = Number(((ev.clientY - rect.top) / rect.height * 100).toFixed(2));
    resetMarkForm(x, y);
    render();
  });

  markForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var data = Object.fromEntries(new FormData(markForm).entries());
    data.refs = String(markForm.refs.value || "").split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
    data.x = state.pendingXY ? state.pendingXY.x : 50;
    data.y = state.pendingXY ? state.pendingXY.y : 50;
    try {
      var saved = store.upsertMark(data);
      toast("已保存标记 " + saved.code, "ok");
      editMark(saved.id);
    } catch (e) {
      toast(e.message, "err");
      render();
    }
  });

  $("#deleteMarkBtn").onclick = function () {
    if (!markForm.id.value) return;
    if (!confirm("确认删除该标记？")) return;
    try {
      store.deleteMark(markForm.id.value);
      state.selectedMarkId = null;
      state.pendingXY = null;
      markForm.reset();
      setMarkFormReadonly(false);
      toast("已删除", "ok");
      render();
    } catch (e) { toast(e.message, "err"); }
  };

  $("#filterType").onchange = function (e) { state.filterType = e.target.value; render(); };
  $("#filterDive").onchange = function (e) { state.filterDive = e.target.value; render(); };
  $("#listMode").onchange = function (e) { state.listMode = e.target.value; render(); };
  $("#currentDive").onchange = function (e) { state.currentDiveCode = e.target.value; };

  /* ================= 封存视图 ================= */

  function renderDiveList() {
    var el = $("#diveList");
    if (!store.state.dives.length) {
      el.innerHTML = '<div class="muted">尚无潜次，点击上方「新建潜次」。</div>';
      return;
    }
    el.innerHTML = store.state.dives.slice().sort(function (a, b) {
      return String(a.code).localeCompare(String(b.code));
    }).map(function (d) {
      var seal = store.state.seals[d.id];
      return '<div class="item ' + (d.id === state.selectedDiveId ? "active" : "") + " " + (seal ? "sealed" : "") +
        '" data-dive-id="' + esc(d.id) + '"><b>' + esc(d.code) + "</b> " +
        (seal ? '<span class="pill ok">已封存</span>' : '<span class="pill warn">待封存</span>') +
        '<div class="muted">' + esc(d.date) + " · " + esc(d.site) + "</div>" +
        (seal ? '<div class="mono muted" style="font-size:11px">校验码 ' + esc(seal.code) + "</div>" : "") +
        "</div>";
    }).join("");
    $$("[data-dive-id]", el).forEach(function (node) {
      node.onclick = function () { selectDive(node.dataset.diveId); };
    });
  }

  function selectDive(id) {
    state.selectedDiveId = id;
    var d = store.getDive(id);
    state.diveDraft = d ? JSON.parse(JSON.stringify(d)) : null;
    renderSealPanel();
    renderDiveList();
  }

  $("#newDiveBtn").onclick = function () {
    var n = store.state.dives.length + 1;
    var code = "DIVE-" + String(Math.max(n, 1)).padStart(2, "0");
    while (store.state.dives.some(function (d) { return d.code === code; })) { n++; code = "DIVE-" + String(n).padStart(2, "0"); }
    try {
      var d = store.upsertDive({ code: code, affiliation: "", personnel: [], cylinders: [] });
      selectDive(d.id);
      toast("已新建潜次 " + code + "，请补登合规信息", "info");
    } catch (e) { toast(e.message, "err"); }
  };

  function weatherOptions(selected) {
    return Object.keys(DiveRules.WEATHER).map(function (k) {
      var w = DiveRules.WEATHER[k];
      return '<option value="' + k + '"' + (k === selected ? " selected" : "") + ">" + w.label +
        (w.level === "unsafe" ? "（禁作业）" : w.level === "caution" ? "（谨慎）" : "") + "</option>";
    }).join("");
  }

  function renderSealPanel() {
    var panel = $("#sealPanel");
    var id = state.selectedDiveId;
    var d = id ? store.getDive(id) : null;
    if (!d) {
      panel.innerHTML = '<div class="muted">从左侧选择一个潜次，补登人员、气瓶、深度、时长、天气与归属后运行合规检查。</div>';
      return;
    }
    var seal = store.state.seals[d.id];
    if (seal) { panel.innerHTML = sealCardHtml(seal); bindSealCard(panel, d.id); return; }

    var draft = state.diveDraft || JSON.parse(JSON.stringify(d));
    var roles = DiveRules.PERSON_ROLES.map(function (r) {
      return '<option value="' + r.value + '">' + r.label + "</option>";
    }).join("");
    panel.innerHTML =
      '<h2>潜次 ' + esc(d.code) + ' <span class="pill warn">待封存</span></h2>' +
      '<div class="row"><div><label>潜次编号</label><input data-f="code" value="' + esc(draft.code) + '"></div>' +
      '<div><label>作业日期</label><input type="date" data-f="date" value="' + esc(draft.date) + '"></div></div>' +
      '<div class="row"><div><label>作业地点</label><input data-f="site" value="' + esc(draft.site) + '"></div>' +
      '<div><label>归属单位/项目</label><input data-f="affiliation" value="' + esc(draft.affiliation) + '"></div></div>' +
      '<div class="row3"><div><label>天气</label><select data-f="weather"><option value="">请选择</option>' + weatherOptions(draft.weather) + "</select></div>" +
      '<div><label>最大深度(m)，限值 ' + esc(store.limits.maxDepth) + '</label><input inputmode="decimal" data-f="maxDepth" value="' + esc(draft.maxDepth) + '"></div>' +
      '<div><label>水下时长(分钟)，限值 ' + esc(store.limits.maxDuration) + '</label><input inputmode="numeric" data-f="duration" value="' + esc(draft.duration) + '"></div></div>' +
      '<h3>人员（至少一名潜水员）</h3><div id="peopleRows"></div><button type="button" class="small ghost" id="addPerson">＋ 添加人员</button>' +
      '<h3>气瓶（初压/残压，单位 bar）</h3><div id="cylRows"></div><button type="button" class="small ghost" id="addCyl">＋ 添加气瓶</button>' +
      '<h3>本潜次标记（' + store.marksOf(d.id).length + '）</h3>' + marksTableHtml(store.marksOf(d.id)) +
      '<div id="checkResult"></div>' +
      '<div class="toolbar" style="margin-top:10px"><button type="button" id="saveDiveBtn">保存登记信息</button>' +
      '<button type="button" id="runCheckBtn" class="secondary">运行合规检查</button></div>' +
      '<button type="button" id="doSealBtn" class="ghost" disabled style="width:100%">合规检查通过后可封存</button>';

    bindDraftFields(panel, draft);
    renderPeopleRows(draft);
    renderCylRows(draft);

    $("#saveDiveBtn", panel).onclick = function () { saveDraft(draft); };
    $("#runCheckBtn", panel).onclick = function () {
      if (!saveDraft(draft)) return;
      runCheck(d.id, panel);
    };
    $("#doSealBtn", panel).onclick = function () {
      if (!confirm("封存后该潜次的原标记与登记信息变为只读，只能通过复查台追加记录。确认封存？")) return;
      store.sealDive(d.id, $("#operatorName").value.trim()).then(function (sealRes) {
        toast("已封存 " + d.code + "，校验码 " + sealRes.code, "ok");
        selectDive(d.id);
        render();
      }).catch(function (e) {
        toast(e.message, "err");
        runCheck(d.id, panel);
      });
    };
  }

  function marksTableHtml(marks) {
    if (!marks.length) return '<div class="banner warn">该潜次还没有标记（可先在标记地图添加）。</div>';
    return '<table class="grid"><tr><th>编号</th><th>类型</th><th>深度</th><th>归属</th><th>引用</th></tr>' +
      marks.map(function (m) {
        return "<tr><td>" + esc(m.code) + "</td><td>" + (typeNames[m.type] || "?") + "</td><td>" + esc(m.depth) + "m</td><td>" +
          esc(m.attribution) + "</td><td>" + esc((m.refs || []).join(", ")) + "</td></tr>";
      }).join("") + "</table>";
  }

  function bindDraftFields(panel, draft) {
    $$("[data-f]", panel).forEach(function (input) {
      input.oninput = input.onchange = function () { draft[input.dataset.f] = input.value; };
    });
  }

  function roleOptions(selected) {
    return DiveRules.PERSON_ROLES.map(function (r) {
      return '<option value="' + r.value + '"' + (r.value === selected ? " selected" : "") + ">" + r.label + "</option>";
    }).join("");
  }

  function renderPeopleRows(draft) {
    var el = $("#peopleRows");
    draft.personnel = draft.personnel || [];
    el.innerHTML = draft.personnel.map(function (p, i) {
      return '<div class="row3" style="margin-bottom:6px" data-role-row="' + i + '">' +
        '<input data-k="name" placeholder="姓名" value="' + esc(p.name) + '">' +
        '<select data-k="role">' + roleOptions(p.role) + "</select>" +
        '<span style="display:flex;gap:6px"><input data-k="cert" placeholder="证书号" value="' + esc(p.cert) + '">' +
        '<button type="button" class="small danger" data-del="' + i + '">删</button></span></div>';
    }).join("");
    el.oninput = el.onchange = function (e) {
      var row = e.target.closest("[data-role-row]");
      if (!row || !e.target.dataset.k) return;
      draft.personnel[+row.dataset.roleRow][e.target.dataset.k] = e.target.value;
    };
    $$("[data-del]", el).forEach(function (b) {
      b.onclick = function () { draft.personnel.splice(+b.dataset.del, 1); renderPeopleRows(draft); };
    });
  }

  function renderCylRows(draft) {
    var el = $("#cylRows");
    draft.cylinders = draft.cylinders || [];
    el.innerHTML = draft.cylinders.map(function (c, i) {
      return '<div class="row" style="margin-bottom:6px" data-cyl-row="' + i + '">' +
        '<div class="row" style="grid-template-columns:1fr 1fr"><input data-k="serial" placeholder="气瓶编号" value="' + esc(c.serial) + '">' +
        '<input data-k="gas" placeholder="气体" value="' + esc(c.gas || "压缩空气") + '"></div>' +
        '<div class="row" style="grid-template-columns:1fr 1fr auto"><input inputmode="numeric" data-k="pressureStart" placeholder="初压" value="' + esc(c.pressureStart) + '">' +
        '<input inputmode="numeric" data-k="pressureEnd" placeholder="残压" value="' + esc(c.pressureEnd) + '">' +
        '<button type="button" class="small danger" data-del="' + i + '">删</button></div></div>';
    }).join("");
    el.oninput = el.onchange = function (e) {
      var row = e.target.closest("[data-cyl-row]");
      if (!row || !e.target.dataset.k) return;
      draft.cylinders[+row.dataset.cylRow][e.target.dataset.k] = e.target.value;
    };
    $$("[data-del]", el).forEach(function (b) {
      b.onclick = function () { draft.cylinders.splice(+b.dataset.del, 1); renderCylRows(draft); };
    });
  }

  function saveDraft(draft) {
    try {
      store.upsertDive(JSON.parse(JSON.stringify(draft)));
      toast("登记信息已保存", "ok");
      return true;
    } catch (e) { toast(e.message, "err"); return false; }
  }

  function runCheck(diveId, panel) {
    var result = store.validateDive(diveId);
    var box = $("#checkResult", panel);
    var html = "";
    if (result.errors.length) {
      html += '<div class="banner err"><b>封存被拦截（' + result.errors.length + " 项）</b><ul>" +
        result.errors.map(function (x) { return "<li>" + esc(x.message) + "</li>"; }).join("") + "</ul></div>";
    } else {
      html += '<div class="banner ok"><b>合规检查通过，可以封存。</b>' +
        (result.warnings.length ? " 另有警告见下。" : "") + "</div>";
    }
    if (result.warnings.length) {
      html += '<div class="banner warn"><b>警告（不拦截，' + result.warnings.length + " 项）</b><ul>" +
        result.warnings.map(function (x) { return "<li>" + esc(x.message) + "</li>"; }).join("") + "</ul></div>";
    }
    box.innerHTML = html;
    var btn = $("#doSealBtn", panel);
    btn.disabled = !result.ok;
    btn.textContent = result.ok ? "确认封存（生成只读快照与校验码）" : "合规检查通过后可封存";
    return result;
  }

  function sealCardHtml(seal) {
    var wHtml = seal.warnings && seal.warnings.length
      ? '<details><summary>封存时警告（' + seal.warnings.length + "）</summary><ul>" +
        seal.warnings.map(function (w) { return "<li>" + esc(w.message) + "</li>"; }).join("") + "</ul></details>" : "";
    return '<h2>' + esc(seal.diveCode) + ' <span class="pill ok">已封存·只读</span></h2>' +
      '<div class="checksum-card"><div class="muted" style="color:#bfe0e6">封存校验码（SHA-256 前 12 位）</div>' +
      '<div class="code" id="sealCode_' + esc(seal.diveId) + '">' + esc(seal.code) + "</div>" +
      '<div class="full mono">' + esc(seal.checksum) + "</div>" +
      '<div class="muted" style="color:#bfe0e6">封存时间 ' + esc(seal.sealedAt) + " · 操作人 " + esc(seal.operator || "—") +
      ' · <span id="sealVerify_' + esc(seal.diveId) + '">校验中…</span></div></div>' +
      '<dl class="kv"><dt>地点</dt><dd>' + esc(seal.snapshot.dive.site) + "</dd>" +
      "<dt>日期</dt><dd>" + esc(seal.snapshot.dive.date) + "</dd>" +
      "<dt>归属</dt><dd>" + esc(seal.snapshot.dive.affiliation) + "</dd>" +
      "<dt>天气/深度/时长</dt><dd>" + esc(DiveRules.WEATHER[seal.snapshot.dive.weather] ? DiveRules.WEATHER[seal.snapshot.dive.weather].label : seal.snapshot.dive.weather) +
      " · " + esc(seal.snapshot.dive.maxDepth) + "m · " + esc(seal.snapshot.dive.duration) + " 分钟</dd>" +
      "<dt>人员</dt><dd>" + seal.snapshot.dive.personnel.map(function (p) {
        var rn = DiveRules.PERSON_ROLES.find(function (r) { return r.value === p.role; });
        return esc(p.name) + "(" + (rn ? rn.label : p.role) + ")";
      }).join("、") + "</dd>" +
      "<dt>气瓶</dt><dd>" + seal.snapshot.dive.cylinders.map(function (c) {
        return esc(c.serial) + " " + esc(c.pressureStart) + "→" + esc(c.pressureEnd) + "bar";
      }).join("、") + "</dd></dl>" +
      "<h3>快照内标记（" + seal.snapshot.marks.length + "）</h3>" + marksTableHtml(seal.snapshot.marks) +
      wHtml +
      '<div class="row" style="margin-top:10px"><button type="button" id="gotoReviewBtn" class="secondary">在复查台打开</button>' +
      '<button type="button" id="restoreHereBtn" class="danger">还原此快照</button></div>';
  }

  function bindSealCard(panel, diveId) {
    store.verifySeal(diveId).then(function (res) {
      var el = $("#sealVerify_" + diveId);
      if (!el) return;
      el.textContent = res.ok ? "✓ 复算一致" : "✗ 快照校验不一致";
      el.style.color = res.ok ? "#9be3b4" : "#ffb4a5";
    });
    var rb = $("#gotoReviewBtn", panel);
    if (rb) rb.onclick = function () {
      $$(".tab").forEach(function (t) { t.classList.toggle("active", t.dataset.view === "review"); });
      $$(".view").forEach(function (v) { v.classList.toggle("active", v.id === "view-review"); });
      state.view = "review";
      $("#reviewDive").value = store.getDive(diveId).code;
      renderReview();
    };
    $("#restoreHereBtn", panel).onclick = function () { doRestore(diveId); };
  }

  /* ================= 复查台 ================= */

  $("#reviewDive").onchange = renderReview;
  $("#goSealFromReview").onclick = function () {
    $$(".tab").forEach(function (t) { t.classList.toggle("active", t.dataset.view === "seal"); });
    $$(".view").forEach(function (v) { v.classList.toggle("active", v.id === "view-seal"); });
    state.view = "seal";
    var code = $("#reviewDive").value;
    var d = store.state.dives.find(function (x) { return x.code === code; });
    if (d) selectDive(d.id);
    render();
  };

  function renderReview() {
    fillDiveOptions();
    var body = $("#reviewBody");
    var code = $("#reviewDive").value;
    var dive = store.state.dives.find(function (d) { return d.code === code; });
    if (!dive) { body.innerHTML = '<div class="muted">已封存的潜次才能追加复查。请先在「潜次封存」完成封存。</div>'; return; }
    var seal = store.state.seals[dive.id];
    if (!seal) { body.innerHTML = '<div class="banner warn">潜次 ' + esc(code) + " 尚未封存。</div>"; return; }
    var reviews = store.state.reviews[dive.id] || [];
    var chain = store.verifyReviewChain(dive.id);

    body.innerHTML =
      '<div class="row"><div>' +
      '<h2 style="margin-top:0">' + esc(code) + ' 复查记录 <span class="pill ok">只读封存 · 追加模式</span></h2>' +
      '<div class="mono muted">封存校验码 ' + esc(seal.code) + " · 复查链 " +
      (chain.ok ? '<span class="pill ok">完整(' + chain.count + ")</span>" : '<span class="pill err">断链 ' + esc(chain.reason) + "</span>") +
      ' · <span id="rvSealCheck">复算…</span></div></div>' +
      '<div style="text-align:right"><button type="button" class="small ghost" id="rvGotoSeal">查看封存快照</button></div></div>' +
      '<h3>已追加复查（' + reviews.length + "，仅追加，不可改写原记录）</h3><div id='reviewList'></div>" +
      "<h3>追加新复查</h3>" +
      '<div class="row"><div><label>复查人</label><input id="rvAuthor" value="' + esc($("#operatorName").value) + '"></div>' +
      '<div><label>复查日期时间（自动）</label><input value="' + esc(new Date().toLocaleString()) + '" disabled></div></div>' +
      '<label>复查结论</label><textarea id="rvNote" placeholder="总体情况、环境变化、处置建议"></textarea>' +
      "<h3>标记逐条观测</h3><div id='rvChangeRows'></div>" +
      '<button type="button" class="small ghost" id="rvAddChange">＋ 添加观测行</button>' +
      '<div style="margin-top:10px"><button type="button" id="rvSubmit">追加复查记录</button></div>' +
      '<div id="rvSubmitMsg"></div>' +
      "<h3>与封存快照的差异比较</h3><div id='rvDiff'></div>";

    store.verifySeal(dive.id).then(function (r) {
      var el = $("#rvSealCheck");
      if (el) el.innerHTML = r.ok ? '<span class="pill ok">快照校验一致</span>' : '<span class="pill err">快照被改动</span>';
    });
    $("#rvGotoSeal").onclick = function () { selectDive(dive.id); state.view = "seal"; $$(".tab").forEach(function (t) { t.classList.toggle("active", t.dataset.view === "seal"); }); $$(".view").forEach(function (v) { v.classList.toggle("active", v.id === "view-seal"); }); renderSealPanel(); renderDiveList(); };

    var listEl = $("#reviewList");
    listEl.innerHTML = reviews.length ? reviews.map(function (r, idx) {
      return '<details><summary>#' + (idx + 1) + " " + esc(r.at) + " · " + esc(r.author) + "</summary>" +
        "<div>" + esc(r.note).replace(/\n/g, "<br>") + "</div>" +
        (r.changes.length ? '<table class="grid"><tr><th>标记</th><th>现状</th><th>观测</th><th>处置</th></tr>' +
          r.changes.map(function (c) { return "<tr><td>" + esc(c.code) + "</td><td>" + esc(c.condition) + "</td><td>" + esc(c.observation) + "</td><td>" + esc(c.action) + "</td></tr>"; }).join("") + "</table>" : "") +
        '<div class="mono muted" style="font-size:11px">链式哈希 ' + esc(r.hash) + "</div></details>";
    }).join("") : '<div class="muted">尚无复查记录。</div>';

    var changeDraft = [{}];
    function renderChangeRows() {
      $("#rvChangeRows").innerHTML = changeDraft.map(function (c, i) {
        return '<div class="row" style="margin-bottom:6px" data-cr="' + i + '">' +
          '<input data-k="code" placeholder="标记编号 如 A-001" value="' + esc(c.code) + '">' +
          '<input data-k="condition" placeholder="现状 如 中度劣化" value="' + esc(c.condition) + '">' +
          '<input data-k="observation" placeholder="观测说明" value="' + esc(c.observation) + '">' +
          '<span style="display:flex;gap:6px"><input data-k="action" placeholder="处置建议" value="' + esc(c.action) + '">' +
          '<button type="button" class="small danger" data-del="' + i + '">删</button></span></div>';
      }).join("");
      var box = $("#rvChangeRows");
      box.oninput = function (e) {
        var row = e.target.closest("[data-cr]");
        if (row && e.target.dataset.k) changeDraft[+row.dataset.cr][e.target.dataset.k] = e.target.value;
      };
      $$("[data-del]", box).forEach(function (b) {
        b.onclick = function () { changeDraft.splice(+b.dataset.del, 1); if (!changeDraft.length) changeDraft.push({}); renderChangeRows(); };
      });
    }
    renderChangeRows();
    $("#rvAddChange").onclick = function () { changeDraft.push({}); renderChangeRows(); };

    $("#rvSubmit").onclick = function () {
      try {
        store.addReview(dive.id, {
          author: $("#rvAuthor").value.trim(),
          note: $("#rvNote").value.trim(),
          changes: changeDraft.filter(function (c) { return c.code || c.observation; })
        });
        toast("复查记录已追加（原封存快照未改动）", "ok");
        renderReview();
      } catch (e) {
        $("#rvSubmitMsg").innerHTML = '<div class="banner err">' + esc(e.message) + "</div>";
      }
    };

    renderDiff(dive.id, reviews.length);
  }

  function diffTableHtml(diff) {
    var rows = "";
    diff.added.forEach(function (m) {
      rows += '<tr class="diff-add"><td>＋新增</td><td>' + esc(m.code) + "</td><td>" + esc(m.note || m.condition || "") + "</td><td></td><td></td></tr>";
    });
    diff.removed.forEach(function (m) {
      rows += '<tr class="diff-del"><td>－消失</td><td>' + esc(m.code) + "</td><td></td><td></td><td></td></tr>";
    });
    diff.changed.forEach(function (c) {
      c.fields.forEach(function (f) {
        var fnames = { condition: "保存状态", orientation: "朝向", depth: "深度", note: "备注", attribution: "归属", type: "类型" };
        rows += '<tr class="diff-chg"><td>改</td><td>' + esc(c.code) + "</td><td>" + esc(fnames[f.field] || f.field) + "</td><td>" +
          esc(f.from) + "</td><td>" + esc(f.to) + "</td></tr>";
      });
    });
    (diff.observations || []).forEach(function (o) {
      rows += '<tr><td>#' + o.seq + ' 观测</td><td>' + esc(o.code) + "</td><td>复查记录</td><td colspan='2'>" +
        esc(o.observation) + (o.action ? "（建议处置：" + esc(o.action) + "）" : "") + "</td></tr>";
    });
    if (!rows) return '<div class="banner ok">与封存快照完全一致，无差异。</div>';
    return '<table class="grid"><tr><th>变化</th><th>编号</th><th>字段</th><th>封存时</th><th>复查后</th></tr>' + rows + "</table>";
  }

  function renderDiff(diveId, reviewCount) {
    var el = $("#rvDiff");
    var latest = store.reviewDiff(diveId);
    var html = '<div class="muted">累计（第 ' + reviewCount + ' 次复查后 vs 封存时）</div>' + diffTableHtml(latest);
    if (reviewCount > 1) {
      html += "<h3>逐次差异</h3>";
      for (var i = 0; i < reviewCount; i++) {
        html += '<details><summary>第 ' + (i + 1) + " 次复查后</summary>" + diffTableHtml(store.reviewDiff(diveId, i)) + "</details>";
      }
    }
    el.innerHTML = html;
  }

  /* ================= 数据与审计视图 ================= */

  $("#operatorName").value = localStorage.getItem("diveArchive.operator") || "";
  $("#operatorName").oninput = function () { localStorage.setItem("diveArchive.operator", this.value); };

  $("#exportAuditBtn").onclick = exportAudit;
  $("#quickExportAudit").onclick = exportAudit;
  function exportAudit() {
    store.exportAuditPackage($("#operatorName").value.trim()).then(function (pkg) {
      var bad = Object.keys(pkg.sealChecks).filter(function (id) { return !pkg.sealChecks[id].ok || !pkg.sealChecks[id].reviewChain; });
      download("dive-audit-" + stamp() + ".json", JSON.stringify(pkg, null, 2));
      toast("审计包已导出" + (bad.length ? "（警告：" + bad.length + " 个封存校验异常，见包内 sealChecks）" : "，全部封存校验通过"), bad.length ? "err" : "ok");
    }).catch(function (e) { toast("导出失败：" + e.message, "err"); });
  }

  $("#exportStateBtn").onclick = function () {
    download("dive-state-" + stamp() + ".json", JSON.stringify(store.state, null, 2));
    toast("当前数据 JSON 已导出", "ok");
  };

  $("#importBtn").onclick = function () { $("#fileInput").click(); };
  $("#quickImport").onclick = function () {
    state.view = "data";
    $$(".tab").forEach(function (t) { t.classList.toggle("active", t.dataset.view === "data"); });
    $$(".view").forEach(function (v) { v.classList.toggle("active", v.id === "view-data"); });
    renderData();
    $("#fileInput").click();
  };
  $("#fileInput").onchange = function () {
    var file = this.files[0];
    this.value = "";
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      store.importJson(String(reader.result)).then(function (res) {
        toast("导入成功（" + res.kind + "），原状态已进入隔离区保底", "ok");
        state.selectedDiveId = null; state.diveDraft = null; state.selectedMarkId = null;
        render();
      }).catch(function (e) {
        toast(e.message, "err");
        renderData();
      });
    };
    reader.readAsText(file);
  };

  function doRestore(diveId) {
    var d = store.getDive(diveId);
    if (!confirm("将用封存快照覆盖潜次 " + d.code + " 的当前标记与登记信息。还原前的完整现状会自动存入隔离区，不会丢失。确认还原？")) return;
    try {
      store.restoreSnapshot(diveId, "界面手动还原", $("#operatorName").value.trim());
      toast("已按快照还原 " + d.code + "（还原前状态已隔离保底）", "ok");
      selectDive(diveId);
      render();
    } catch (e) { toast(e.message, "err"); }
  }

  function renderData() {
    // 封存校验总览 + 还原列表
    var box = $("#restoreList");
    var ids = Object.keys(store.state.seals);
    if (!ids.length) { box.innerHTML = '<div class="muted">尚无已封存潜次。</div>'; }
    else {
      box.innerHTML = ids.map(function (id) {
        var s = store.state.seals[id];
        var chain = store.verifyReviewChain(id);
        return '<div class="item sealed" data-restore="' + esc(id) + '"><b>' + esc(s.diveCode) + "</b> " +
          '<span class="pill ok">已封存</span> <span class="mono muted">' + esc(s.code) + "</span> " +
          '<span class="pill ' + (chain.ok ? "ok" : "err") + '">复查链 ' + (chain.ok ? chain.count + " 条" : chain.reason) + "</span> " +
          '<span class="pill" data-verify="' + esc(id) + '">校验中…</span>' +
          '<div class="muted">封存于 ' + esc(s.sealedAt) + ' · 操作人 ' + esc(s.operator || "—") + "</div>" +
          '<div style="margin-top:6px"><button type="button" class="small danger" data-restore-btn="' + esc(id) + '">还原快照</button></div></div>';
      }).join("");
      $$("[data-restore-btn]", box).forEach(function (b) {
        b.onclick = function () { doRestore(b.dataset.restoreBtn); };
      });
      ids.forEach(function (id) {
        store.verifySeal(id).then(function (r) {
          var el = $('[data-verify="' + id + '"]', box);
          if (!el) return;
          el.textContent = r.ok ? "快照校验一致" : "快照校验不一致";
          el.className = "pill " + (r.ok ? "ok" : "err");
        });
      });
    }

    // 启动提示
    $("#noticesList").innerHTML = store.notices.length
      ? store.notices.map(function (n) { return '<div class="banner info">[' + esc(n.type) + "] " + esc(n.detail) + "</div>"; }).join("")
      : '<div class="muted">本次启动无异常提示。</div>';

    // 隔离区
    var q = store.getQuarantine();
    var ql = $("#quarantineList");
    if (!q.length) { ql.innerHTML = '<div class="muted">隔离区为空。</div>'; return; }
    ql.innerHTML = q.map(function (x, i) {
      return '<details><summary>[' + esc(x.kind) + "] " + esc(new Date(x.at).toLocaleString()) + " — " + esc(x.reason) + "</summary>" +
        '<pre class="raw">' + esc(x.raw).slice(0, 5000) + (x.raw.length > 5000 ? "…（截断）" : "") + "</pre>" +
        '<button type="button" class="small secondary" data-q="' + i + '">导出原文</button></details>';
    }).join("");
    $$("[data-q]", ql).forEach(function (b) {
      b.onclick = function () {
        var item = store.getQuarantine()[+b.dataset.q];
        download("quarantine-" + item.kind + "-" + stamp() + ".txt", item.raw, "text/plain");
      };
    });
  }

  /* ---------------- 统一渲染与订阅 ---------------- */

  function render() {
    fillDiveOptions();
    if (state.view === "map") { renderMap(); renderMarkList(); }
    if (state.view === "seal") { renderDiveList(); renderSealPanel(); }
    if (state.view === "review") renderReview();
    if (state.view === "data") renderData();
  }

  /* 说明：不做订阅式全量重绘——封存面板含未保存草稿与人员/气瓶子行，
     中途重建 DOM 会让检查结果写入脱离文档的节点。各写操作在处理器内显式局部刷新。 */

  renderLoadBanners();
  render();
})();
