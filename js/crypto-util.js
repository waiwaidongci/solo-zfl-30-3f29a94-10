/* 校验码与规范化序列化（Node / 浏览器通用，UMD，无第三方依赖）。 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DiveCrypto = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function getCrypto() {
    const c = typeof globalThis !== "undefined" && globalThis.crypto;
    if (!c || !c.subtle) throw new Error("当前环境不支持 Web Crypto (crypto.subtle)");
    return c;
  }

  /** 对象键按字典序排列的确定性 JSON，保证快照与校验码可复算。 */
  function canonicalize(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
    const keys = Object.keys(value).sort();
    return "{" + keys.map(function (k) {
      return JSON.stringify(k) + ":" + canonicalize(value[k]);
    }).join(",") + "}";
  }

  async function sha256Hex(text) {
    const data = new TextEncoder().encode(text);
    const digest = await getCrypto().subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest), function (b) {
      return b.toString(16).padStart(2, "0");
    }).join("");
  }

  /** 校验码：规范化载荷的 SHA-256 前 12 位，另返回完整哈希。 */
  async function checksum(payload) {
    const canonical = canonicalize(payload);
    const full = await sha256Hex(canonical);
    return { canonical: canonical, full: full, code: full.slice(0, 12) };
  }

  function uuid() {
    return getCrypto().randomUUID();
  }

  /** 复算校验码（只读复查用）。 */
  async function verifyChecksum(payload, expectedFull) {
    const full = (await checksum(payload)).full;
    return full === expectedFull;
  }

  return { canonicalize: canonicalize, sha256Hex: sha256Hex, checksum: checksum, uuid: uuid, verifyChecksum: verifyChecksum };
});
