/* 真实浏览器端到端检查（Playwright Chromium，桌面 + 手机视口）。
 * 运行：npm run browser-test （需先 npx playwright install chromium）
 * 产出：docs/screenshots/*.png、docs/artifacts/*.json 与 docs/.browser-check-results.json */
const { chromium } = require("playwright");
const http = require("node:http");
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const Store = require("../js/store.js");

// 无 root 环境：把 tools/sysroot 下所有含 .so 的目录注入子进程库搜索路径
(function injectSysroot() {
  const sysroot = path.join(__dirname, "..", "tools", "sysroot");
  if (!fs.existsSync(sysroot)) return;
  const dirs = [];
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    let hasSo = false;
    for (const ent of entries) {
      if (ent.isDirectory()) walk(path.join(dir, ent.name));
      else if (ent.name.endsWith(".so") || ent.name.includes(".so.")) hasSo = true;
    }
    if (hasSo) dirs.push(dir);
  })(sysroot);
  process.env.LD_LIBRARY_PATH = dirs.join(":") + (process.env.LD_LIBRARY_PATH ? ":" + process.env.LD_LIBRARY_PATH : "");
})();

const ROOT = path.join(__dirname, "..");
const DOCS = path.join(ROOT, "docs");
const SHOTS = path.join(DOCS, "screenshots");
const ART = path.join(DOCS, "artifacts");
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(ART, { recursive: true });

const results = [];
function check(name, ok, detail) {
  ok = !!ok;
  results.push({ name, ok, detail: detail || "" });
  console.log((ok ? "PASS" : "FAIL") + "  " + name + (detail ? "  — " + detail : ""));
}

/** 轮询断言：谓词必须返回 Promise<boolean>，超时则失败。 */
async function expectThat(label, fn, timeout) {
  const deadline = Date.now() + (timeout || 6000);
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      if (await fn()) { check(label, true); return true; }
    } catch (e) { lastErr = e.message; }
    await new Promise(r => setTimeout(r, 150));
  }
  check(label, false, lastErr || "条件未在超时内成立");
  return false;
}

(async () => {
  const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json" };
  const server = http.createServer((req, res) => {
    const url = req.url.split("?")[0];
    const file = path.join(ROOT, url === "/" ? "index.html" : url);
    if (!file.startsWith(ROOT)) { res.statusCode = 403; res.end(); return; }
    fsp.readFile(file).then(buf => {
      res.setHeader("Content-Type", MIME[path.extname(file)] || "application/octet-stream");
      res.end(buf);
    }).catch(() => { res.statusCode = 404; res.end("not found"); });
  });
  await new Promise(r => server.listen(8947, r));
  const BASE = "http://localhost:8947/";

  const browser = await chromium.launch({ headless: true });
  const pageErrors = [];
  function attach(page) {
    page.on("dialog", d => d.accept().catch(() => {})); // confirm() 一律确认
    page.on("pageerror", e => pageErrors.push(e.message));
  }

  /* ---------------- 桌面主流程 ---------------- */
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const page = await ctx.newPage();
    attach(page);
    await page.goto(BASE);

    // 1. 旧入口：地图/列表同步、新增标记
    await expectThat("桌面：初始地图显示 2 个标记", async () => (await page.locator(".marker").count()) === 2);
    const box = await page.locator("#map").boundingBox();
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.4);
    await page.fill("#markForm input[name='code']", "B-100");
    await page.fill("#markForm input[name='depth']", "19");
    await page.fill("#markForm input[name='condition']", "新发现陶片");
    await page.click("#saveMarkBtn");
    await expectThat("桌面：地图新增标记 B-100 成功提示", async () => (await page.locator(".toast.ok").count()) > 0);
    await expectThat("桌面：保存后地图同步为 3 个标记", async () => (await page.locator(".marker").count()) === 3);

    // 列表/时间线切换
    await page.selectOption("#listMode", "timeline");
    await expectThat("桌面：时间线按潜次分组并带封存状态",
      async () => (await page.locator("#list .item b").first().textContent()) === "DIVE-01"
        && (await page.locator("#list .pill.warn").count()) >= 2);
    await page.selectOption("#listMode", "list");

    // 2. 跨潜次引用未封存 → 封存必须拦截
    await page.click('.marker[title^="A-017"]');
    await page.fill("#markForm input[name='refs']", "W-003");
    await page.click("#saveMarkBtn");
    await page.click('.tab[data-view="seal"]');
    await page.click("#diveList .item:has-text('DIVE-01')");
    await page.click("#runCheckBtn");
    await expectThat("桌面：合规检查拦截并列出错误", async () => (await page.locator("#checkResult .banner.err").count()) === 1);
    const errText = await page.locator("#checkResult .banner.err").innerText();
    check("桌面：拦截原因含「跨潜次引用…尚未封存」", /跨潜次引用[\s\S]*尚未封存/.test(errText), errText.replace(/\s+/g, " ").slice(0, 120));
    check("桌面：有错误时封存按钮禁用", await page.locator("#doSealBtn").isDisabled());

    // 3. 清空引用 → 检查通过 → 封存
    await page.click('.tab[data-view="map"]');
    await page.click('.marker[title^="A-017"]');
    await page.fill("#markForm input[name='refs']", "");
    await page.click("#saveMarkBtn");
    await page.click('.tab[data-view="seal"]');
    await page.click("#runCheckBtn");
    await expectThat("桌面：整改后合规检查通过", async () => (await page.locator("#checkResult .banner.ok").count()) > 0);
    await page.fill("#operatorName", "现场监督林岚");
    await page.click("#doSealBtn");
    await expectThat("桌面：封存生成校验码卡片", async () => (await page.locator(".checksum-card").count()) > 0);
    const code12 = (await page.locator('[id^="sealCode_"]').innerText()).trim();
    check("桌面：校验码为 12 位十六进制", /^[0-9a-f]{12}$/.test(code12), code12);
    await expectThat("桌面：封存快照复算一致", async () => (await page.locator('[id^="sealVerify_"]').innerText()).includes("复算一致"));
    const sealedDiveId = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("diveArchive.state.v2")).seals)[0]);
    await page.screenshot({ path: path.join(SHOTS, "desktop-01-sealed.png") });

    // 4. 封存后原标记只读
    await page.click('.tab[data-view="map"]');
    await expectThat("桌面：地图以虚线显示已封存标记", async () => (await page.locator('.marker.sealed[title^="A-017"]').count()) > 0);
    await page.click('.marker[title^="A-017"]');
    await expectThat("桌面：已封存标记显示只读横幅", async () => (await page.locator("#markLockBanner .banner.locked").count()) > 0);
    check("桌面：已封存标记保存按钮禁用", await page.locator("#saveMarkBtn").isDisabled());

    // 5. 复查追加 + 差异比较
    await page.click('.tab[data-view="review"]');
    await page.selectOption("#reviewDive", "DIVE-01");
    await page.fill("#rvAuthor", "复查员周牧");
    await page.fill("#rvNote", "季度复查：B-100 附着物增加");
    await page.fill('[data-cr="0"] [data-k="code"]', "B-100");
    await page.fill('[data-cr="0"] [data-k="condition"]', "中度劣化");
    await page.fill('[data-cr="0"] [data-k="observation"]', "贝类附着扩大，边缘缺损");
    await page.click("#rvSubmit");
    await expectThat("桌面：复查记录已追加", async () => (await page.locator("#reviewList details").count()) === 1);
    await expectThat("桌面：复查链校验完整", async () => (await page.locator(".mono .pill.ok").count()) > 0);
    const diffText = await page.locator("#rvDiff").innerText();
    check("桌面：差异比较显示 B-100 保存状态变化", /B-100[\s\S]*中度劣化/.test(diffText), diffText.replace(/\s+/g, " ").slice(0, 120));
    await page.screenshot({ path: path.join(SHOTS, "desktop-02-review-diff.png") });

    // 6. 坏主档：损坏主文件后刷新 → 横幅 + 备份恢复 + 原文隔离
    await page.evaluate(() => window.localStorage.setItem("diveArchive.state.v2", "{损坏的JSON"));
    await page.goto(BASE);
    const banners = await page.locator("#loadBanners").innerText();
    check("桌面：坏主档触发损坏横幅", banners.includes("STATE_CORRUPT"), banners.replace(/\s+/g, " ").slice(0, 160));
    check("桌面：自动从备份恢复并提示", banners.includes("RESTORED_FROM_BACKUP"));
    await page.click('.tab[data-view="data"]');
    await expectThat("桌面：坏文件原文进入隔离区可导出", async () => (await page.locator("#quarantineList details").count()) > 0);
    await page.screenshot({ path: path.join(SHOTS, "desktop-03-corrupt-banner.png") });

    // 7. 注入游离标记 → 快照还原清除
    await page.evaluate(() => {
      const s = JSON.parse(window.localStorage.getItem("diveArchive.state.v2"));
      s.marks.push({ id: "rogue1", code: "Z-900", dive: "DIVE-01", type: "unknown", depth: "9", attribution: "x", x: 10, y: 10 });
      window.localStorage.setItem("diveArchive.state.v2", JSON.stringify(s));
    });
    await page.goto(BASE);
    await page.click('.tab[data-view="map"]');
    await expectThat("桌面：注入的游离标记已出现（还原前）", async () => (await page.locator('.marker[title^="Z-900"]').count()) > 0);
    await page.click('.tab[data-view="data"]');
    await page.click('[data-restore-btn="' + sealedDiveId + '"]');
    await expectThat("桌面：还原成功提示", async () => (await page.locator(".toast.ok").count()) > 0);
    await page.click('.tab[data-view="map"]');
    await expectThat("桌面：还原后游离标记消失", async () => (await page.locator('.marker[title^="Z-900"]').count()) === 0);
    await expectThat("桌面：快照内 A-017 保留", async () => (await page.locator('.marker[title^="A-017"]').count()) > 0);

    // 8. 导出审计包（下载并用 Node 侧数据层复算）
    await page.click('.tab[data-view="data"]');
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#exportAuditBtn")]);
    const auditPath = path.join(ART, "dive-audit-desktop.json");
    await dl.saveAs(auditPath);
    const pkg = JSON.parse(fs.readFileSync(auditPath, "utf8"));
    const verify = await Store.verifyAuditPackage(pkg);
    check("桌面：审计包整体与快照校验码复算通过", verify.ok, verify.errors.join(";"));
    check("桌面：审计包内含封存校验与复查链结论", !!pkg.sealChecks[sealedDiveId] && pkg.sealChecks[sealedDiveId].ok === true && pkg.sealChecks[sealedDiveId].reviewChain === true);

    await ctx.close();
  }

  /* ---------------- 坏文件 / 高版本 / 审计包往返（干净上下文） ---------------- */
  {
    // 坏 JSON 导入：不覆盖现有数据，原文隔离
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const page = await ctx.newPage();
    attach(page);
    await page.goto(BASE);
    const marksBefore = await page.evaluate(() => JSON.parse(window.localStorage.getItem("diveArchive.state.v2")).marks.length);
    const badFile = path.join(ART, "bad-import.json");
    fs.writeFileSync(badFile, "{oops 不是JSON");
    await page.click('.tab[data-view="data"]');
    await page.setInputFiles("#fileInput", badFile);
    await expectThat("导入：坏 JSON 被拒并提示已隔离",
      async () => (await page.locator(".toast.err").allInnerTexts()).some(t => t.includes("不是合法 JSON")));
    const marksAfter = await page.evaluate(() => JSON.parse(window.localStorage.getItem("diveArchive.state.v2")).marks.length);
    check("导入：坏文件没有覆盖现有数据", marksBefore === marksAfter, marksBefore + " -> " + marksAfter);
    await ctx.close();
  }

  {
    // 高版本：隔离 + 横幅，不加载
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    await ctx.addInitScript(() => window.localStorage.setItem("diveArchive.state.v2", JSON.stringify({ version: 99, dives: [], marks: [] })));
    const page = await ctx.newPage();
    attach(page);
    await page.goto(BASE);
    const banners = await page.locator("#loadBanners").innerText();
    check("高版本：提示隔离并要求用新版打开", banners.includes("STATE_FUTURE_VERSION"), banners.replace(/\s+/g, " ").slice(0, 120));
    await page.click('.tab[data-view="data"]');
    await expectThat("高版本：原文已隔离保留", async () => (await page.locator("#quarantineList details").count()) > 0);
    await ctx.close();
  }

  {
    // 审计包往返导入：干净上下文导入桌面导出的审计包，封存记录仍可复算
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const page = await ctx.newPage();
    attach(page);
    await page.goto(BASE);
    await page.click('.tab[data-view="data"]');
    await page.setInputFiles("#fileInput", path.join(ART, "dive-audit-desktop.json"));
    await expectThat("审计包：往返导入成功",
      async () => (await page.locator(".toast.ok").allInnerTexts()).some(t => t.includes("audit")));
    await page.click('.tab[data-view="seal"]');
    await expectThat("审计包：导入后封存潜次仍标记为只读", async () => (await page.locator("#diveList .item.sealed").count()) > 0);
    const reVerify = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("diveArchive.state.v2"));
      return Object.keys(s.seals).length;
    });
    check("审计包：导入后封存记录数为 1", reVerify === 1, "seals=" + reVerify);
    await ctx.close();
  }

  /* ---------------- 手机视口：封存 / 复查 / 恢复 / 导出 全走通 ---------------- */
  {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3, isMobile: true, hasTouch: true, acceptDownloads: true
    });
    const page = await ctx.newPage();
    attach(page);
    await page.goto(BASE);
    await expectThat("手机：地图标记正常渲染（单列布局）", async () => (await page.locator(".marker").count()) === 2);

    await page.click('.tab[data-view="seal"]');
    await page.click("#diveList .item:has-text('DIVE-02')");
    await page.fill("#operatorName", "林岚");
    await page.click("#runCheckBtn");
    await expectThat("手机：DIVE-02 合规检查通过", async () => (await page.locator("#checkResult .banner.ok").count()) > 0);
    await page.screenshot({ path: path.join(SHOTS, "mobile-01-seal-form.png"), fullPage: true });
    await page.click("#doSealBtn");
    await expectThat("手机：封存成功并显示校验码", async () => (await page.locator(".checksum-card").count()) > 0);
    await page.screenshot({ path: path.join(SHOTS, "mobile-02-sealed.png"), fullPage: true });

    await page.click('.tab[data-view="review"]');
    await page.selectOption("#reviewDive", "DIVE-02");
    await page.fill("#rvAuthor", "周牧");
    await page.fill("#rvNote", "手机端现场复查：木构件稳定");
    await page.fill('[data-cr="0"] [data-k="code"]', "W-003");
    await page.fill('[data-cr="0"] [data-k="condition"]', "稳定");
    await page.fill('[data-cr="0"] [data-k="observation"]', "无新增缺损");
    await page.click("#rvSubmit");
    await expectThat("手机：复查追加成功", async () => (await page.locator("#reviewList details").count()) === 1);
    const mdiff = await page.locator("#rvDiff").innerText();
    check("手机：差异比较区正常渲染", /W-003/.test(mdiff) || /完全一致/.test(mdiff), mdiff.replace(/\s+/g, " ").slice(0, 80));
    await page.screenshot({ path: path.join(SHOTS, "mobile-03-review.png"), fullPage: true });

    await page.click('.tab[data-view="data"]');
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#exportAuditBtn")]);
    const mobileAudit = path.join(ART, "dive-audit-mobile.json");
    await dl.saveAs(mobileAudit);
    const mpkg = JSON.parse(fs.readFileSync(mobileAudit, "utf8"));
    const mv = await Store.verifyAuditPackage(mpkg);
    check("手机：导出审计包校验通过", mv.ok, mv.errors.join(";"));

    const rid = Object.keys(mpkg.state.seals)[0];
    await page.click('[data-restore-btn="' + rid + '"]');
    await expectThat("手机：快照还原成功", async () => (await page.locator(".toast.ok").count()) > 0);
    await ctx.close();
  }

  check("浏览器控制台无未捕获脚本错误", pageErrors.length === 0, pageErrors.join(" | "));

  const passed = results.filter(r => r.ok).length;
  const failed = results.length - passed;
  fs.writeFileSync(path.join(DOCS, ".browser-check-results.json"), JSON.stringify({
    at: new Date().toISOString(),
    browser: "Chromium " + browser.version(),
    total: results.length, passed, failed, results
  }, null, 2));

  await browser.close();
  server.close();
  console.log("\n" + passed + "/" + results.length + " passed");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
