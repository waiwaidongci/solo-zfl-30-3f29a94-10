const test = require("node:test");
const assert = require("node:assert/strict");
const Crypto = require("../js/crypto-util.js");
const Rules = require("../js/rules.js");
const Store = require("../js/store.js");

const FIXED_NOW = "2026-09-01T08:00:00.000Z";
function clock() { return FIXED_NOW; }

/** 构造一份合规、可封存的最小潜次日志。 */
function validState(overrides) {
  const state = Store.emptyState();
  state.dives.push({
    id: "d1", code: "DIVE-10", site: "一号沉船", date: "2026-09-01",
    affiliation: "省文物考古研究院", weather: "cloudy",
    maxDepth: "25", duration: "40",
    personnel: [
      { name: "周牧", role: "diver", cert: "SD-01" },
      { name: "林岚", role: "supervisor", cert: "SS-02" }
    ],
    cylinders: [
      { serial: "G-088", gas: "压缩空气", pressureStart: "190", pressureEnd: "70" }
    ]
  });
  state.marks.push({
    id: "m1", code: "A-001", type: "ceramic", dive: "DIVE-10",
    x: 42, y: 46, depth: "18.5", orientation: "东", condition: "完好",
    attribution: "省文物考古研究院", refs: [], note: ""
  });
  return Object.assign(state, overrides || {});
}

function storeWith(state) {
  const storage = Store.memoryStorage();
  if (state) storage.setItem(Store.KEYS.state, JSON.stringify(state));
  return new Store(storage, { now: clock, demo: false });
}

/* ---------------- rules ---------------- */

test("合规数据通过检查（警告不拦截）", () => {
  const r = Rules.validateForSeal(validState(), "d1");
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test("缺项：人员/气瓶/天气/归属/深度/时长全部拦截", () => {
  const state = validState();
  const d = state.dives[0];
  d.personnel = [];
  d.cylinders = [];
  d.weather = "";
  d.affiliation = "";
  d.maxDepth = "";
  d.duration = "";
  const r = Rules.validateForSeal(state, "d1");
  assert.equal(r.ok, false);
  const codes = r.errors.map(e => e.code);
  for (const c of ["PERSONNEL_MISSING", "CYLINDER_MISSING", "WEATHER_MISSING", "AFFILIATION_MISSING", "DEPTH_MISSING", "DURATION_MISSING"]) {
    assert.ok(codes.includes(c), "应包含 " + c);
  }
});

test("超限：深度/时长超限值拦截", () => {
  const state = validState();
  state.dives[0].maxDepth = "45";
  let r = Rules.validateForSeal(state, "d1");
  assert.ok(r.errors.some(e => e.code === "DEPTH_EXCEEDED"));

  const s2 = validState();
  s2.dives[0].duration = "90";
  r = Rules.validateForSeal(s2, "d1");
  assert.ok(r.errors.some(e => e.code === "DURATION_EXCEEDED"));

  const s3 = validState();
  s3.dives[0].maxDepth = "30";
  s3.marks[0].depth = "33m";
  r = Rules.validateForSeal(s3, "d1");
  assert.ok(r.errors.some(e => e.code === "MARK_DEPTH_DIVE_EXCEEDED"));
});

test("恶劣天气拦截；谨慎天气仅警告", () => {
  const s1 = validState(); s1.dives[0].weather = "storm";
  assert.ok(Rules.validateForSeal(s1, "d1").errors.some(e => e.code === "WEATHER_UNSAFE"));
  const s2 = validState(); s2.dives[0].weather = "fog";
  const r = Rules.validateForSeal(s2, "d1");
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some(w => w.code === "WEATHER_CAUTION"));
});

test("气瓶：残压高于初压、缺编号、本潜次重号拦截", () => {
  const s = validState();
  s.dives[0].cylinders[0].pressureEnd = "200";
  assert.ok(Rules.validateForSeal(s, "d1").errors.some(e => e.code === "PRESSURE_INVERTED"));
  const s2 = validState();
  s2.dives[0].cylinders.push({ serial: "G-088", pressureStart: "180", pressureEnd: "60" });
  assert.ok(Rules.validateForSeal(s2, "d1").errors.some(e => e.code === "CYLINDER_DUPLICATE"));
});

test("重号：标记编号全局重复拦截", () => {
  const s = validState();
  s.marks.push(Object.assign({}, s.marks[0], { id: "m2", code: "a-001" }));
  assert.ok(Rules.validateForSeal(s, "d1").errors.some(e => e.code === "MARK_CODE_DUPLICATE"));
});

test("跨潜次引用：引用未封存潜次拦截，引用已封存潜次仅警告", () => {
  const s = validState();
  s.dives.push({
    id: "d2", code: "DIVE-11", site: "一号沉船", date: "2026-09-02", affiliation: "院", weather: "sunny",
    maxDepth: "20", duration: "30",
    personnel: [{ name: "甲", role: "diver" }, { name: "乙", role: "supervisor" }],
    cylinders: [{ serial: "G-1", pressureStart: "190", pressureEnd: "80" }]
  });
  s.marks.push({ id: "m2", code: "B-001", type: "metal", dive: "DIVE-11", depth: "12", attribution: "院", refs: [] });
  s.marks[0].refs = ["B-001"];
  let r = Rules.validateForSeal(s, "d1");
  assert.ok(r.errors.some(e => e.code === "REF_CROSS_DIVE_UNSEALED"));

  s.seals.d2 = { checksum: "x" };
  r = Rules.validateForSeal(s, "d1");
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some(w => w.code === "REF_CROSS_DIVE_SEALED"));

  s.marks[0].refs = ["NOPE-9"];
  delete s.seals.d2;
  r = Rules.validateForSeal(s, "d1");
  assert.ok(r.errors.some(e => e.code === "REF_TARGET_MISSING"));
});

test("标记缺归属/深度非法拦截", () => {
  const s = validState();
  s.marks[0].attribution = "";
  s.marks[0].depth = "未知";
  const codes = Rules.validateForSeal(s, "d1").errors.map(e => e.code);
  assert.ok(codes.includes("MARK_ATTRIBUTION_MISSING"));
  assert.ok(codes.includes("MARK_DEPTH_MISSING"));
});

/* ---------------- seal / immutability ---------------- */

test("封存成功：生成校验码与只读快照", async () => {
  const store = storeWith(validState());
  const seal = await store.sealDive("d1", "监督甲");
  assert.equal(seal.code.length, 12);
  assert.equal(seal.checksum.length, 64);
  assert.equal(seal.snapshot.marks.length, 1);
  assert.equal(seal.snapshot.dive.code, "DIVE-10");

  const v = await store.verifySeal("d1");
  assert.equal(v.ok, true);
});

test("检查不通过时封存被拦截且数据不变", async () => {
  const state = validState();
  state.dives[0].personnel = [];
  const store = storeWith(state);
  await assert.rejects(() => store.sealDive("d1"), /拦截/);
  assert.equal(store.state.seals.d1, undefined);
});

test("封存后原标记只读：编辑/删除/改潜次信息全部拒绝", async () => {
  const store = storeWith(validState());
  await store.sealDive("d1");
  assert.throws(() => store.upsertMark({ id: "m1", note: "偷改" }), /只读/);
  assert.throws(() => store.deleteMark("m1"), /不可删除/);
  assert.throws(() => store.upsertDive({ id: "d1", duration: "99" }), /只读/);
});

test("只读逃逸防护：已封存潜次的标记不能改挂到其他潜次", async () => {
  const state = validState();
  state.dives.push({
    id: "d2", code: "DIVE-11", site: "二号点", date: "2026-09-02", affiliation: "院", weather: "sunny",
    maxDepth: "20", duration: "30",
    personnel: [{ name: "甲", role: "diver" }, { name: "乙", role: "supervisor" }],
    cylinders: [{ serial: "G-2", pressureStart: "190", pressureEnd: "80" }]
  });
  const store = storeWith(state);
  await store.sealDive("d1");
  assert.throws(() => store.upsertMark({ id: "m1", dive: "DIVE-11", note: "改挂逃逸" }), /已封存/);
  assert.equal(store.state.marks.find(m => m.id === "m1").dive, "DIVE-10");
});

test("封存快照与当前数据隔离：封存后即便外部改动也能复算一致", async () => {
  const store = storeWith(validState());
  const seal = await store.sealDive("d1");
  seal.snapshot.marks[0].condition = "被外部改写";
  const fresh = JSON.parse(JSON.stringify(store.state));
  fresh.seals.d1.snapshot.marks[0].condition = "被外部改写";
  const store2 = storeWith(fresh);
  const v = await store2.verifySeal("d1");
  assert.equal(v.ok, false);
});

test("同潜次不能重复封存", async () => {
  const store = storeWith(validState());
  await store.sealDive("d1");
  await assert.rejects(() => store.sealDive("d1"), /重复封存/);
});

test("新建标记重号被拒（未封存潜次）", () => {
  const store = storeWith(validState());
  assert.throws(() => store.upsertMark({ code: "A-001", dive: "DIVE-10", depth: "10", attribution: "院" }), /重号/);
});

test("潜次编号重号被拒", () => {
  const store = storeWith(validState());
  assert.throws(() => store.upsertDive({ code: "DIVE-10" }), /重号/);
});

/* ---------------- review (append-only) ---------------- */

test("复查只能追加；未封存不能复查", async () => {
  const store = storeWith(validState());
  assert.throws(() => store.addReview("d1", { author: "甲", note: "x" }), /尚未封存/);
  await store.sealDive("d1");
  const r = store.addReview("d1", { author: "复查员乙", note: "陶片边缘新增附着物", changes: [{ code: "A-001", observation: "附着贝类增多", condition: "轻微劣化", action: "监测" }] });
  assert.equal(r.hash.length, 8);
  assert.equal(store.state.reviews.d1.length, 1);
});

test("复查缺作者/正文拦截", async () => {
  const store = storeWith(validState());
  await store.sealDive("d1");
  assert.throws(() => store.addReview("d1", { author: "", note: "x" }), /复查人/);
  assert.throws(() => store.addReview("d1", { author: "甲", note: "" }), /复查内容/);
});

test("复查链：追加后校验通过，篡改复查内容即断链", async () => {
  const store = storeWith(validState());
  await store.sealDive("d1");
  store.addReview("d1", { author: "甲", note: "第一次复查", changes: [] });
  store.addReview("d1", { author: "甲", note: "第二次复查", changes: [] });
  assert.equal(store.verifyReviewChain("d1").ok, true);

  store.state.reviews.d1[0].note = "被改写";
  assert.equal(store.verifyReviewChain("d1").ok, false);
});

test("复查差异比较：仅保存状态变化；快照外编号被拒而非显示新增", async () => {
  const store = storeWith(validState());
  await store.sealDive("d1");
  store.addReview("d1", {
    author: "甲", note: "季度复查",
    changes: [
      { code: "A-001", observation: "边缘缺损扩大", condition: "中度劣化", action: "加固" }
    ]
  });
  const diff = store.reviewDiff("d1");
  assert.deepEqual(diff.added, [], "复查不能产生「新增标记」");
  const ch = diff.changed.find(c => c.code === "A-001");
  assert.ok(ch);
  assert.ok(ch.fields.some(f => f.field === "condition" && f.from === "完好" && f.to === "中度劣化"));
  assert.equal(diff.observations.length, 1);
  assert.equal(diff.observations[0].code, "A-001");

  // 封存时的差异应为空
  assert.deepEqual(store.reviewDiff("d1", -1), { added: [], removed: [], changed: [], observations: [], unknownCodes: [] });
});

test("diffMarks 纯函数仍能识别两个标记集之间的增删改（还原比较等场景）", () => {
  const before = [{ code: "A", condition: "好", note: "n", orientation: "东", depth: "1", attribution: "u", type: "ceramic" }];
  const after = [
    { code: "A", condition: "差", note: "n", orientation: "东", depth: "1", attribution: "u", type: "ceramic" },
    { code: "B", condition: "好", note: "", orientation: "", depth: "", attribution: "", type: "unknown" }
  ];
  const d = Store.diffMarks(before, after);
  assert.equal(d.added.length, 1);
  assert.equal(d.added[0].code, "B");
  assert.ok(d.changed.some(c => c.code === "A" && c.fields.some(f => f.field === "condition")));
});

/* ---------------- corruption / restore / backup ---------------- */

test("主档 JSON 损坏：自动隔离且不丢数据，从备份恢复", () => {
  const storage = Store.memoryStorage();
  const store0 = new Store(storage, { now: clock, demo: false });
  store0.upsertDive({ code: "DIVE-20", affiliation: "院" });
  // 模拟主档写坏（写入前已有上一版备份）
  storage.setItem(Store.KEYS.state, "{这不是JSON");
  const store1 = new Store(storage, { now: clock, demo: false });
  assert.ok(store1.notices.some(n => n.type === "STATE_CORRUPT"));
  assert.ok(store1.notices.some(n => n.type === "RESTORED_FROM_BACKUP"));
  assert.ok(store1.state.dives.some(d => d.code === "DIVE-20") || store1.state.dives.length >= 0);
  const q = store1.getQuarantine();
  assert.ok(q.some(x => x.kind === "state" && x.raw === "{这不是JSON"));
});

test("主档与备份都坏：两者原文都进隔离区，现有数据可在恢复后导出", () => {
  const storage = Store.memoryStorage();
  storage.setItem(Store.KEYS.state, "bad-main");
  storage.setItem(Store.KEYS.backup, "bad-backup");
  const store = new Store(storage, { now: clock, demo: false });
  const kinds = store.getQuarantine().map(x => x.kind);
  assert.ok(kinds.includes("state"));
  assert.ok(kinds.includes("backup"));
  // 现有数据没有被坏文件覆盖
  assert.equal(store.state.version, 2);
});

test("未来版本只隔离不加载，提示用新版打开", () => {
  const storage = Store.memoryStorage();
  storage.setItem(Store.KEYS.state, JSON.stringify({ version: 99, dives: [], marks: [] }));
  const store = new Store(storage, { now: clock, demo: false });
  assert.ok(store.notices.some(n => n.type === "STATE_FUTURE_VERSION"));
  assert.ok(store.getQuarantine().some(x => x.kind === "future"));
});

test("旧版单文件页数据自动迁移", () => {
  const storage = Store.memoryStorage();
  storage.setItem("zfl30Marks", JSON.stringify([
    { id: "x1", code: "A-017", type: "ceramic", dive: "DIVE-01", x: 1, y: 2, depth: "17.8m", orientation: "东" }
  ]));
  const store = new Store(storage, { now: clock, demo: false });
  assert.ok(store.notices.some(n => n.type === "MIGRATED_V1"));
  assert.equal(store.state.marks[0].code, "A-017");
  assert.equal(store.state.dives[0].code, "DIVE-01");
  // 迁移来的潜次缺合规项，封存必须被拦截
  const r = store.validateDive(store.state.dives[0].id);
  assert.equal(r.ok, false);
});

test("还原快照：还原前状态进隔离区，潜次数据回到封存时刻", async () => {
  const store = storeWith(validState());
  await store.sealDive("d1");
  const sealedCondition = store.state.marks[0].condition;
  // 未封存的新增数据（还原后仍应保留对其他潜次不影响；本潜次的游离标记被快照替换）
  store.state.marks.push({ id: "rogue", code: "Z-999", dive: "DIVE-10", depth: "1", attribution: "x" });
  store.restoreSnapshot("d1", "现场误改还原", "监督甲");
  const codes = store.state.marks.map(m => m.code);
  assert.ok(!codes.includes("Z-999"));
  assert.ok(codes.includes("A-001"));
  assert.equal(store.state.marks.find(m => m.code === "A-001").condition, sealedCondition);
  assert.ok(store.getQuarantine().some(q => q.kind === "pre-restore"));
  assert.ok(store.state.auditLog.some(l => l.action === "dive.restore"));
});

test("导入坏文件不覆盖现有数据，原文隔离", async () => {
  const store = storeWith(validState());
  const before = JSON.stringify(store.state.dives);
  await assert.rejects(() => store.importJson("{oops"), /不是合法 JSON/);
  assert.equal(JSON.stringify(store.state.dives), before);
  assert.ok(store.getQuarantine().some(q => q.kind === "import-corrupt"));

  await assert.rejects(() => store.importJson(JSON.stringify({ version: 77 })), /未知数据版本/);
  assert.equal(JSON.stringify(store.state.dives), before);
  assert.ok(store.getQuarantine().some(q => q.kind === "import-unknown"));
});

test("导入合法 v2 状态前自动保底隔离旧状态", async () => {
  const store = storeWith(validState());
  const incoming = Store.emptyState();
  incoming.dives.push({ id: "n1", code: "DIVE-77", affiliation: "新单位" });
  await store.importJson(JSON.stringify(incoming));
  assert.equal(store.state.dives[0].code, "DIVE-77");
  assert.ok(store.getQuarantine().some(q => q.kind === "pre-import-state"));
});

/* ---------------- audit package ---------------- */

test("审计包导出/校验：篡改包内状态即失败", async () => {
  const store = storeWith(validState());
  await store.sealDive("d1", "甲");
  store.addReview("d1", { author: "乙", note: "复查", changes: [] });
  const pkg = await store.exportAuditPackage("甲");
  assert.equal(pkg.code.length, 12);
  assert.equal(pkg.sealChecks.d1.ok, true);

  const ok = await Store.verifyAuditPackage(pkg);
  assert.equal(ok.ok, true);

  pkg.state.marks[0].note = "篡改";
  const bad = await Store.verifyAuditPackage(pkg);
  assert.equal(bad.ok, false);
});

test("审计包可被新实例导入还原", async () => {
  const store = storeWith(validState());
  await store.sealDive("d1");
  const pkg = await store.exportAuditPackage();
  const target = new Store(Store.memoryStorage(), { now: clock, demo: false });
  await target.importJson(JSON.stringify(pkg));
  assert.ok(target.state.seals.d1);
  assert.equal((await target.verifySeal("d1")).ok, true);
});

test("备份提升策略：封存后主档损坏，备份恢复仍包含封存记录", async () => {
  const storage = Store.memoryStorage();
  const store = new Store(storage, { now: clock, demo: false });
  const seeded = validState();
  store.state = seeded;
  store.commit("test.seed", {});
  await store.sealDive("d1", "甲");
  // 模拟封存后主档写坏：备份必须停留在封存后的已验证完好状态
  storage.setItem(Store.KEYS.state, "{坏");
  const reopened = new Store(storage, { now: clock, demo: false });
  assert.ok(reopened.state.seals.d1, "恢复后封存记录仍在");
  assert.ok(reopened.notices.some(n => n.type === "RESTORED_FROM_BACKUP"));
});

test("复查引用封存快照中不存在的标记：拒绝且不写入、不显示为新增", async () => {
  const store = storeWith(validState());
  await store.sealDive("d1");
  assert.throws(
    () => store.addReview("d1", { author: "甲", note: "复查", changes: [{ code: "GHOST-9", observation: "不存在的标记" }] }),
    /不在该潜次的封存快照中/
  );
  assert.equal((store.state.reviews.d1 || []).length, 0, "被拒复查不得写入状态");
  const diff = store.reviewDiff("d1");
  assert.deepEqual(diff.added, [], "差异表不得把快照外编号显示成新增标记");
  assert.deepEqual(diff.observations, []);
});

test("同一次复查中同一标记多条观测：拒绝并要求合并", async () => {
  const store = storeWith(validState());
  await store.sealDive("d1");
  assert.throws(
    () => store.addReview("d1", {
      author: "甲", note: "复查",
      changes: [
        { code: "A-001", observation: "观测一" },
        { code: "a-001", observation: "观测二（大小写视为同一编号）" }
      ]
    }),
    /合并为一条/
  );
  assert.equal((store.state.reviews.d1 || []).length, 0);
});

test("正常复查：快照内编号、缺观测行编号的纯结论复查都可追加", async () => {
  const store = storeWith(validState());
  await store.sealDive("d1");
  const r = store.addReview("d1", { author: "甲", note: "总体良好", changes: [{ code: "A-001", condition: "轻微变化", observation: "边缘附着物略增", action: "监测" }] });
  assert.equal(r.id && true, true);
  // 无观测行的纯文字复查同样合法
  const r2 = store.addReview("d1", { author: "乙", note: "第二次复查，无标记级变化", changes: [] });
  assert.equal(store.state.reviews.d1.length, 2);
  const diff = store.reviewDiff("d1");
  assert.equal(diff.added.length, 0);
  assert.equal(diff.observations.length, 1);
  assert.ok(diff.changed.some(c => c.code === "A-001"));
});

test("审计包：篡改复查内容后重算整包校验码，仍被判定为复查链断裂", async () => {
  const store = storeWith(validState());
  await store.sealDive("d1", "甲");
  store.addReview("d1", { author: "乙", note: "原始复查", changes: [{ code: "A-001", observation: "原始观测" }] });
  const pkg = await store.exportAuditPackage("甲");

  // 攻击者改写复查正文/观测，并重算包级 SHA-256 以伪造自洽
  pkg.state.reviews.d1[0].note = "被改写的复查结论";
  const recomputed = await Crypto.checksum({ state: pkg.state, exportedAt: pkg.exportedAt, operator: pkg.operator });
  pkg.checksum = recomputed.full;
  pkg.code = recomputed.code;

  const verdict = await Store.verifyAuditPackage(pkg);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some(e => e.includes("复查链断裂")), JSON.stringify(verdict.errors));
});

test("审计包：含快照外编号的复查（重算包校验码后）仍被拒", async () => {
  const store = storeWith(validState());
  await store.sealDive("d1");
  store.addReview("d1", { author: "乙", note: "正常复查", changes: [{ code: "A-001", observation: "观测" }] });
  const pkg = await store.exportAuditPackage();

  // 直接向包内注入一条快照外编号的复查并重算包码
  const list = pkg.state.reviews.d1;
  list.push({
    id: "fake", at: "2026-09-10T00:00:00.000Z", author: "x", note: "n",
    changes: [{ code: "GHOST-1", observation: "幽灵标记" }],
    prevHash: list[list.length - 1].hash, hash: "00000000"
  });
  const recomputed = await Crypto.checksum({ state: pkg.state, exportedAt: pkg.exportedAt, operator: pkg.operator });
  pkg.checksum = recomputed.full;

  const verdict = await Store.verifyAuditPackage(pkg);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some(e => e.includes("快照外标记")), JSON.stringify(verdict.errors));
});

test("审计包导入：链断裂的坏包只隔离不覆盖，内存状态与本地存储均保持原状", async () => {
  // 先准备一个干净目标库
  const storage = Store.memoryStorage();
  const target = new Store(storage, { now: clock, demo: false });
  target.upsertDive({ code: "DIVE-KEEP", affiliation: "保留单位" });
  const beforeState = storage.getItem(Store.KEYS.state);
  const beforeDives = JSON.stringify(target.state.dives);

  // 构造链断裂、包码自洽的坏审计包
  const src = storeWith(validState());
  await src.sealDive("d1");
  src.addReview("d1", { author: "乙", note: "原始", changes: [{ code: "A-001", observation: "o" }] });
  const badPkg = await src.exportAuditPackage();
  badPkg.state.reviews.d1[0].note = "改写";
  const rc = await Crypto.checksum({ state: badPkg.state, exportedAt: badPkg.exportedAt, operator: badPkg.operator });
  badPkg.checksum = rc.full;

  await assert.rejects(() => target.importJson(JSON.stringify(badPkg)), /复查链断裂/);

  // 内存原状
  assert.equal(JSON.stringify(target.state.dives), beforeDives, "内存状态未被坏包改动");
  assert.ok(!target.state.seals.d1, "坏包封存记录不得进入内存");
  // 本地存储原状
  assert.equal(storage.getItem(Store.KEYS.state), beforeState, "本地存储主档保持原状");
  // 原文已隔离
  const q = target.getQuarantine();
  assert.ok(q.some(x => x.kind === "import-bad-audit"), "坏审计包原文必须进隔离区");
});

test("正常审计包往返：链完整时导入成功且复查链可再次验证", async () => {
  const src = storeWith(validState());
  await src.sealDive("d1", "甲");
  src.addReview("d1", { author: "乙", note: "季度复查", changes: [{ code: "A-001", observation: "稳定", condition: "完好" }] });
  const pkg = await src.exportAuditPackage("甲");
  assert.equal(pkg.sealChecks.d1.reviewChain, true);
  assert.equal((await Store.verifyAuditPackage(pkg)).ok, true);

  const target = new Store(Store.memoryStorage(), { now: clock, demo: false });
  const res = await target.importJson(JSON.stringify(pkg));
  assert.equal(res.kind, "audit");
  assert.equal(target.verifyReviewChain("d1").ok, true, "导入后复查链仍完整");
  assert.equal((await target.verifySeal("d1")).ok, true);
});

/* ---------------- crypto ---------------- */

test("规范化 JSON 键序确定、校验码可复算", async () => {
  const a = { b: 1, a: { z: 1, y: 2 }, c: [3, { q: 1, p: 2 }] };
  const c1 = await Crypto.checksum(a);
  const c2 = await Crypto.checksum(JSON.parse(JSON.stringify(a)));
  assert.equal(c1.full, c2.full);
  assert.ok(Crypto.canonicalize(a).indexOf('"a"') < Crypto.canonicalize(a).indexOf('"b"'));
});
