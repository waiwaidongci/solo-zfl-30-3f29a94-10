/* 数据层：潜次封存、追加复查、备份隔离、快照还原、审计包。
 * 无界面依赖，可在 Node 直接测试。UMD（Node / 浏览器通用）。 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(
      require("./crypto-util.js"),
      require("./rules.js")
    );
  } else {
    root.DiveStore = factory(root.DiveCrypto, root.DiveRules);
  }
})(typeof self !== "undefined" ? self : this, function (Crypto, Rules) {
  "use strict";

  var STATE_VERSION = 2;
  var KEYS = {
    state: "diveArchive.state.v2",
    backup: "diveArchive.state.backup",
    quarantine: "diveArchive.quarantine" // 坏版本/坏文件原文隔离，绝不覆盖
  };
  var AUDIT_VERSION = "audit-v1";

  /* ---------------- 存储适配器 ---------------- */

  function memoryStorage(seed) {
    var map = {};
    if (seed) Object.keys(seed).forEach(function (k) { map[k] = seed[k]; });
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
      setItem: function (k, v) { map[k] = String(v); },
      removeItem: function (k) { delete map[k]; },
      _dump: function () { return map; }
    };
  }

  function localStorageStorage() {
    return {
      getItem: function (k) { return window.localStorage.getItem(k); },
      setItem: function (k, v) { window.localStorage.setItem(k, v); },
      removeItem: function (k) { window.localStorage.removeItem(k); }
    };
  }

  /* ---------------- 初始 / 迁移数据 ---------------- */

  function emptyState() {
    return {
      version: STATE_VERSION,
      dives: [],
      marks: [],
      seals: {},
      reviews: {},
      auditLog: []
    };
  }

  function demoState() {
    var state = emptyState();
    state.dives = [
      {
        id: "demo-dive-01", code: "DIVE-01", site: "一号沉船遗址", date: "2026-08-02",
        affiliation: "省文物考古研究院水下考古中心", weather: "cloudy",
        maxDepth: "20", duration: "42",
        personnel: [
          { name: "周牧", role: "diver", cert: "SD-2021-044" },
          { name: "林岚", role: "supervisor", cert: "SS-2019-012" },
          { name: "郑海", role: "recorder", cert: "" }
        ],
        cylinders: [
          { serial: "G-088", gas: "压缩空气", pressureStart: "190", pressureEnd: "70" }
        ]
      },
      {
        id: "demo-dive-02", code: "DIVE-02", site: "一号沉船遗址", date: "2026-08-03",
        affiliation: "省文物考古研究院水下考古中心", weather: "sunny",
        maxDepth: "22", duration: "38",
        personnel: [
          { name: "周牧", role: "diver", cert: "SD-2021-044" },
          { name: "林岚", role: "supervisor", cert: "SS-2019-012" }
        ],
        cylinders: [
          { serial: "G-088", gas: "压缩空气", pressureStart: "195", pressureEnd: "85" }
        ]
      }
    ];
    state.marks = [
      { id: "demo-mark-01", code: "A-017", type: "ceramic", dive: "DIVE-01", x: 42, y: 46, depth: "17.8", orientation: "东", condition: "边缘残缺", attribution: "省文物考古研究院", refs: [], note: "靠近船肋" },
      { id: "demo-mark-02", code: "W-003", type: "wood", dive: "DIVE-02", x: 58, y: 39, depth: "18.2", orientation: "西北", condition: "稳定", attribution: "省文物考古研究院", refs: [], note: "疑似横梁" }
    ];
    return state;
  }

  /** 旧版（单文件页 zfl30Marks）标记数组迁移为 v2 状态。 */
  function migrateV1(raw) {
    var list = JSON.parse(raw);
    if (!Array.isArray(list)) throw new Error("旧版数据不是标记数组");
    var state = emptyState();
    var diveMap = {};
    list.forEach(function (m) {
      var code = m.dive || "DIVE-UNKNOWN";
      if (!diveMap[code]) {
        var id = "mig-" + Crypto.uuid();
        diveMap[code] = id;
        state.dives.push({
          id: id, code: code, site: "", date: "", affiliation: "", weather: "",
          maxDepth: "", duration: "", personnel: [], cylinders: []
        });
      }
      var num = String(m.depth || "").replace(/m/i, "").trim();
      state.marks.push({
        id: m.id || Crypto.uuid(),
        code: m.code || "",
        type: m.type || "unknown",
        dive: code,
        x: typeof m.x === "number" ? m.x : 50,
        y: typeof m.y === "number" ? m.y : 50,
        depth: num,
        orientation: m.orientation || "",
        condition: m.condition || "",
        attribution: m.attribution || "",
        refs: Array.isArray(m.refs) ? m.refs.slice() : [],
        note: m.note || ""
      });
    });
    return state;
  }

  /* ---------------- 载入 / 损坏隔离 ---------------- */

  /**
   * 从存储载入。主档损坏时尝试备份；都坏则保留原文到隔离区并返回空状态，
   * 绝不覆盖或删除任何已有数据。
   */
  function loadState(storage, opts) {
    opts = opts || {};
    var notices = [];
    var raw = storage.getItem(KEYS.state);
    var state = null;

    if (raw !== null) {
      try {
        state = JSON.parse(raw);
        if (!state || typeof state !== "object") throw new Error("根节点不是对象");
      } catch (e) {
        quarantine(storage, "state", raw, e.message);
        notices.push({ type: "STATE_CORRUPT", detail: "主档 JSON 损坏，已隔离原文：" + e.message });
        state = null;
      }
      if (state) {
        if (state.version === STATE_VERSION) {
          state = normalizeState(state);
        } else if (typeof state.version === "number" && state.version > STATE_VERSION) {
          quarantine(storage, "future", raw, "未知的新版本 v" + state.version);
          notices.push({ type: "STATE_FUTURE_VERSION", detail: "数据来自更新版本(v" + state.version + ")，已隔离保留，请用新版软件打开" });
          state = null;
        } else if (state.version === 1 || !state.version) {
          // v1 形态是标记数组（兼容本应用旧单文件页）
          state = null; notices.push({ type: "STATE_LEGACY", detail: "发现旧版数据，需迁移" });
        }
      }
    }

    if (!state) {
      var backup = storage.getItem(KEYS.backup);
      if (backup !== null) {
        try {
          var parsed = JSON.parse(backup);
          if (parsed && parsed.version === STATE_VERSION) {
            state = normalizeState(parsed);
            notices.push({ type: "RESTORED_FROM_BACKUP", detail: "已从上一次自动备份恢复" });
          }
        } catch (e) {
          quarantine(storage, "backup", backup, e.message);
          notices.push({ type: "BACKUP_CORRUPT", detail: "备份同样损坏，已隔离原文" });
        }
      }
    }

    // 旧单文件页数据迁移
    if (!state) {
      var legacy = storage.getItem("zfl30Marks");
      if (legacy !== null && !(opts && opts.noMigrate)) {
        try {
          state = migrateV1(legacy);
          notices.push({ type: "MIGRATED_V1", detail: "已从旧版标记页迁移 " + state.marks.length + " 个标记（潜次需补登合规信息后方可封存）" });
        } catch (e) {
          quarantine(storage, "legacy", legacy, e.message);
          notices.push({ type: "LEGACY_CORRUPT", detail: "旧版数据损坏，已隔离原文" });
        }
      }
    }

    var fresh = false;
    if (!state) {
      state = opts && opts.demo === false ? emptyState() : demoState();
      fresh = true;
      notices.push({ type: "FRESH_STATE", detail: "已建立新日志" });
    }

    return { state: state, notices: notices, fresh: fresh };
  }

  function quarantine(storage, kind, raw, reason) {
    var list = [];
    try { list = JSON.parse(storage.getItem(KEYS.quarantine) || "[]"); } catch (e) { list = []; }
    if (!Array.isArray(list)) list = [];
    list.push({ id: Crypto.uuid(), kind: kind, reason: String(reason || ""), raw: String(raw), at: new Date().toISOString() });
    storage.setItem(KEYS.quarantine, JSON.stringify(list));
  }

  function normalizeState(s) {
    return {
      version: STATE_VERSION,
      dives: Array.isArray(s.dives) ? s.dives : [],
      marks: Array.isArray(s.marks) ? s.marks : [],
      seals: s.seals && typeof s.seals === "object" ? s.seals : {},
      reviews: s.reviews && typeof s.reviews === "object" ? s.reviews : {},
      auditLog: Array.isArray(s.auditLog) ? s.auditLog : []
    };
  }

  /* ---------------- 差异比较 ---------------- */

  /** 比较两次复查（或快照→复查）的标记状态差异。 */
  function diffMarks(before, after) {
    var mapA = {}, mapB = {};
    (before || []).forEach(function (m) { mapA[m.code] = m; });
    (after || []).forEach(function (m) { mapB[m.code] = m; });
    var fields = ["condition", "orientation", "depth", "note", "attribution", "type"];
    var added = [], removed = [], changed = [];
    Object.keys(mapB).forEach(function (code) {
      if (!mapA[code]) added.push(mapB[code]);
    });
    Object.keys(mapA).forEach(function (code) {
      if (!mapB[code]) { removed.push(mapA[code]); return; }
      var a = mapA[code], b = mapB[code], ds = [];
      fields.forEach(function (f) {
        if (String(a[f] == null ? "" : a[f]) !== String(b[f] == null ? "" : b[f])) {
          ds.push({ field: f, from: a[f] == null ? "" : a[f], to: b[f] == null ? "" : b[f] });
        }
      });
      if (ds.length) changed.push({ code: code, fields: ds });
    });
    return { added: added, removed: removed, changed: changed };
  }

  /* ---------------- Store ---------------- */

  function Store(storage, opts) {
    opts = opts || {};
    this.storage = storage || memoryStorage();
    this.limits = Object.assign({}, Rules.DEFAULT_LIMITS, opts.limits || {});
    this.now = opts.now || function () { return new Date().toISOString(); };
    this.listeners = [];
    var loaded = loadState(this.storage, opts);
    this.state = loaded.state;
    this.notices = loaded.notices;
    if (loaded.fresh || loaded.notices.some(function (n) { return n.type === "MIGRATED_V1" || n.type === "RESTORED_FROM_BACKUP"; })) {
      this._persist("init/migrate");
    }
  }

  Store.KEYS = KEYS;
  Store.STATE_VERSION = STATE_VERSION;
  Store.AUDIT_VERSION = AUDIT_VERSION;
  Store.emptyState = emptyState;
  Store.demoState = demoState;
  Store.memoryStorage = memoryStorage;
  Store.localStorageStorage = localStorageStorage;
  Store.loadState = loadState;
  Store.diffMarks = diffMarks;

  Store.prototype.subscribe = function (fn) {
    var self = this;
    this.listeners.push(fn);
    return function () {
      self.listeners = self.listeners.filter(function (f) { return f !== fn; });
    };
  };
  Store.prototype._emit = function (event) {
    var self = this;
    this.listeners.forEach(function (fn) { try { fn(event, self.state); } catch (e) {} });
  };

  Store.prototype._log = function (action, detail) {
    this.state.auditLog.push({ id: Crypto.uuid(), at: this.now(), action: action, detail: detail || {} });
  };

  Store.prototype._persist = function (action, detail) {
    var serialized = JSON.stringify(this.state);
    this.storage.setItem(KEYS.state, serialized);
    // 回读校验：确认主档完整写入后，才提升为「最近完好备份」。
    // 若写入被截断/损坏，备份仍停留在上一份已验证完好的状态，不会被污染。
    var reread = this.storage.getItem(KEYS.state);
    try {
      var parsed = JSON.parse(reread);
      if (parsed && parsed.version === STATE_VERSION) {
        this.storage.setItem(KEYS.backup, serialized);
      }
    } catch (e) { /* 主档疑似写坏：保留旧备份，等待下次启动恢复 */ }
    if (action) this._log(action, detail);
  };

  Store.prototype.commit = function (action, detail) {
    this._persist(action, detail);
    this._emit({ type: action, detail: detail });
  };

  Store.prototype.isSealed = function (diveId) { return !!this.state.seals[diveId]; };
  Store.prototype.getDive = function (diveId) {
    return this.state.dives.find(function (d) { return d.id === diveId; }) || null;
  };
  Store.prototype.marksOf = function (diveId) {
    var dive = this.getDive(diveId);
    if (!dive) return [];
    return this.state.marks.filter(function (m) { return m.dive === dive.code; });
  };

  /* ---- 标记（原单文件页功能，封存后只读）---- */

  Store.prototype.upsertMark = function (data) {
    var current = data.id ? this.state.marks.find(function (m) { return m.id === data.id; }) : null;
    // 目标潜次（新建取 data.dive）与原潜次（编辑时）都必须未封存，
    // 防止把已封存潜次的标记改挂到其他潜次而绕过只读。
    var newDiveCode = data.dive !== undefined ? data.dive : (current && current.dive);
    var newDive = this.state.dives.find(function (d) { return d.code === newDiveCode; });
    if (newDive && this.state.seals[newDive.id]) {
      var e1 = new Error("潜次 " + newDiveCode + " 已封存，标记只读");
      e1.code = "DIVE_SEALED"; throw e1;
    }
    if (current) {
      var oldDive = this.state.dives.find(function (d) { return d.code === current.dive; });
      if (oldDive && this.state.seals[oldDive.id]) {
        var e2 = new Error("标记原属潜次 " + current.dive + " 已封存，不能改挂或编辑");
        e2.code = "DIVE_SEALED"; throw e2;
      }
    }
    var diveCode = data.dive || (current && current.dive);
    if (data.code) {
      var key = String(data.code).trim().toUpperCase();
      var clash = this.state.marks.find(function (m) {
        return String(m.code || "").trim().toUpperCase() === key && (!current || m.id !== current.id);
      });
      if (clash) { var err = new Error("标记编号重号：" + data.code); err.code = "MARK_CODE_DUPLICATE"; throw err; }
    }
    if (current) {
      Object.assign(current, data);
      this.commit("mark.update", { id: current.id, code: current.code });
      return current;
    }
    var mark = {
      id: data.id || Crypto.uuid(), code: "", type: "unknown", dive: diveCode || "",
      x: 50, y: 50, depth: "", orientation: "", condition: "", attribution: "", refs: [], note: ""
    };
    if (data.id && this.state.marks.some(function (m) { return m.id === data.id; })) {
      var e3 = new Error("标记内部 ID 已存在"); e3.code = "ID_EXISTS"; throw e3;
    }
    Object.assign(mark, data, { id: mark.id });
    this.state.marks.push(mark);
    this.commit("mark.create", { id: mark.id, code: mark.code });
    return mark;
  };

  Store.prototype.deleteMark = function (id) {
    var mark = this.state.marks.find(function (m) { return m.id === id; });
    if (!mark) return false;
    var dive = this.state.dives.find(function (d) { return d.code === mark.dive; });
    if (dive && this.state.seals[dive.id]) {
      var e = new Error("潜次已封存，标记不可删除"); e.code = "DIVE_SEALED"; throw e;
    }
    this.state.marks = this.state.marks.filter(function (m) { return m.id !== id; });
    this.commit("mark.delete", { id: id, code: mark.code });
    return true;
  };

  /* ---- 潜次登记信息 ---- */

  Store.prototype.upsertDive = function (data) {
    var current = data.id ? this.state.dives.find(function (d) { return d.id === data.id; }) : null;
    if (current && this.state.seals[current.id]) {
      var e = new Error("潜次已封存，登记信息只读"); e.code = "DIVE_SEALED"; throw e;
    }
    var code = (data.code || (current && current.code) || "").trim();
    if (code) {
      var clash = this.state.dives.find(function (d) {
        return d.code === code && (!current || d.id !== current.id);
      });
      if (clash) { var err = new Error("潜次编号重号：" + code); err.code = "DIVE_CODE_DUPLICATE"; throw err; }
    }
    if (current) {
      Object.assign(current, data);
      this.commit("dive.update", { id: current.id, code: current.code });
      return current;
    }
    var dive = Object.assign({
      id: Crypto.uuid(), code: "", site: "", date: "", affiliation: "", weather: "",
      maxDepth: "", duration: "", personnel: [], cylinders: []
    }, data);
    if (data.id) dive.id = data.id;
    this.state.dives.push(dive);
    this.commit("dive.create", { id: dive.id, code: dive.code });
    return dive;
  };

  /* ---- 合规封存：生成带校验码的只读快照 ---- */

  Store.prototype.validateDive = function (diveId) {
    return Rules.validateForSeal(this.state, diveId, this.limits);
  };

  Store.prototype.sealDive = async function (diveId, operator) {
    if (this.state.seals[diveId]) {
      var e0 = new Error("潜次已封存，不能重复封存"); e0.code = "ALREADY_SEALED"; throw e0;
    }
    var result = this.validateDive(diveId);
    if (!result.ok) {
      var e = new Error("合规检查未通过，封存已拦截");
      e.code = "VALIDATION_FAILED"; e.issues = result.errors; throw e;
    }
    var dive = this.getDive(diveId);
    var marks = this.marksOf(diveId);
    var snapshot = {
      sealedAt: this.now(),
      ruleVersion: Rules.RULE_VERSION,
      limits: Object.assign({}, this.limits),
      dive: JSON.parse(JSON.stringify(dive)),
      marks: JSON.parse(JSON.stringify(marks)),
      warnings: result.warnings
    };
    var info = await Crypto.checksum(snapshot);
    var seal = {
      id: Crypto.uuid(),
      diveId: diveId,
      diveCode: dive.code,
      sealedAt: snapshot.sealedAt,
      operator: operator || "",
      ruleVersion: Rules.RULE_VERSION,
      checksum: info.full,
      code: info.code,
      canonicalLength: info.canonical.length,
      warnings: result.warnings,
      snapshot: snapshot
    };
    this.state.seals[diveId] = seal;
    this.commit("dive.seal", { diveId: diveId, diveCode: dive.code, code: seal.code, checksum: seal.checksum });
    return seal;
  };

  Store.prototype.verifySeal = async function (diveId) {
    var seal = this.state.seals[diveId];
    if (!seal) return null;
    var ok = await Crypto.verifyChecksum(seal.snapshot, seal.checksum);
    return { seal: seal, ok: ok };
  };

  /* ---- 复查：只能追加，并带链式校验码 ---- */

  Store.prototype.addReview = function (diveId, review) {
    var v = Rules.validateReview(this.state, diveId, review);
    if (!v.ok) {
      var e = new Error("复查校验未通过：" + v.errors.map(function (x) { return x.message; }).join("；"));
      e.code = "REVIEW_INVALID"; e.issues = v.errors; throw e;
    }
    var list = this.state.reviews[diveId] || (this.state.reviews[diveId] = []);
    var entry = {
      id: Crypto.uuid(),
      at: this.now(),
      author: String(review.author).trim(),
      note: String(review.note).trim(),
      changes: (review.changes || []).map(function (c) {
        return { code: String(c.code || "").trim(), observation: String(c.observation || ""), condition: String(c.condition || ""), action: String(c.action || "") };
      }),
      prevHash: list.length ? list[list.length - 1].hash : this.state.seals[diveId].checksum,
      hash: ""
    };
    entry.hash = quickHash([entry.prevHash, entry.at, entry.author, entry.note, JSON.stringify(entry.changes)].join("|"));
    list.push(entry);
    this.commit("review.add", { diveId: diveId, reviewId: entry.id });
    return entry;
  };

  /** 复查链校验（纯函数，可针对任意状态/审计包内容）：
   * 链根为封存快照的 SHA-256，逐条 prevHash/hash 复核，任一环断裂即失败。 */
  function verifyReviewChainState(state, diveId) {
    var seal = state.seals && state.seals[diveId];
    if (!seal) return { ok: false, reason: "NOT_SEALED" };
    var list = (state.reviews && state.reviews[diveId]) || [];
    var prev = seal.checksum;
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      var expect = quickHash([prev, r.at, r.author, r.note, JSON.stringify(r.changes)].join("|"));
      if (r.prevHash !== prev || r.hash !== expect) return { ok: false, reason: "BROKEN_AT_" + i, index: i };
      prev = r.hash;
    }
    return { ok: true, count: list.length };
  }

  Store.prototype.verifyReviewChain = function (diveId) {
    return verifyReviewChainState(this.state, diveId);
  };

  /** 快照 vs 最新复查（或指定复查）差异；仅现状(condition)变化参与字段差异，
   * 观测说明(observation)作为独立的「复查观测」列出，不覆盖原标记备注。
   * 快照外编号（正常无法写入，仅见于受损数据）不合成新增标记。 */
  Store.prototype.reviewDiff = function (diveId, reviewIndex) {
    var seal = this.state.seals[diveId];
    if (!seal) return null;
    var list = this.state.reviews[diveId] || [];
    var after = JSON.parse(JSON.stringify(seal.snapshot.marks));
    var snapshotCodes = Object.create(null);
    after.forEach(function (m) { snapshotCodes[String(m.code || "").trim().toUpperCase()] = true; });
    var unknown = [];
    var observations = [];
    var upto = reviewIndex == null ? list.length : reviewIndex + 1;
    for (var i = 0; i < upto; i++) {
      (function (review, seq) {
        (review.changes || []).forEach(function (ch) {
          var key = String(ch.code || "").trim().toUpperCase();
          var m = after.find(function (x) { return x.code === ch.code; });
          if (!m) {
            if (snapshotCodes[key]) {
              // 理论不可达：快照有但 after 被异常改写
              unknown.push(ch.code);
            }
            // 快照外编号：不进入标记差异，只在观测中按原样列出（供甄别受损数据）
          } else if (ch.condition) {
            m.condition = ch.condition;
          }
          if (ch.observation) observations.push({ seq: seq + 1, code: ch.code, observation: ch.observation, action: ch.action });
        });
      })(list[i], i);
    }
    var diff = diffMarks(seal.snapshot.marks, after);
    diff.observations = observations;
    diff.unknownCodes = unknown;
    return diff;
  };

  /* ---- 还原：坏版本/坏文件不能丢数据 ---- */

  Store.prototype.restoreSnapshot = function (diveId, reason, operator) {
    var seal = this.state.seals[diveId];
    if (!seal) { var e = new Error("没有可还原的封存快照"); e.code = "NO_SNAPSHOT"; throw e; }
    // 还原前：当前全量状态先进入隔离区保底，再写一次备份
    this._quarantineCurrent("pre-restore", reason || "snapshot");
    var snap = JSON.parse(JSON.stringify(seal.snapshot));
    var diveCode = snap.dive.code;
    // 用快照重建该潜次的潜次信息与标记，其他潜次数据原样保留
    var diveIdx = this.state.dives.findIndex(function (d) { return d.id === diveId; });
    if (diveIdx >= 0) this.state.dives[diveIdx] = snap.dive;
    this.state.marks = this.state.marks.filter(function (m) { return m.dive !== diveCode; });
    snap.marks.forEach(function (m) {
      if (!m.id) m.id = Crypto.uuid();
    });
    this.state.marks = this.state.marks.concat(snap.marks);
    this.commit("dive.restore", { diveId: diveId, diveCode: diveCode, reason: reason || "", operator: operator || "", checksum: seal.checksum });
    return seal;
  };

  Store.prototype._quarantineCurrent = function (kind, reason) {
    try {
      quarantine(this.storage, kind || "pre-restore", JSON.stringify(this.state), (reason || kind || "snapshot") + " at " + this.now());
    } catch (e) { /* 隔离失败不应阻断主流程之外的数据安全：抛出 */ throw new Error("无法写入隔离区，已中止操作：" + e.message); }
  };

  /** 导入外部 JSON（坏文件/高版本只隔离不覆盖）。返回处理说明。异步：审计包需复算校验码。 */
  Store.prototype.importJson = async function (rawText) {
    var parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (e) {
      quarantine(this.storage, "import-corrupt", String(rawText), "导入文件 JSON 损坏：" + e.message);
      var err = new Error("导入文件不是合法 JSON，原文已隔离，现有数据未改动");
      err.code = "IMPORT_CORRUPT"; throw err;
    }
    if (!parsed || typeof parsed !== "object") {
      quarantine(this.storage, "import-corrupt", String(rawText), "根节点不是对象");
      var e2 = new Error("导入文件结构无法识别，原文已隔离，现有数据未改动");
      e2.code = "IMPORT_SHAPE"; throw e2;
    }

    if (parsed.package === Store.AUDIT_VERSION) {
      var audit = parseAuditPackage(parsed);
      if (!audit.ok) {
        quarantine(this.storage, "import-bad-audit", String(rawText), "审计包结构校验未通过：" + audit.errors.join("; "));
        var e3 = new Error("审计包结构不合法，已隔离，现有数据未改动");
        e3.code = "AUDIT_SHAPE"; throw e3;
      }
      var verify = await Store.verifyAuditPackage(parsed);
      if (!verify.ok) {
        quarantine(this.storage, "import-bad-audit", String(rawText), "审计包校验未通过：" + verify.errors.join("; "));
        var e4 = new Error("审计包校验码不匹配（" + verify.errors.join("；") + "），已隔离，现有数据未改动");
        e4.code = "AUDIT_MISMATCH"; throw e4;
      }
      this._quarantineCurrent("pre-import-audit", "audit package");
      this.state = normalizeState(parsed.state);
      this.commit("state.importAudit", { exportedAt: parsed.exportedAt, diveCount: (this.state.dives || []).length });
      return { kind: "audit", state: this.state };
    }

    if (parsed.version === STATE_VERSION) {
      var candidate = normalizeState(parsed);
      this._quarantineCurrent("pre-import-state", "v2 state");
      this.state = candidate;
      this.commit("state.import", {});
      return { kind: "state", state: this.state };
    }

    if (Array.isArray(parsed)) {
      // 旧版单文件导出
      var migrated;
      try { migrated = migrateV1(rawText); }
      catch (e) {
        quarantine(this.storage, "import-bad-legacy", String(rawText), e.message);
        var e4 = new Error("旧版标记文件无法迁移，已隔离：" + e.message);
        e4.code = "IMPORT_LEGACY"; throw e4;
      }
      this._quarantineCurrent("pre-import-v1", "legacy marks");
      this.state = migrated;
      this.commit("state.importV1", { marks: migrated.marks.length });
      return { kind: "v1", state: this.state };
    }

    quarantine(this.storage, "import-unknown", String(rawText), "未知版本 v" + parsed.version);
    var e5 = new Error("未知数据版本(v" + parsed.version + ")，已隔离保留，现有数据未改动");
    e5.code = "IMPORT_VERSION"; throw e5;
  };

  /* ---- 审计包导出 ---- */

  Store.prototype.exportAuditPackage = async function (operator) {
    var sealsReport = {};
    var self = this;
    await Object.keys(this.state.seals).reduce(function (p, id) {
      return p.then(async function () {
        sealsReport[id] = {
          code: self.state.seals[id].code,
          checksum: self.state.seals[id].checksum,
          ok: await Crypto.verifyChecksum(self.state.seals[id].snapshot, self.state.seals[id].checksum),
          reviewChain: self.verifyReviewChain(id).ok
        };
      });
    }, Promise.resolve());
    var pkg = {
      package: Store.AUDIT_VERSION,
      exportedAt: this.now(),
      operator: operator || "",
      state: this.state,
      sealChecks: sealsReport
    };
    var info = await Crypto.checksum({ state: this.state, exportedAt: pkg.exportedAt, operator: pkg.operator });
    pkg.checksum = info.full;
    pkg.code = info.code;
    return pkg;
  };

  function parseAuditPackage(pkg) {
    var errors = [];
    if (!pkg || pkg.package !== Store.AUDIT_VERSION) errors.push("不是审计包");
    if (!pkg.state || pkg.state.version !== STATE_VERSION) errors.push("状态版本不符");
    // 包级校验码（异步验完整载荷在 verifyAuditPackage）
    return { ok: errors.length === 0, errors: errors, pkg: pkg };
  }

  Store.verifyAuditPackage = async function (pkg) {
    var basic = parseAuditPackage(pkg);
    if (!basic.ok) return { ok: false, errors: basic.errors };
    var info = await Crypto.checksum({ state: pkg.state, exportedAt: pkg.exportedAt, operator: pkg.operator });
    if (info.full !== pkg.checksum) return { ok: false, errors: ["审计包整体校验码不匹配"] };
    var errors = [];
    var state = pkg.state;
    await Object.keys(state.seals || {}).reduce(function (p, id) {
      return p.then(async function () {
        var seal = state.seals[id];
        if (!seal) { errors.push("缺少封存记录 " + id); return; }
        var ok = await Crypto.verifyChecksum(seal.snapshot, seal.checksum);
        if (!ok) errors.push("快照校验失败 " + (seal.diveCode || id));
        // 复查哈希链：任一环断裂都拒收（重算整包校验码也无法掩盖）
        var chain = verifyReviewChainState(state, id);
        if (!chain.ok) errors.push("复查链断裂 " + (seal.diveCode || id) + "（" + chain.reason + "）");
        // 复查只能引用封存快照内的标记编号
        var codes = Object.create(null);
        (seal.snapshot && seal.snapshot.marks || []).forEach(function (m) {
          codes[String(m.code || "").trim().toUpperCase()] = true;
        });
        ((state.reviews && state.reviews[id]) || []).forEach(function (r, ri) {
          (r.changes || []).forEach(function (ch) {
            var key = String(ch.code || "").trim().toUpperCase();
            if (!codes[key]) errors.push("第 " + (ri + 1) + " 条复查引用了快照外标记 " + ch.code + "（" + (seal.diveCode || id) + "）");
          });
        });
      });
    }, Promise.resolve());
    return { ok: errors.length === 0, errors: errors };
  };

  Store.prototype.getQuarantine = function () {
    try { return JSON.parse(this.storage.getItem(KEYS.quarantine) || "[]"); }
    catch (e) { return []; }
  };

  /* 复查链轻量哈希（FNV-1a 32 位，仅用于检测本地追加记录被改写；
   * 封存快照的防篡改以 SHA-256 校验码为准）。 */
  function quickHash(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }

  return Store;
});
