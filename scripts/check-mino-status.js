const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const OWNER = "chuoinho";
const REPO = "truyen-repo";
const BRANCH = "repo";
const RAW_BASE = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}`;
const REPO_INDEX_URL = `${RAW_BASE}/index.min.json`;
const REPO_PB_URL = `${RAW_BASE}/index.pb`;
const REPO_JSON_URL = `${RAW_BASE}/repo.json`;
const API_URL = "https://api.cloudkk-v1.xyz/api";
const AES_KEY = "GCERKSmf28E6nWwrnR8Lz4f7TacKpzMy7aK0rxSB";
const FALLBACK_BASE_URL = "https://minotruyenv7.xyz";
const REDIRECT_HOST = "minotruyen.pages.dev";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36";

const CATEGORIES = [
  { key: "manga", name: "MinoTruyen Manga" },
  { key: "comics", name: "MinoTruyen Comics" },
  { key: "hentai", name: "MinoTruyen Hentai" },
];

const MINO_BASE_URL_REGEX = /https:\/\/minotruyenv\d+\.xyz/;
const SCRIPT_SRC_REGEX = /src="([^"]+\.js)"/g;
const ENCRYPTED_DATA_REGEX = /([a-f0-9]{32}:U2FsdGVk[A-Za-z0-9+/=]+)/;

function nowIso() {
  return new Date().toISOString();
}

async function timedFetch(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15000);
  const started = performance.now();

  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": USER_AGENT,
        ...(options.headers || {}),
      },
      method: options.method || "GET",
    });
    const body =
      options.readBody === false ? "" : Buffer.from(await response.arrayBuffer()).toString("utf8");

    return {
      body,
      bytes: Number(response.headers.get("content-length")) || Buffer.byteLength(body),
      finalUrl: response.url,
      latencyMs: Math.round(performance.now() - started),
      ok: response.ok,
      status: response.status,
    };
  } catch (error) {
    return {
      error: error.message || String(error),
      latencyMs: Math.round(performance.now() - started),
      ok: false,
      status: 0,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, headers = {}) {
  const result = await timedFetch(url, { headers });
  if (!result.ok) return { ...result, json: null };

  try {
    return { ...result, json: JSON.parse(result.body) };
  } catch (error) {
    return { ...result, error: `Invalid JSON: ${error.message}`, json: null, ok: false };
  }
}

function check(id, name, ok, data = {}) {
  return {
    id,
    name,
    ok: Boolean(ok),
    ...data,
  };
}

async function resolveBaseUrl(category) {
  const redirectUrl = `https://minotruyen.pages.dev/r/${category}`;
  const response = await timedFetch(redirectUrl);

  if (!response.ok) {
    return {
      baseUrl: FALLBACK_BASE_URL,
      response,
      via: "fallback",
    };
  }

  const finalUrl = new URL(response.finalUrl);
  if (finalUrl.host !== REDIRECT_HOST) {
    return {
      baseUrl: finalUrl.origin,
      response,
      via: "redirect",
    };
  }

  const directBaseUrl = response.body.match(MINO_BASE_URL_REGEX)?.[0];
  if (directBaseUrl) {
    return {
      baseUrl: directBaseUrl.replace(/\/$/, ""),
      response,
      via: "html",
    };
  }

  for (const match of response.body.matchAll(SCRIPT_SRC_REGEX)) {
    const sourcePath = match[1].replaceAll("&amp;", "&");
    if (!sourcePath.includes("/app/r/")) continue;

    const scriptUrl = new URL(sourcePath, response.finalUrl).toString();
    const script = await timedFetch(scriptUrl);
    const scriptBaseUrl = script.body.match(MINO_BASE_URL_REGEX)?.[0];
    if (scriptBaseUrl) {
      return {
        baseUrl: scriptBaseUrl.replace(/\/$/, ""),
        response,
        scriptUrl,
        via: "script",
      };
    }
  }

  return {
    baseUrl: FALLBACK_BASE_URL,
    response,
    via: "fallback",
  };
}

function evpBytesToKey(password, salt, keyLength = 32, ivLength = 16) {
  let generated = Buffer.alloc(0);
  let previous = Buffer.alloc(0);

  while (generated.length < keyLength + ivLength) {
    const md5 = crypto.createHash("md5");
    md5.update(previous);
    md5.update(Buffer.from(password, "utf8"));
    md5.update(salt);
    previous = md5.digest();
    generated = Buffer.concat([generated, previous]);
  }

  return {
    iv: generated.subarray(keyLength, keyLength + ivLength),
    key: generated.subarray(0, keyLength),
  };
}

function decryptCryptoJs(cipherTextBase64, password) {
  const encrypted = Buffer.from(cipherTextBase64, "base64");
  const salt = encrypted.subarray(8, 16);
  const cipherText = encrypted.subarray(16);
  const { key, iv } = evpBytesToKey(password, salt);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);

  return Buffer.concat([decipher.update(cipherText), decipher.final()]).toString("utf8");
}

function chapterNumberForUrl(chapterNumber) {
  return String(chapterNumber).replace(/\.0$/, "");
}

async function checkImage(imageUrl, baseUrl) {
  const normalizedUrl = imageUrl.startsWith("//")
    ? `https:${imageUrl}`
    : imageUrl.startsWith("/")
      ? `${baseUrl}${imageUrl}`
      : imageUrl;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const started = performance.now();

  try {
    const response = await fetch(normalizedUrl, {
      signal: controller.signal,
      headers: {
        range: "bytes=0-4095",
        "user-agent": USER_AGENT,
      },
    });
    const bytes = Buffer.from(await response.arrayBuffer()).length;

    return {
      bytes,
      contentType: response.headers.get("content-type"),
      latencyMs: Math.round(performance.now() - started),
      ok: response.ok && bytes > 0,
      status: response.status,
      url: normalizedUrl,
    };
  } catch (error) {
    return {
      error: error.message || String(error),
      latencyMs: Math.round(performance.now() - started),
      ok: false,
      status: 0,
      url: normalizedUrl,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkCategory(category) {
  const categoryInfo = CATEGORIES.find((item) => item.key === category) || {
    key: category,
    name: category,
  };
  const started = performance.now();
  const checks = [];
  const result = {
    id: category,
    name: categoryInfo.name,
    ok: false,
    checks,
  };

  try {
    const resolved = await resolveBaseUrl(category);
    const baseUrl = resolved.baseUrl;
    result.baseUrl = baseUrl;
    checks.push(
      check("resolve-domain", "Resolve domain", true, {
        detail: `${baseUrl} via ${resolved.via}`,
        latencyMs: resolved.response.latencyMs,
        status: resolved.response.status,
      }),
    );

    const apiHeaders = {
      origin: baseUrl,
      referer: `${baseUrl}/`,
    };

    const listUrl = `${API_URL}/books?take=24&page=1&category=${encodeURIComponent(category)}`;
    const list = await fetchJson(listUrl, apiHeaders);
    const books = Array.isArray(list.json?.books) ? list.json.books : [];
    checks.push(
      check("list-api", "List API", list.ok && books.length > 0, {
        count: books.length,
        detail: `${books.length} books`,
        latencyMs: list.latencyMs,
        status: list.status,
      }),
    );
    if (!books.length) throw new Error(list.error || "List API returned no books");

    const book = books[0];
    result.sampleBook = {
      id: book.bookId,
      title: book.title,
    };

    const detailUrl = `${baseUrl}/${category}/books/${book.bookId}`;
    const detail = await timedFetch(detailUrl, {
      headers: {
        referer: `${baseUrl}/`,
      },
    });
    const detailHasBookData = detail.body.includes('"book"') || detail.body.includes("bookId");
    checks.push(
      check("detail-page", "Detail page", detail.ok && detailHasBookData, {
        detail: detailHasBookData ? "book data found" : "book data missing",
        latencyMs: detail.latencyMs,
        status: detail.status,
      }),
    );
    if (!detailHasBookData) throw new Error("Detail page does not include book data");

    const chaptersUrl = `${API_URL}/chapters/${book.bookId}?order=desc&take=5000`;
    const chaptersResponse = await fetchJson(chaptersUrl, apiHeaders);
    const chapters = Array.isArray(chaptersResponse.json?.chapters)
      ? chaptersResponse.json.chapters
      : [];
    checks.push(
      check("chapter-api", "Chapter API", chaptersResponse.ok && chapters.length > 0, {
        count: chapters.length,
        detail: `${chapters.length} chapters`,
        latencyMs: chaptersResponse.latencyMs,
        status: chaptersResponse.status,
      }),
    );
    if (!chapters.length) throw new Error(chaptersResponse.error || "Chapter API returned no chapters");

    const chapter = chapters[0];
    result.sampleChapter = {
      number: chapter.chapterNumber,
      title: chapter.num,
    };

    const readUrl = `${baseUrl}/${category}/books/${book.bookId}/${chapterNumberForUrl(
      chapter.chapterNumber,
    )}`;
    const read = await timedFetch(readUrl, {
      headers: {
        referer: `${baseUrl}/`,
      },
    });
    const encrypted = read.body.match(ENCRYPTED_DATA_REGEX)?.[1];
    checks.push(
      check("read-page", "Read page", read.ok && Boolean(encrypted), {
        detail: encrypted ? "encrypted payload found" : "encrypted payload missing",
        latencyMs: read.latencyMs,
        status: read.status,
      }),
    );
    if (!encrypted) throw new Error("Read page has no encrypted chapter payload");

    const encryptedPayload = encrypted.split(":").slice(1).join(":");
    const decrypted = decryptCryptoJs(encryptedPayload, AES_KEY);
    const servers = JSON.parse(decrypted);
    const pageCount = Array.isArray(servers)
      ? servers.reduce((count, server) => count + (server.content?.length || 0), 0)
      : 0;
    const firstImage = servers?.find((server) => server.content?.length)?.content?.[0]?.imageUrl;

    checks.push(
      check("decrypt-pages", "Decrypt pages", pageCount > 0, {
        count: pageCount,
        detail: `${servers.length} servers, ${pageCount} pages`,
      }),
    );
    if (!pageCount || !firstImage) throw new Error("Decrypted payload has no image pages");

    const image = await checkImage(firstImage, baseUrl);
    checks.push(
      check("image-fetch", "Image fetch", image.ok, {
        bytes: image.bytes,
        detail: `${image.contentType || "unknown"} ${image.bytes || 0} bytes`,
        latencyMs: image.latencyMs,
        status: image.status,
      }),
    );

    result.ok = checks.every((item) => item.ok);
  } catch (error) {
    result.error = error.message || String(error);
    checks.push(
      check("result", "Result", false, {
        detail: result.error,
      }),
    );
  }

  result.latencyMs = Math.round(performance.now() - started);
  return result;
}

async function repoChecks(extension) {
  const apkUrl = extension?.apk ? `${RAW_BASE}/apk/${extension.apk}` : null;
  const targets = [
    ["repo-index", "index.min.json", REPO_INDEX_URL],
    ["repo-index-pb", "index.pb", REPO_PB_URL],
    ["repo-json", "repo.json", REPO_JSON_URL],
    ["apk", "APK", apkUrl],
  ].filter((item) => item[2]);

  return Promise.all(
    targets.map(async ([id, name, url]) => {
      const response = await timedFetch(url, { method: "HEAD", readBody: false });
      return check(id, name, response.ok, {
        bytes: response.bytes,
        detail: url,
        latencyMs: response.latencyMs,
        status: response.status,
      });
    }),
  );
}

async function readLocalIndex() {
  const indexPath = path.join(process.cwd(), "index.min.json");
  const content = await fs.readFile(indexPath, "utf8");
  return JSON.parse(content);
}

function statusLevel(repoFileChecks, categories) {
  const repoOk = repoFileChecks.every((item) => item.ok);
  const okCategories = categories.filter((item) => item.ok).length;

  if (repoOk && okCategories === categories.length) return "healthy";
  if (repoOk && okCategories > 0) return "degraded";
  return "down";
}

function statusSummary(level, categories) {
  const okCategories = categories.filter((item) => item.ok).length;
  if (level === "healthy") return "MinoTruyen đang hoạt động bình thường.";
  if (level === "degraded") return `${okCategories}/${categories.length} source còn hoạt động.`;
  return "Chưa lấy được dữ liệu đọc truyện từ MinoTruyen.";
}

async function main() {
  const started = performance.now();
  const checkedAt = nowIso();
  const index = await readLocalIndex();
  const extension = index[0] || null;
  const repoFileChecks = await repoChecks(extension);
  const categories = await Promise.all(CATEGORIES.map((item) => checkCategory(item.key)));
  const level = statusLevel(repoFileChecks, categories);
  const payload = {
    schemaVersion: 1,
    checkedAt,
    durationMs: Math.round(performance.now() - started),
    extension: extension
      ? {
          apk: extension.apk,
          code: extension.code,
          lang: extension.lang,
          name: extension.name,
          nsfw: extension.nsfw,
          package: extension.pkg,
          repoUrl: REPO_INDEX_URL,
          version: extension.version,
        }
      : null,
    level,
    ok: level === "healthy",
    repo: {
      ok: repoFileChecks.every((item) => item.ok),
      checks: repoFileChecks,
    },
    sources: categories,
    summary: statusSummary(level, categories),
  };

  await fs.writeFile("status.json", `${JSON.stringify(payload, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

main().catch(async (error) => {
  const payload = {
    schemaVersion: 1,
    checkedAt: nowIso(),
    durationMs: 0,
    error: error.message || String(error),
    level: "down",
    ok: false,
    repo: { ok: false, checks: [] },
    sources: [],
    summary: "Status checker failed before completing checks.",
  };

  await fs.writeFile("status.json", `${JSON.stringify(payload, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
});
