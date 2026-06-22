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

    let bytes = Number(response.headers.get("content-length")) || 0;
    if (options.readBody === false) {
      await response.body?.cancel();
    } else if (method !== "HEAD") {
      const body = Buffer.from(await response.arrayBuffer());
      bytes = body.length;
    }

    return {
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

async function checkSource(source, baseUrlResults) {
  const started = performance.now();
  const result = baseUrlResults.get(source.baseUrl) || {
    ok: false,
    status: 0,
    error: "baseUrl was not checked",
    latencyMs: 0,
  };
  const ok = Boolean(result.ok);

  return {
    ...source,
    ok,
    status: ok ? "working" : "error",
    error: ok ? undefined : result.error || `HTTP ${result.status}`,
    finalUrl: result.finalUrl,
    latencyMs: Math.round(performance.now() - started + (result.latencyMs || 0)),
    checks: [
      check("base-url", "Base URL", ok, {
        bytes: result.bytes,
        detail: result.finalUrl && result.finalUrl !== source.baseUrl ? result.finalUrl : source.baseUrl,
        error: result.error,
        latencyMs: result.latencyMs,
        statusCode: result.status,
      }),
    ],
  };
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
  const uniqueBaseUrls = [...new Set(sourceEntries.map((source) => source.baseUrl).filter(Boolean))];

  const baseUrlChecks = await runLimited(uniqueBaseUrls, SOURCE_CONCURRENCY, async (baseUrl) => [
    baseUrl,
    await checkBaseUrl(baseUrl),
  ]);
  const baseUrlResults = new Map(baseUrlChecks);
  const sources = await Promise.all(sourceEntries.map((source) => checkSource(source, baseUrlResults)));
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
