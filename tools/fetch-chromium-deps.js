/* 无 root 环境下抓取 Chromium headless shell 运行库闭包（Debian 12 bookworm arm64）。
 * 用法：node tools/fetch-chromium-deps.js
 * 产物：tools/sysroot（解包后的 .so），测试脚本通过 LD_LIBRARY_PATH 加载。 */
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");

const MIRROR = process.env.DEB_MIRROR || "http://deb.debian.org/debian";
const DIST = "bookworm";
const ARCH = "arm64";
const ROOT = path.join(__dirname, "..");
const DEB_DIR = path.join(ROOT, ".debs");
const SYSROOT = path.join(ROOT, "tools", "sysroot");
fs.mkdirSync(DEB_DIR, { recursive: true });

// Playwright 在 Debian/Ubuntu 上所需运行库的 bookworm 包名（字体可选，略过）
const SEEDS = [
  "libnspr4", "libnss3", "libatk1.0-0", "libatk-bridge2.0-0", "libatspi2.0-0",
  "libcups2", "libdrm2", "libxkbcommon0", "libxcomposite1", "libxdamage1",
  "libxfixes3", "libxrandr2", "libgbm1", "libpango-1.0-0", "libcairo2",
  "libasound2", "libxshmfence1", "libxtst6", "libxrender1", "libx11-6",
  "libxcb1", "libxext6", "libexpat1", "libglib2.0-0", "libdbus-1-3",
  "libx11-xcb1", "libxcursor1", "libxi6", "fontconfig", "libfontconfig1",
  "libfreetype6", "libpng16-16", "libxcb-shm0", "libxcb-render0",
  "libgraphite2-3", "libharfbuzz0b", "libpangoft2-1.0-0", "libpixman-1-0",
  "libxinerama1", "libxkbfile1", "libnotify4", "libsecret-1-0"
];

async function get(url, dest, gunzip) {
  if (dest && fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  console.log("GET", url);
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status + " " + url);
  const buf = Buffer.from(await res.arrayBuffer());
  const out = gunzip ? zlib.gunzipSync(buf) : buf;
  if (dest) fs.writeFileSync(dest, out);
  return out;
}

function parsePackages(text) {
  const map = new Map();
  for (const para of text.split("\n\n")) {
    if (!para.trim()) continue;
    const fields = {};
    let last = null;
    for (const line of para.split("\n")) {
      if (/^\s/.test(line) && last) fields[last] += " " + line.trim();
      else {
        const m = line.match(/^(\S+):\s?(.*)$/);
        if (m) { fields[m[1]] = m[2]; last = m[1]; }
      }
    }
    if (fields.Package) map.set(fields.Package, fields);
  }
  return map;
}

function resolveDeps(depField) {
  if (!depField) return [];
  return depField.split(",").map(clause => {
    const name = clause.trim().split("|")[0].trim().replace(/^([a-z0-9.+-]+).*/, "$1");
    return name;
  }).filter(Boolean);
}

(async () => {
  const idxPath = path.join(DEB_DIR, "Packages-" + DIST + "-" + ARCH + ".txt");
  if (!fs.existsSync(idxPath)) {
    await get(MIRROR + "/dists/" + DIST + "/main/binary-" + ARCH + "/Packages.gz", idxPath, true);
  }
  const packages = parsePackages(fs.readFileSync(idxPath, "utf8"));

  const queue = SEEDS.slice();
  const want = new Set();
  while (queue.length) {
    const name = queue.pop();
    if (want.has(name)) continue;
    const p = packages.get(name);
    if (!p) { console.warn("  跳过（索引中无此包）：", name); continue; }
    want.add(name);
    for (const dep of resolveDeps(p.Depends)) {
      if (!want.has(dep) && packages.has(dep)) queue.push(dep);
    }
  }
  console.log("闭包共 " + want.size + " 个包");

  for (const name of want) {
    const p = packages.get(name);
    const file = path.basename(p.Filename);
    const dest = path.join(DEB_DIR, file);
    await get(MIRROR + "/" + p.Filename, dest);
    execFileSync("dpkg-deb", ["-x", dest, SYSROOT], { stdio: "inherit" });
  }
  console.log("完成，sysroot =", SYSROOT);
})().catch(e => { console.error(e); process.exit(1); });
