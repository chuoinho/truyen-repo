const fs = require("node:fs/promises");
const path = require("node:path");

const OWNER = "chuoinho";
const REPO = "truyen-repo";
const BRANCH = "repo";
const RAW_BASE = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}`;
const REPO_INDEX_URL = `${RAW_BASE}/index.min.json`;
const REPO_PB_URL = `${RAW_BASE}/index.pb`;
const REPO_JSON_URL = `${RAW_BASE}/repo.json`;
const STATUS_INTERVAL_HOURS = 5;
const SOURCE_TIMEOUT_MS = Number(process.env.SOURCE_CHECK_TIMEOUT_MS || 15000);
const REPO_TIMEOUT_MS = Number(process.env.REPO_CHECK_TIMEOUT_MS || 10000);
const SOURCE_CONCURRENCY = Number(process.env.SOURCE_CHECK_CONCURRENCY || 5);
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36";
const OTRUYEN_API_URL = "https://otruyenapi.com/v1/api/danh-sach/truyen-moi?page=1";
const CUUTRUYEN_ACCESS_URL = "https://truycapcuutruyen.pages.dev/";
const CUUTRUYEN_API_PATH = "/api/v2/mangas/top?duration=month&page=1";
const CUUTRUYEN_TRACE_PATH = "/cdn-cgi/trace";
const HTTPS_ORIGIN_REGEX = /https:\/\/[a-z0-9.-]+/gi;

function nowIso() {
  return new Date().toISOString();
}

function addHours(date, hours) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function cleanExtensionName(name) {
  return String(name || "").replace(/^Tachiyomi:\s*/i, "");
}

function check(id, name, ok, data = {}) {
  return {
    id,
    name,
    ok: Boolean(ok),
    status: ok ? "working" : "error",
    ...data,
  };
}

function errorMessage(error) {
  if (!error) return "Unknown error";
  if (error.name === "AbortError") return "Request timed out";
  return error.message || String(error);
}

async function timedFetch(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || SOURCE_TIMEOUT_MS);
  const started = performance.now();
  const method = options.method || "GET";

  try {
    const response = await fetch(url, {
      method,
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
        "accept-language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
        "user-agent": USER_AGENT,
        ...(options.headers || {}),
      },
    });

    let body = "";
    let bytes = Number(response.headers.get("content-length")) || 0;
    if (options.readBody === false) {
      await response.body?.cancel();
    } else if (method !== "HEAD") {
      const buffer = Buffer.from(await response.arrayBuffer());
      bytes = buffer.length;
      if (options.returnBody) body = buffer.toString("utf8");
    }

    return {
      body,
      bytes,
      finalUrl: response.url,
      latencyMs: Math.round(performance.now() - started),
      ok: response.ok,
      status: response.status,
    };
  } catch (error) {
    return {
      error: errorMessage(error),
      latencyMs: Math.round(performance.now() - started),
      ok: false,
      status: 0,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, headers = {}, options = {}) {
  const result = await timedFetch(url, {
    headers,
    returnBody: true,
    timeoutMs: options.timeoutMs || SOURCE_TIMEOUT_MS,
  });

  if (!result.ok) return { ...result, json: null };

  try {
    return { ...result, json: JSON.parse(result.body) };
  } catch (error) {
    return {
      ...result,
      error: `Invalid JSON: ${error.message}`,
      json: null,
      ok: false,
    };
  }
}

async function readLocalIndex() {
  const indexPath = path.join(process.cwd(), "index.min.json");
  const content = await fs.readFile(indexPath, "utf8");
  return JSON.parse(content);
}

function flattenSources(index) {
  return index.flatMap((extension) => {
    const extensionName = cleanExtensionName(extension.name);
    return (extension.sources || []).map((source, sourceIndex) => ({
      id: source.id || `${extension.pkg || extensionName}:${sourceIndex}`,
      name: source.name || extensionName,
      baseUrl: source.baseUrl,
      lang: source.lang || extension.lang,
      nsfw: extension.nsfw,
      package: extension.pkg,
      apk: extension.apk,
      extensionName,
      extensionVersion: extension.version,
      versionId: source.versionId,
    }));
  });
}

async function checkBaseUrl(baseUrl) {
  if (!baseUrl) {
    return {
      ok: false,
      status: 0,
      error: "Missing baseUrl",
      latencyMs: 0,
    };
  }

  return timedFetch(baseUrl, {
    method: "GET",
    readBody: false,
    timeoutMs: SOURCE_TIMEOUT_MS,
  });
}

function sourceSpecificChecker(source) {
  if (source.package === "eu.kanade.tachiyomi.extension.vi.otruyen") return checkOTruyenSource;
  if (source.package === "eu.kanade.tachiyomi.extension.vi.cuutruyen") return checkCuuTruyenSource;
  return null;
}

function sourceResult(source, data) {
  const ok = Boolean(data.ok);
  return {
    ...source,
    ok,
    status: data.status || (ok ? "working" : "error"),
    error: ok ? undefined : data.error,
    finalUrl: data.finalUrl,
    latencyMs: data.latencyMs,
    note: data.note,
    confidence: data.confidence,
    primaryCheckId: data.primaryCheckId,
    checks: data.checks || [],
  };
}

async function checkSource(source, baseUrlResults) {
  const checker = sourceSpecificChecker(source);
  if (checker) return checker(source);

  const started = performance.now();
  const result = baseUrlResults.get(source.baseUrl) || {
    ok: false,
    status: 0,
    error: "baseUrl was not checked",
    latencyMs: 0,
  };
  const ok = Boolean(result.ok);

  return sourceResult(source, {
    ok,
    error: ok ? undefined : result.error || `HTTP ${result.status}`,
    finalUrl: result.finalUrl,
    latencyMs: Math.round(performance.now() - started + (result.latencyMs || 0)),
    primaryCheckId: "base-url",
    checks: [
      check("base-url", "Base URL", ok, {
        bytes: result.bytes,
        detail: result.finalUrl && result.finalUrl !== source.baseUrl ? result.finalUrl : source.baseUrl,
        error: result.error,
        latencyMs: result.latencyMs,
        statusCode: result.status,
      }),
    ],
  });
}

async function checkOTruyenSource(source) {
  const started = performance.now();
  const api = await fetchJson(OTRUYEN_API_URL, {
    accept: "application/json",
    referer: `${source.baseUrl}/`,
  });
  const items = Array.isArray(api.json?.data?.items) ? api.json.data.items : [];
  const ok = api.ok && api.json?.status === "success" && items.length > 0;

  return sourceResult(source, {
    ok,
    error: ok ? undefined : api.error || `OTruyen API returned HTTP ${api.status}`,
    finalUrl: api.finalUrl,
    latencyMs: Math.round(performance.now() - started),
    primaryCheckId: "source-api",
    confidence: ok ? "api" : "none",
    checks: [
      check("source-api", "OTruyen API", ok, {
        count: items.length,
        detail: `${items.length} items from ${OTRUYEN_API_URL}`,
        error: api.error,
        latencyMs: api.latencyMs,
        statusCode: api.status,
      }),
    ],
  });
}

async function checkCuuTruyenSource(source) {
  const started = performance.now();
  const access = await timedFetch(CUUTRUYEN_ACCESS_URL, {
    returnBody: true,
    timeoutMs: SOURCE_TIMEOUT_MS,
  });
  const candidates = uniqueUrls([
    source.baseUrl,
    ...parseCuuTruyenBaseUrls(access.body || ""),
  ]);
  const trace = await firstReachable(candidates, (baseUrl) =>
    timedFetch(`${baseUrl}${CUUTRUYEN_TRACE_PATH}`, {
      readBody: false,
      timeoutMs: SOURCE_TIMEOUT_MS,
    }),
  );
  const api = await firstReachable(candidates, (baseUrl) =>
    fetchJson(`${baseUrl}${CUUTRUYEN_API_PATH}`, {
      accept: "application/json",
      referer: `${baseUrl}/`,
    }),
  );
  const apiItems = Array.isArray(api.result?.json?.data) ? api.result.json.data : [];
  const accessHasCandidates = access.ok && candidates.length > 0;
  const apiOk = Boolean(api.result?.ok && apiItems.length > 0);
  const traceOk = Boolean(trace.result?.ok);
  const ok = apiOk || traceOk || accessHasCandidates;
  const note = apiOk
    ? undefined
    : ok
      ? "CDN/access page reachable; data API is blocked or unavailable from this runner."
      : undefined;

  return sourceResult(source, {
    ok,
    error: ok ? undefined : access.error || trace.result?.error || api.result?.error || "CuuTruyen probes failed",
    finalUrl: api.result?.finalUrl || trace.result?.finalUrl || access.finalUrl,
    latencyMs: Math.round(performance.now() - started),
    note,
    confidence: apiOk ? "api" : traceOk ? "cdn-trace" : accessHasCandidates ? "resolver" : "none",
    primaryCheckId: apiOk ? "source-api" : traceOk ? "cloudflare-trace" : "access-page",
    checks: [
      check("access-page", "CuuTruyen access page", accessHasCandidates, {
        count: candidates.length,
        detail: accessHasCandidates
          ? `${candidates.length} candidate domains`
          : CUUTRUYEN_ACCESS_URL,
        error: access.error,
        latencyMs: access.latencyMs,
        statusCode: access.status,
      }),
      check("cloudflare-trace", "Cloudflare trace", traceOk, {
        detail: trace.baseUrl || candidates[0] || source.baseUrl,
        error: trace.result?.error,
        latencyMs: trace.result?.latencyMs,
        statusCode: trace.result?.status,
      }),
      check("source-api", "CuuTruyen API", apiOk, {
        count: apiItems.length,
        detail: api.baseUrl ? `${apiItems.length} items from ${api.baseUrl}` : candidates[0] || source.baseUrl,
        error: api.result?.error,
        latencyMs: api.result?.latencyMs,
        statusCode: api.result?.status,
      }),
    ],
  });
}

function uniqueUrls(urls) {
  return [...new Set(urls.filter(Boolean).map((url) => url.trim().replace(/\/$/, "")))];
}

function parseCuuTruyenBaseUrls(content) {
  return [...content.matchAll(HTTPS_ORIGIN_REGEX)]
    .map((match) => normalizeCuuTruyenBaseUrl(match[0]))
    .filter(Boolean);
}

function normalizeCuuTruyenBaseUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.host.replace(/^www\./, "");

    if (host.endsWith("pages.dev") || host.endsWith("workers.dev")) return null;
    if (!host.startsWith("cuutruyen") && !host.startsWith("hetcuutruyen") && !host.startsWith("nettrom")) {
      return null;
    }

    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

async function firstReachable(baseUrls, worker) {
  let firstResult = null;

  for (const baseUrl of baseUrls) {
    const result = await worker(baseUrl);
    firstResult ||= { baseUrl, result };
    if (result.ok) return { baseUrl, result };
  }

  return firstResult || { baseUrl: null, result: null };
}

async function checkRepoUrl(id, name, url) {
  let response = await timedFetch(url, {
    method: "HEAD",
    readBody: false,
    timeoutMs: REPO_TIMEOUT_MS,
  });

  if (response.status === 405 || response.status === 0) {
    response = await timedFetch(url, {
      method: "GET",
      readBody: false,
      timeoutMs: REPO_TIMEOUT_MS,
    });
  }

  return check(id, name, response.ok, {
    bytes: response.bytes,
    detail: url,
    error: response.error,
    latencyMs: response.latencyMs,
    statusCode: response.status,
  });
}

async function repoChecks(index) {
  const apkTargets = index
    .filter((extension) => extension.apk)
    .map((extension) => [
      `apk:${extension.pkg}`,
      `${cleanExtensionName(extension.name)} APK`,
      `${RAW_BASE}/apk/${extension.apk}`,
    ]);

  const targets = [
    ["repo-index", "index.min.json", REPO_INDEX_URL],
    ["repo-index-pb", "index.pb", REPO_PB_URL],
    ["repo-json", "repo.json", REPO_JSON_URL],
    ...apkTargets,
  ];

  return runLimited(targets, 6, ([id, name, url]) => checkRepoUrl(id, name, url));
}

async function runLimited(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, runWorker));
  return results;
}

function statusLevel(repoFileChecks, sources) {
  const repoOk = repoFileChecks.every((item) => item.ok);
  const workingSources = sources.filter((item) => item.ok).length;

  if (repoOk && workingSources === sources.length) return "healthy";
  if (repoOk && workingSources > 0) return "degraded";
  return "down";
}

function statusSummary(level, sources) {
  const workingSources = sources.filter((item) => item.ok).length;
  const totalSources = sources.length;

  if (level === "healthy") return `All ${totalSources} sources are working.`;
  if (level === "degraded") return `${workingSources}/${totalSources} sources are working.`;
  return `0/${totalSources} sources are working.`;
}

function extensionSummary(index) {
  return index.map((extension) => ({
    apk: extension.apk,
    code: extension.code,
    lang: extension.lang,
    name: extension.name,
    nsfw: extension.nsfw,
    package: extension.pkg,
    sourceCount: extension.sources?.length || 0,
    version: extension.version,
  }));
}

async function main() {
  const started = performance.now();
  const checkedAtDate = new Date();
  const checkedAt = checkedAtDate.toISOString();
  const index = await readLocalIndex();
  const sourceEntries = flattenSources(index);
  const genericSourceEntries = sourceEntries.filter((source) => !sourceSpecificChecker(source));
  const uniqueBaseUrls = [...new Set(genericSourceEntries.map((source) => source.baseUrl).filter(Boolean))];

  const baseUrlChecks = await runLimited(uniqueBaseUrls, SOURCE_CONCURRENCY, async (baseUrl) => [
    baseUrl,
    await checkBaseUrl(baseUrl),
  ]);
  const baseUrlResults = new Map(baseUrlChecks);
  const sources = await runLimited(sourceEntries, SOURCE_CONCURRENCY, (source) =>
    checkSource(source, baseUrlResults),
  );
  const repoFileChecks = await repoChecks(index);
  const level = statusLevel(repoFileChecks, sources);
  const workingSources = sources.filter((item) => item.ok).length;

  const payload = {
    schemaVersion: 2,
    checkedAt,
    nextScheduledAt: addHours(checkedAtDate, STATUS_INTERVAL_HOURS).toISOString(),
    intervalHours: STATUS_INTERVAL_HOURS,
    durationMs: Math.round(performance.now() - started),
    level,
    ok: level === "healthy",
    summary: statusSummary(level, sources),
    stats: {
      totalExtensions: index.length,
      totalSources: sources.length,
      workingSources,
      errorSources: sources.length - workingSources,
      warningSources: sources.filter((item) => item.note).length,
      repoFiles: repoFileChecks.length,
      repoErrors: repoFileChecks.filter((item) => !item.ok).length,
    },
    repository: {
      branch: BRANCH,
      indexUrl: REPO_INDEX_URL,
      ok: repoFileChecks.every((item) => item.ok),
      checks: repoFileChecks,
    },
    repo: {
      ok: repoFileChecks.every((item) => item.ok),
      checks: repoFileChecks,
    },
    extensions: extensionSummary(index),
    sources,
  };

  await fs.writeFile("status.json", `${JSON.stringify(payload, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

main().catch(async (error) => {
  const payload = {
    schemaVersion: 2,
    checkedAt: nowIso(),
    durationMs: 0,
    error: errorMessage(error),
    level: "down",
    ok: false,
    repo: { ok: false, checks: [] },
    repository: { ok: false, checks: [] },
    sources: [],
    summary: "Status checker failed before completing checks.",
  };

  await fs.writeFile("status.json", `${JSON.stringify(payload, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
});
