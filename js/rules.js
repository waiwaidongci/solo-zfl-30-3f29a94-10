/* 合规规则（纯函数，无副作用，Node / 浏览器通用，UMD）。
 * 封存前检查：人员、气瓶、深度、时长、天气、归属、缺项、超限、跨潜次引用、重号。 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DiveRules = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var RULE_VERSION = "rules-v1";
  var DEFAULT_LIMITS = { maxDepth: 40, maxDuration: 60 }; // 米 / 分钟

  var PERSON_ROLES = [
    { value: "diver", label: "潜水员" },
    { value: "tender", label: "信号员/照料员" },
    { value: "supervisor", label: "潜水监督" },
    { value: "recorder", label: "记录员" }
  ];

  // 安全：放行；caution：警告但不拦截；unsafe：拦截封存
  var WEATHER = {
    sunny: { label: "晴", level: "safe" },
    cloudy: { label: "多云", level: "safe" },
    overcast: { label: "阴", level: "safe" },
    fog: { label: "雾", level: "caution" },
    rain: { label: "小雨", level: "caution" },
    "heavy-rain": { label: "大雨", level: "unsafe" },
    storm: { label: "暴风雨/雷暴", level: "unsafe" },
    gale: { label: "大风(≥6级)", level: "unsafe" },
    typhoon: { label: "台风", level: "unsafe" }
  };

  function issue(level, code, message, target) {
    return { level: level, code: code, message: message, target: target || null };
  }

  /** 从 "18.4m" / 18.4 / "18.4 m" 解析数值，无法解析返回 NaN。 */
  function parseNumber(value) {
    if (typeof value === "number") return value;
    if (value === null || value === undefined) return NaN;
    var m = String(value).trim().match(/-?\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : NaN;
  }

  function nonEmpty(v) {
    return v !== null && v !== undefined && String(v).trim() !== "";
  }

  /** 全局重号检查：同一标记编号在日志中出现多次。 */
  function findDuplicateCodes(marks) {
    var seen = Object.create(null);
    var dupes = Object.create(null);
    marks.forEach(function (m) {
      if (!nonEmpty(m.code)) return;
      var key = String(m.code).trim().toUpperCase();
      if (seen[key]) dupes[key] = true;
      seen[key] = true;
    });
    return dupes;
  }

  /**
   * 封存前合规检查。
   * @param {object} state 完整日志状态
   * @param {string} diveId 待封存潜次
   * @param {object} [limits] { maxDepth, maxDuration }
   * @returns {{ok:boolean, errors:Array, warnings:Array}}
   */
  function validateForSeal(state, diveId, limits) {
    limits = Object.assign({}, DEFAULT_LIMITS, limits || {});
    var errors = [];
    var warnings = [];
    var dive = (state.dives || []).find(function (d) { return d.id === diveId; });
    if (!dive) {
      return { ok: false, errors: [issue("error", "DIVE_NOT_FOUND", "潜次不存在")], warnings: [] };
    }
    var marks = (state.marks || []).filter(function (m) { return m.dive === dive.code; });
    var sealedDiveCodes = {};
    (state.dives || []).forEach(function (d) {
      if (state.seals[d.id]) sealedDiveCodes[d.code] = true;
    });
    var dupes = findDuplicateCodes(state.marks || []);

    function err(code, message, target) { errors.push(issue("error", code, message, target)); }
    function warn(code, message, target) { warnings.push(issue("warning", code, message, target)); }

    // —— 基本项 / 归属 ——
    if (!nonEmpty(dive.code)) err("DIVE_CODE_MISSING", "潜次编号缺失");
    if (!nonEmpty(dive.site)) err("SITE_MISSING", "作业地点缺失", "dive");
    if (!nonEmpty(dive.date)) err("DATE_MISSING", "作业日期缺失", "dive");
    if (!nonEmpty(dive.affiliation)) err("AFFILIATION_MISSING", "归属单位/项目缺失", "dive");

    // —— 天气 ——
    if (!nonEmpty(dive.weather)) {
      err("WEATHER_MISSING", "天气情况缺失", "dive");
    } else if (!WEATHER[dive.weather]) {
      err("WEATHER_UNKNOWN", "天气取值不在标准字典内：" + dive.weather, "dive");
    } else if (WEATHER[dive.weather].level === "unsafe") {
      err("WEATHER_UNSAFE", "天气状况不允许作业：" + WEATHER[dive.weather].label, "dive");
    } else if (WEATHER[dive.weather].level === "caution") {
      warn("WEATHER_CAUTION", "天气需谨慎作业：" + WEATHER[dive.weather].label, "dive");
    }

    // —— 人员 ——
    var people = dive.personnel || [];
    if (!people.length) {
      err("PERSONNEL_MISSING", "至少登记一名潜水人员", "personnel");
    }
    var hasDiver = false, hasSupervisor = false, nameSeen = Object.create(null);
    people.forEach(function (p, i) {
      var t = "personnel[" + i + "]";
      if (!nonEmpty(p.name)) err("PERSON_NAME_MISSING", "第" + (i + 1) + "名人员姓名缺失", t);
      else if (nameSeen[p.name.trim()]) warn("PERSON_DUPLICATE", "人员重复登记：" + p.name, t);
      nameSeen[p.name && p.name.trim()] = true;
      if (!nonEmpty(p.role)) err("PERSON_ROLE_MISSING", (p.name || "第" + (i + 1) + "名人员") + "的岗位缺失", t);
      if (p.role === "diver") hasDiver = true;
      if (p.role === "supervisor") hasSupervisor = true;
    });
    if (people.length && !hasDiver) err("PERSON_NO_DIVER", "名单中没有潜水员", "personnel");
    if (people.length && !hasSupervisor) warn("PERSON_NO_SUPERVISOR", "名单中没有潜水监督", "personnel");

    // —— 气瓶 ——
    var cylinders = dive.cylinders || [];
    if (!cylinders.length) {
      err("CYLINDER_MISSING", "至少登记一只气瓶", "cylinders");
    }
    var serialSeen = Object.create(null);
    cylinders.forEach(function (c, i) {
      var t = "cylinders[" + i + "]";
      if (!nonEmpty(c.serial)) err("CYLINDER_SERIAL_MISSING", "第" + (i + 1) + "只气瓶编号缺失", t);
      else {
        var key = String(c.serial).trim().toUpperCase();
        if (serialSeen[key]) err("CYLINDER_DUPLICATE", "气瓶编号在本潜次重号：" + c.serial, t);
        serialSeen[key] = true;
      }
      var start = parseNumber(c.pressureStart);
      var end = parseNumber(c.pressureEnd);
      if (!nonEmpty(c.pressureStart) || isNaN(start)) err("PRESSURE_START_MISSING", "气瓶 " + (c.serial || i + 1) + " 初压缺失或非法", t);
      if (!nonEmpty(c.pressureEnd) || isNaN(end)) err("PRESSURE_END_MISSING", "气瓶 " + (c.serial || i + 1) + " 残压缺失或非法", t);
      if (!isNaN(start) && !isNaN(end) && end > start) err("PRESSURE_INVERTED", "气瓶 " + (c.serial || i + 1) + " 残压高于初压", t);
    });

    // —— 深度 / 时长（超限拦截）——
    var maxDepth = parseNumber(dive.maxDepth);
    if (!nonEmpty(dive.maxDepth) || isNaN(maxDepth)) err("DEPTH_MISSING", "最大深度缺失或非法", "dive");
    else {
      if (maxDepth > limits.maxDepth) err("DEPTH_EXCEEDED", "最大深度 " + maxDepth + "m 超过限值 " + limits.maxDepth + "m", "dive");
      if (maxDepth <= 0) err("DEPTH_INVALID", "最大深度必须为正数", "dive");
    }
    var duration = parseNumber(dive.duration);
    if (!nonEmpty(dive.duration) || isNaN(duration)) err("DURATION_MISSING", "水下时长缺失或非法", "dive");
    else {
      if (duration > limits.maxDuration) err("DURATION_EXCEEDED", "水下时长 " + duration + " 分钟超过限值 " + limits.maxDuration + " 分钟", "dive");
      if (duration <= 0) err("DURATION_INVALID", "水下时长必须为正数", "dive");
    }

    // —— 标记：归属、重号、深度一致性、跨潜次引用 ——
    var codeIndex = {};
    (state.marks || []).forEach(function (m) { codeIndex[String(m.code || "").trim().toUpperCase()] = m; });
    if (!marks.length) warn("NO_MARKS", "该潜次没有任何考古标记", "marks");
    marks.forEach(function (m, i) {
      var t = "marks[" + i + "]";
      if (!nonEmpty(m.code)) err("MARK_CODE_MISSING", "存在未编号的标记", t);
      if (dupes[String(m.code || "").trim().toUpperCase()]) err("MARK_CODE_DUPLICATE", "标记编号重号：" + m.code, t);
      if (!nonEmpty(m.attribution)) err("MARK_ATTRIBUTION_MISSING", "标记 " + (m.code || i + 1) + " 缺少归属", t);
      var md = parseNumber(m.depth);
      if (!nonEmpty(m.depth) || isNaN(md)) err("MARK_DEPTH_MISSING", "标记 " + (m.code || i + 1) + " 深度缺失或非法", t);
      else if (!isNaN(maxDepth) && md > maxDepth + 0.001) {
        err("MARK_DEPTH_DIVE_EXCEEDED", "标记 " + m.code + " 深度 " + md + "m 超过本潜次最大深度 " + maxDepth + "m", t);
      } else if (md > limits.maxDepth) {
        err("MARK_DEPTH_EXCEEDED", "标记 " + m.code + " 深度 " + md + "m 超过限值 " + limits.maxDepth + "m", t);
      }
      (m.refs || []).forEach(function (ref) {
        if (!nonEmpty(ref)) return;
        var key = String(ref).trim().toUpperCase();
        var target = codeIndex[key];
        if (!target) {
          err("REF_TARGET_MISSING", "标记 " + m.code + " 引用了不存在的编号 " + ref, t);
        } else if (target.dive !== dive.code) {
          if (!sealedDiveCodes[target.dive]) {
            err("REF_CROSS_DIVE_UNSEALED", "标记 " + m.code + " 跨潜次引用 " + ref + "（属于 " + target.dive + "，该潜次尚未封存）", t);
          } else {
            warn("REF_CROSS_DIVE_SEALED", "标记 " + m.code + " 引用了已封存潜次 " + target.dive + " 的 " + ref, t);
          }
        }
      });
    });

    return { ok: errors.length === 0, errors: errors, warnings: warnings };
  }

  /** 追加复查前的轻量校验：复查必须有作者与正文，且只能针对已封存潜次。 */
  function validateReview(state, diveId, review) {
    var errors = [];
    if (!state.seals[diveId]) errors.push(issue("error", "NOT_SEALED", "潜次尚未封存，不能追加复查"));
    if (!review || !nonEmpty(review.author)) errors.push(issue("error", "REVIEW_AUTHOR_MISSING", "复查人缺失"));
    if (!review || !nonEmpty(review.note)) errors.push(issue("error", "REVIEW_NOTE_MISSING", "复查内容缺失"));
    if (review && Array.isArray(review.changes)) {
      review.changes.forEach(function (ch, i) {
        if (!nonEmpty(ch.code)) errors.push(issue("error", "REVIEW_CHANGE_CODE_MISSING", "第" + (i + 1) + "条复查记录缺少标记编号"));
        if (!nonEmpty(ch.observation)) errors.push(issue("error", "REVIEW_CHANGE_OBS_MISSING", "复查记录 " + (ch.code || i + 1) + " 缺少观测说明"));
      });
    }
    return { ok: errors.length === 0, errors: errors };
  }

  return {
    RULE_VERSION: RULE_VERSION,
    DEFAULT_LIMITS: DEFAULT_LIMITS,
    PERSON_ROLES: PERSON_ROLES,
    WEATHER: WEATHER,
    parseNumber: parseNumber,
    nonEmpty: nonEmpty,
    findDuplicateCodes: findDuplicateCodes,
    validateForSeal: validateForSeal,
    validateReview: validateReview
  };
});
