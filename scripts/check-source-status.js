const fs = require("node:fs/promises");
const path = require("node:path");
const dns = require("node:dns/promises");

const OWNER = "chuoinho";
const REPO = "truyen-repo";
const BRANCH = "repo";
const RAW_BASE = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}`;
const REPO_INDEX_URL = `${RAW_BASE}/index.min.json`;
const REPO_PB_URL = `${RAW_BASE}/index.pb`;
const REPO_JSON_URL = `${RAW_BASE}/repo.json`;
const STATUS_INTERVAL_HOURS = 12;
const FAILURE_THRESHOLD = Number(process.env.SOURCE_FAILURE_THRESHOLD || 2);
const SOURCE_TIMEOUT_MS = Number(process.env.SOURCE_CHECK_TIMEOUT_MS || 15000);
const REPO_TIMEOUT_MS = Number(process.env.REPO_CHECK_TIMEOUT_MS || 10000);
const SOURCE_CONCURRENCY = Number(process.env.SOURCE_CHECK_CONCURRENCY || 5);
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36";
const MOBILE_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36";
const OTRUYEN_API_URL = "https://otruyenapi.com/v1/api/danh-sach/truyen-moi?page=1";
const CUUTRUYEN_ACCESS_URL = "https://truycapcuutruyen.pages.dev/";
const CUUTRUYEN_API_PATH = "/api/v2/mangas/top?duration=month&page=1";
const MINO_API_URL = "https://api.cloudkk-v1.xyz/api";
const MINO_CATEGORIES = ["manga", "comics", "hentai"];
const MINO_PACKAGE = "eu.kanade.tachiyomi.extension.vi.minotruyen";
const CMANGA_PACKAGE = "eu.kanade.tachiyomi.extension.vi.cmanga";
const CUUTRUYEN_MOE_PACKAGE = "eu.kanade.tachiyomi.extension.vi.cuutruyenmoe";
const GOC_TRUYEN_PACKAGE = "eu.kanade.tachiyomi.extension.vi.goctruyentranhvui";
const CMANGA_DOMAIN_CANDIDATES = ["https://cmanga.net", "https://cmangapi.com"];
const GENERIC_ENTRY_PATHS = ["", "/", "/truyen-moi", "/danh-sach/truyen-moi", "/hot", "/manga", "/truyen-tranh"];
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
        "user-agent": options.userAgent || USER_AGENT,
        ...(options.headers || {}),
      },
      body: options.body,
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
      contentType: response.headers.get("content-type") || "",
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

async function timedDnsLookup(baseUrl) {
  const started = performance.now();

  try {
    const hostname = new URL(baseUrl).hostname;
    const result = await dns.lookup(hostname);
    return {
      address: result.address,
      detail: hostname,
      latencyMs: Math.round(performance.now() - started),
      ok: true,
      status: 200,
    };
  } catch (error) {
    return {
      detail: baseUrl,
      error: errorMessage(error),
      latencyMs: Math.round(performance.now() - started),
      ok: false,
      status: 0,
    };
  }
}

function isRunnerBlockedResponse(result) {
  return [401, 403, 429].includes(Number(result?.status));
}

function runnerBlockedNote(status) {
  return `Trang vẫn truy cập được nhưng chặn máy kiểm tra với HTTP ${status}.`;
}

function dnsReachableNote(error) {
  return `Tên miền còn phân giải DNS; máy kiểm tra không xác nhận được HTTP${error ? ` (${error})` : ""}.`;
}

async function fetchJson(url, headers = {}, options = {}) {
  const result = await timedFetch(url, {
    body: options.body,
    headers,
    method: options.method,
    returnBody: true,
    timeoutMs: options.timeoutMs || SOURCE_TIMEOUT_MS,
    userAgent: options.userAgent,
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

async function readPreviousStatus() {
  try {
    const content = await fs.readFile("status.json", "utf8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function flattenSources(index) {
  return index.flatMap((extension) => {
    const extensionName = cleanExtensionName(extension.name);
    if (extension.pkg === MINO_PACKAGE) {
      return [{
        id: "mino-read-flow",
        name: extensionName,
        baseUrl: extension.sources?.[0]?.baseUrl,
        lang: extension.lang,
        nsfw: extension.nsfw,
        package: extension.pkg,
        apk: extension.apk,
        extensionName,
        extensionVersion: extension.version,
        versionId: extension.sources?.[0]?.versionId,
        sourceCount: extension.sources?.length || 0,
      }];
    }
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

  const dnsResult = await timedDnsLookup(baseUrl);
  const httpResult = await timedFetch(baseUrl, {
    method: "GET",
    readBody: false,
    timeoutMs: SOURCE_TIMEOUT_MS,
  });

  return {
    ...httpResult,
    dns: dnsResult,
  };
}

function sourceSpecificChecker(source) {
  if (source.package === CMANGA_PACKAGE) return checkCMangaSource;
  if (source.package === "eu.kanade.tachiyomi.extension.vi.minotruyen") return checkMinoTruyenSource;
  if (source.package === "eu.kanade.tachiyomi.extension.vi.otruyen") return checkOTruyenSource;
  if (source.package === "eu.kanade.tachiyomi.extension.vi.cuutruyen") return checkCuuTruyenSource;
  if (source.package === CUUTRUYEN_MOE_PACKAGE) return checkCuuTruyenMoeSource;
  if (source.package === GOC_TRUYEN_PACKAGE) return checkGocTruyenTranhVuiSource;
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
    inconclusive: Boolean(data.inconclusive),
    primaryCheckId: data.primaryCheckId,
    checks: data.checks || [],
  };
}

async function checkSource(source, baseUrlResults) {
  const checker = sourceSpecificChecker(source);
  if (checker) return checker(source);

  return checkGenericHtmlReadFlow(source);
}

function previousSourceMap(previousStatus) {
  return new Map((previousStatus?.sources || []).map((source) => [String(source.id), source]));
}

function sourceHistory(previousStatus, previousSource, checkedAt, source) {
  const previousHistory = previousSource?.history || {};
  const previousFailures =
    Number(previousHistory.consecutiveFailures ?? previousSource?.consecutiveFailures ?? 0) || 0;

  if (source.ok) {
    return {
      consecutiveFailures: 0,
      failureThreshold: FAILURE_THRESHOLD,
      lastErrorAt: previousHistory.lastErrorAt || previousSource?.lastErrorAt,
      lastOkAt: checkedAt,
    };
  }

  return {
    consecutiveFailures: previousFailures + 1,
    failureThreshold: FAILURE_THRESHOLD,
    lastErrorAt: checkedAt,
    lastOkAt:
      previousHistory.lastOkAt ||
      previousSource?.lastOkAt ||
      (previousSource?.ok ? previousStatus?.checkedAt : undefined),
  };
}

function applySourceHistory(sources, previousStatus, checkedAt) {
  const previousSources = previousSourceMap(previousStatus);

  return sources.map((source) => {
    const previousSource = previousSources.get(String(source.id));

    if (source.inconclusive && (previousSource?.lastOkAt || previousSource?.history?.lastOkAt)) {
      const lastOkAt = previousSource.history?.lastOkAt || previousSource.lastOkAt;
      const history = {
        ...(previousSource.history || {}),
        consecutiveFailures: 0,
        failureThreshold: FAILURE_THRESHOLD,
        lastInconclusiveAt: checkedAt,
        lastOkAt,
      };

      return {
        ...source,
        consecutiveFailures: 0,
        error: undefined,
        history,
        lastErrorAt: history.lastErrorAt,
        lastOkAt,
        note: source.note || "Máy kiểm tra bị chặn; giữ kết quả đọc truyện thành công gần nhất.",
        ok: true,
        status: "warning",
      };
    }

    const history = sourceHistory(previousStatus, previousSource, checkedAt, source);

    if (source.ok) {
      return {
        ...source,
        consecutiveFailures: history.consecutiveFailures,
        history,
        lastErrorAt: history.lastErrorAt,
        lastOkAt: history.lastOkAt,
      };
    }

    if (history.consecutiveFailures < FAILURE_THRESHOLD) {
      return {
        ...source,
        consecutiveFailures: history.consecutiveFailures,
        error: undefined,
        history,
        lastErrorAt: history.lastErrorAt,
        lastOkAt: history.lastOkAt,
        note: `Nguồn lỗi lần ${history.consecutiveFailures}/${FAILURE_THRESHOLD}; cần thêm lần kiểm tra tiếp theo trước khi báo lỗi.`,
        ok: true,
        status: "working",
      };
    }

    return {
      ...source,
      consecutiveFailures: history.consecutiveFailures,
      history,
      lastErrorAt: history.lastErrorAt,
      lastOkAt: history.lastOkAt,
    };
  });
}

function absoluteUrl(rawUrl, baseUrl) {
  if (!rawUrl) return "";
  try {
    return new URL(rawUrl.replace(/&amp;/g, "&"), baseUrl).toString();
  } catch {
    return "";
  }
}

function sameSiteUrl(url, baseUrl) {
  try {
    const target = new URL(url);
    const base = new URL(baseUrl);
    return target.hostname.replace(/^www\./, "") === base.hostname.replace(/^www\./, "");
  } catch {
    return false;
  }
}

function stripUrlHash(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function uniqueNormalizedUrls(urls) {
  return [...new Set(urls.map(stripUrlHash).filter(Boolean))];
}

function extractHtmlLinks(html, baseUrl) {
  return uniqueNormalizedUrls(
    [...String(html || "").matchAll(/\bhref\s*=\s*["']([^"'#]+)["']/gi)]
      .map((match) => absoluteUrl(match[1], baseUrl))
      .filter((url) => sameSiteUrl(url, baseUrl)),
  );
}

function extractHtmlImages(html, baseUrl) {
  const attrs = [
    /\bsrc\s*=\s*["']([^"']+)["']/gi,
    /\bdata-src\s*=\s*["']([^"']+)["']/gi,
    /\bdata-original\s*=\s*["']([^"']+)["']/gi,
    /\bdata-lazy-src\s*=\s*["']([^"']+)["']/gi,
  ];
  return uniqueNormalizedUrls(
    attrs.flatMap((regex) =>
      [...String(html || "").matchAll(regex)].map((match) => absoluteUrl(match[1], baseUrl)),
    ).filter((url) => {
      if (!url || url.startsWith("data:")) return false;
      return /\.(avif|gif|jpe?g|png|webp)([?#].*)?$/i.test(url) ||
        /\/(uploads|upload|comic|chapter|chap|manga|images|image)\//i.test(url);
    }),
  );
}

function readerImageScore(url) {
  if (/\/(image_comics|chapter|chap|pages?|uploads\/page)\//i.test(url)) return 2;
  if (/[?&]data=(vip|vipx)\b/i.test(url)) return 2;
  if (/\/(logo|default|avatar|user|icon|emoji|comment)\b/i.test(url)) return -1;
  return 0;
}

function looksLikeMangaLink(url, baseUrl) {
  if (!sameSiteUrl(url, baseUrl)) return false;
  const path = new URL(url).pathname.toLowerCase();
  if (/\.(css|js|gif|jpe?g|png|svg|webp|ico|woff2?)$/i.test(path)) return false;
  if (/(login|logout|register|search|tim-kiem|the-loai|genre|tag|category|lich-su|privacy|contact)/i.test(path)) {
    return false;
  }
  return /(truyen|manga|comic|manhwa|manhua|series|read|doc)/i.test(path) ||
    path.split("/").filter(Boolean).length >= 1;
}

function looksLikeChapterLink(url, detailUrl) {
  const path = new URL(url).pathname.toLowerCase();
  if (stripUrlHash(url) === stripUrlHash(detailUrl)) return false;
  if (/\.(css|js|gif|jpe?g|png|svg|webp|ico|woff2?)$/i.test(path)) return false;
  return /(chapter|chap|chuong|chương|\/c\/|\/read\/|\/doc\/|tap-|tap\/|-\d+\/?$)/i.test(path);
}

async function fetchHtml(url, headers = {}) {
  return timedFetch(url, {
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      referer: url,
      ...headers,
    },
    returnBody: true,
    timeoutMs: SOURCE_TIMEOUT_MS,
    userAgent: headers["user-agent"],
  });
}

async function checkGenericHtmlReadFlow(source) {
  const started = performance.now();
  const deadline = started + Math.max(30_000, SOURCE_TIMEOUT_MS * 3);
  const baseUrl = source.baseUrl?.replace(/\/$/, "");
  const dns = await timedDnsLookup(baseUrl);
  let flowTimedOut = false;
  let list = null;
  let listUrl = null;
  let detail = null;
  let detailUrl = null;
  let chapter = null;
  let chapterUrl = null;
  let image = null;
  let imageUrl = null;

  entryPaths:
  for (const entryPath of GENERIC_ENTRY_PATHS) {
    if (performance.now() >= deadline) {
      flowTimedOut = true;
      break;
    }
    const candidate = `${baseUrl}${entryPath}`;
    list = await fetchHtml(candidate);
    if (!list.ok || !list.body) continue;
    const listBaseUrl = list.finalUrl || candidate;
    const links = extractHtmlLinks(list.body, listBaseUrl)
      .filter((url) => looksLikeMangaLink(url, listBaseUrl));
    if (!links.length) continue;

    listUrl = candidate;
    for (const candidateDetailUrl of links.slice(0, 12)) {
      if (performance.now() >= deadline) {
        flowTimedOut = true;
        break entryPaths;
      }
      detail = await fetchHtml(candidateDetailUrl, { referer: list.finalUrl || candidate });
      if (!detail.ok || !detail.body) continue;

      const detailBaseUrl = detail.finalUrl || candidateDetailUrl;
      const chapterLinks = extractHtmlLinks(detail.body, detailBaseUrl)
        .filter((url) => looksLikeChapterLink(url, candidateDetailUrl));
      if (!chapterLinks.length) continue;

      detailUrl = candidateDetailUrl;
      for (const candidateChapterUrl of chapterLinks.slice(0, 12)) {
        if (performance.now() >= deadline) {
          flowTimedOut = true;
          break entryPaths;
        }
        chapter = await fetchHtml(candidateChapterUrl, { referer: detail.finalUrl || candidateDetailUrl });
        if (!chapter.ok || !chapter.body) continue;

        const images = extractHtmlImages(chapter.body, chapter.finalUrl || candidateChapterUrl)
          .sort((a, b) => readerImageScore(b) - readerImageScore(a));
        for (const candidateImageUrl of images.slice(0, 8)) {
          if (performance.now() >= deadline) {
            flowTimedOut = true;
            break entryPaths;
          }
          image = await checkImageReadable(candidateImageUrl, {
            referer: chapter.finalUrl || candidateChapterUrl,
          });
          if (image.ok) {
            chapterUrl = candidateChapterUrl;
            imageUrl = candidateImageUrl;
            break;
          }
        }
        if (image?.ok) break;
      }
      if (image?.ok) break;
    }
    if (image?.ok) break;
  }

  const listOk = Boolean(list?.ok && listUrl);
  const detailOk = Boolean(detail?.ok && detailUrl);
  const chapterOk = Boolean(chapter?.ok && chapterUrl);
  const imageOk = Boolean(image?.ok);
  const ok = Boolean(listOk && detailOk && chapterOk && imageOk);
  const inconclusive = Boolean(!ok && dns.ok && isRunnerBlockedResponse(list));

  return sourceResult(source, {
    ok,
    error: ok
      ? undefined
      : inconclusive
        ? `Status runner blocked with HTTP ${list.status}`
        : flowTimedOut
          ? "Generic read flow timed out"
          : image?.error || chapter?.error || detail?.error || list?.error || "Generic read flow failed",
    finalUrl: chapterUrl || detailUrl || list?.finalUrl || baseUrl,
    inconclusive,
    latencyMs: Math.round(performance.now() - started),
    note: inconclusive ? runnerBlockedNote(list.status) : undefined,
    confidence: ok ? "read-flow" : "none",
    primaryCheckId: "read-pages",
    checks: [
      check("dns", "DNS", dns.ok, {
        detail: dns.detail || baseUrl,
        error: dns.error,
        latencyMs: dns.latencyMs,
        statusCode: dns.status,
      }),
      check("read-list", "Read list", listOk, {
        detail: listUrl || baseUrl,
        error: list?.error,
        latencyMs: list?.latencyMs,
        statusCode: list?.status,
      }),
      check("read-detail", "Read detail", detailOk, {
        detail: detailUrl || "No manga detail link found",
        error: detail?.error,
        latencyMs: detail?.latencyMs,
        statusCode: detail?.status,
      }),
      check("read-chapters", "Read chapters", chapterOk, {
        detail: chapterUrl || "No chapter link found",
        error: chapter?.error,
        latencyMs: chapter?.latencyMs,
        statusCode: chapter?.status,
      }),
      check("read-image", "Read image", imageOk, {
        bytes: image?.bytes,
        contentType: image?.contentType,
        detail: imageUrl || image?.finalUrl,
        error: image?.error || (!imageOk && image?.contentType ? `Unexpected content-type ${image.contentType}` : undefined),
        latencyMs: image?.latencyMs,
        statusCode: image?.status,
      }),
    ],
  });
}

function parseJsonString(value) {
  if (!value || typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function cleanBaseUrlFromFinalUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return url?.replace(/\/$/, "");
  }
}

async function resolveCMangaBaseUrl(source) {
  const candidates = uniqueUrls([source.baseUrl, ...CMANGA_DOMAIN_CANDIDATES]);
  let first = null;

  for (const candidate of candidates) {
    const result = await timedFetch(candidate, {
      headers: { referer: `${candidate}/` },
      readBody: false,
    });
    first ||= { baseUrl: candidate, result };
    if (result.ok && /cmanga/i.test(result.finalUrl || candidate)) {
      return { baseUrl: cleanBaseUrlFromFinalUrl(result.finalUrl || candidate), result };
    }
  }

  return {
    baseUrl: cleanBaseUrlFromFinalUrl(first?.result?.finalUrl || source.baseUrl),
    result: first?.result,
  };
}

async function checkCMangaSource(source) {
  const started = performance.now();
  const dns = await timedDnsLookup(source.baseUrl);
  const resolved = await resolveCMangaBaseUrl(source);
  const baseUrl = resolved.baseUrl?.replace(/\/$/, "");
  const listUrl = `${baseUrl}/api/home_album_list?file=image&type=hot&sort=view_total&tag=&limit=6&page=1`;
  const list = await fetchJson(listUrl, {
    accept: "application/json",
    referer: `${baseUrl}/`,
  });
  const albums = Array.isArray(list.json?.data?.data) ? list.json.data.data : [];
  const selectedAlbum = albums
    .map((album) => ({ album, info: parseJsonString(album.info) }))
    .find((entry) => entry.info?.id && entry.info?.url);

  const chapterListUrl = selectedAlbum
    ? `${baseUrl}/api/chapter_list?album=${selectedAlbum.info.id}&page=1&limit=10&v=0&slug=${encodeURIComponent(selectedAlbum.info.url)}`
    : "";
  const chapters = chapterListUrl
    ? await fetchJson(chapterListUrl, {
        accept: "application/json",
        referer: `${baseUrl}/album/${selectedAlbum.info.url}-${selectedAlbum.info.id}`,
      })
    : null;
  const chapterItems = Array.isArray(chapters?.json?.data) ? chapters.json.data : [];
  const selectedChapter = chapterItems
    .map((chapter) => ({ chapter, info: parseJsonString(chapter.info) }))
    .find((entry) => entry.info?.id || entry.chapter?.id_chapter);
  const chapterId = selectedChapter?.info?.id || selectedChapter?.chapter?.id_chapter;
  const pagesUrl = chapterId
    ? `${baseUrl}/api/chapter_image?chapter=${chapterId}&v=0&time=${Math.floor(Date.now() / 1000)}&user_id=0&user_token=`
    : "";
  const pages = pagesUrl
    ? await fetchJson(pagesUrl, {
        accept: "application/json",
        referer: `${baseUrl}/album/${selectedAlbum.info.url}/chapter-${selectedChapter.info?.num || ""}-${chapterId}`,
      })
    : null;
  const images = Array.isArray(pages?.json?.data?.image) ? pages.json.data.image : [];
  const image = await checkImageReadable(images.find(Boolean));

  const resolvedOk = Boolean(resolved.result?.ok && baseUrl);
  const listOk = Boolean(list.ok && albums.length > 0 && selectedAlbum);
  const chaptersOk = Boolean(chapters?.ok && chapterItems.length > 0 && selectedChapter);
  const pagesOk = Boolean(pages?.ok && images.length > 0);
  const imageOk = Boolean(image.ok);
  const ok = Boolean(resolvedOk && listOk && chaptersOk && pagesOk && imageOk);

  return sourceResult(source, {
    ok,
    error: ok ? undefined : image.error || pages?.error || chapters?.error || list.error || resolved.result?.error || "CManga API read flow failed",
    finalUrl: pages?.finalUrl || chapters?.finalUrl || list.finalUrl || baseUrl,
    latencyMs: Math.round(performance.now() - started),
    confidence: ok ? "read-flow" : "none",
    primaryCheckId: "read-pages",
    checks: [
      check("dns", "DNS", dns.ok, {
        detail: dns.detail || source.baseUrl,
        error: dns.error,
        latencyMs: dns.latencyMs,
        statusCode: dns.status,
      }),
      check("resolve-domain", "Resolve current domain", resolvedOk, {
        detail: baseUrl || source.baseUrl,
        error: resolved.result?.error,
        latencyMs: resolved.result?.latencyMs,
        statusCode: resolved.result?.status,
      }),
      check("read-list", "Read list", listOk, {
        count: albums.length,
        detail: `${albums.length} albums from ${listUrl}`,
        error: list.error,
        latencyMs: list.latencyMs,
        statusCode: list.status,
      }),
      check("read-chapters", "Read chapters", chaptersOk, {
        count: chapterItems.length,
        detail: chapterListUrl || "No CManga album",
        error: chapters?.error,
        latencyMs: chapters?.latencyMs,
        statusCode: chapters?.status,
      }),
      check("read-pages", "Read pages", pagesOk, {
        count: images.length,
        detail: pagesUrl || "No CManga chapter",
        error: pages?.error,
        latencyMs: pages?.latencyMs,
        statusCode: pages?.status,
      }),
      check("read-image", "Read image", imageOk, {
        bytes: image.bytes,
        contentType: image.contentType,
        detail: images[0] || image.finalUrl,
        error: image.error,
        latencyMs: image.latencyMs,
        statusCode: image.status,
      }),
    ],
  });
}

function cookieHeaderFromSetCookie(headers) {
  const setCookie =
    typeof headers?.getSetCookie === "function"
      ? headers.getSetCookie()
      : String(headers?.get?.("set-cookie") || "").split(/,(?=\s*[^;,]+=)/);
  return setCookie
    .map((value) => String(value).split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

async function timedFetchWithHeaders(url, options = {}) {
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
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
        "accept-language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
        "user-agent": options.userAgent || USER_AGENT,
        ...(options.headers || {}),
      },
      body: options.body,
    });
    const buffer = options.readBody === false ? Buffer.alloc(0) : Buffer.from(await response.arrayBuffer());

    return {
      body: options.returnBody ? buffer.toString("utf8") : "",
      bytes: Number(response.headers.get("content-length")) || buffer.length,
      contentType: response.headers.get("content-type") || "",
      cookies: cookieHeaderFromSetCookie(response.headers),
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

async function fetchGocJson(url, baseUrl, cookie = "", options = {}) {
  return fetchJson(url, {
    accept: "application/json",
    cookie,
    origin: baseUrl,
    referer: `${baseUrl}/`,
    "x-requested-with": "XMLHttpRequest",
    ...(options.headers || {}),
  }, options);
}

async function checkGocTruyenTranhVuiSource(source) {
  const started = performance.now();
  const baseUrl = source.baseUrl?.replace(/\/$/, "");
  const dns = await timedDnsLookup(baseUrl);
  const session = await timedFetchWithHeaders(`${baseUrl}/trang-chu`, {
    headers: {
      referer: `${baseUrl}/`,
      "sec-ch-ua-mobile": "?1",
      "sec-ch-ua-platform": "\"Android\"",
    },
    returnBody: false,
    userAgent: MOBILE_USER_AGENT,
  });
  const cookie = session.cookies || "";
  const listUrl = `${baseUrl}/api/v2/home/filter?p=0&value=recommend`;
  const list = await fetchGocJson(listUrl, baseUrl, cookie, { userAgent: MOBILE_USER_AGENT });
  const comics = Array.isArray(list.json?.result?.data) ? list.json.result.data : [];
  const selectedComic = comics.find((comic) => comic?.id && comic?.nameEn && Array.isArray(comic.chapterLatest) && comic.chapterLatest.length);
  const detailUrl = selectedComic ? `${baseUrl}/truyen/${selectedComic.nameEn}` : "";
  const detail = detailUrl
    ? await fetchHtml(detailUrl, {
        cookie,
        referer: `${baseUrl}/trang-chu`,
        "user-agent": MOBILE_USER_AGENT,
      })
    : null;
  const chaptersUrl = selectedComic ? `${baseUrl}/api/comic/${selectedComic.id}/chapter?limit=-1` : "";
  const chapters = chaptersUrl
    ? await fetchGocJson(chaptersUrl, baseUrl, cookie, { userAgent: MOBILE_USER_AGENT })
    : null;
  const chapterItems = Array.isArray(chapters?.json?.result?.chapters) ? chapters.json.result.chapters : [];
  const selectedChapter = chapterItems.find((chapter) => chapter?.numberChapter);
  const pagesUrl = `${baseUrl}/api/chapter/loadAll`;
  const body = selectedComic && selectedChapter
    ? new URLSearchParams({
        comicId: selectedComic.id,
        chapterNumber: selectedChapter.numberChapter,
        nameEn: selectedComic.nameEn,
      }).toString()
    : "";
  const pages = body
    ? await fetchJson(pagesUrl, {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        cookie,
        origin: baseUrl,
        referer: `${baseUrl}/truyen/${selectedComic.nameEn}/chuong-${selectedChapter.numberChapter}`,
        "x-requested-with": "XMLHttpRequest",
      }, {
        body,
        method: "POST",
        userAgent: MOBILE_USER_AGENT,
      })
    : null;
  const images = Array.isArray(pages?.json?.result?.data) ? pages.json.result.data : [];
  const imageUrl = images.find(Boolean)?.startsWith("/image/") ? `${baseUrl}${images.find(Boolean)}` : images.find(Boolean);
  const coverUrl = selectedComic?.photo?.startsWith("/") ? `${baseUrl}${selectedComic.photo}` : selectedComic?.photo;
  const image = await checkImageReadable(imageUrl || coverUrl);

  const sessionOk = Boolean(session.ok && cookie);
  const listOk = Boolean(list.ok && list.json?.status === true && comics.length > 0 && selectedComic);
  const detailOk = Boolean(detail?.ok && detail.body);
  const chaptersOk = Boolean(chapters?.ok && chapters.json?.status === true && chapterItems.length > 0);
  const pageNeedsToken = Boolean(pages?.ok && pages.json?.status === true && pages.json?.result?.state === true && pages.json?.result?.data == null);
  const pagesOk = Boolean((pages?.ok && pages.json?.status === true && images.length > 0) || pageNeedsToken);
  const imageOk = Boolean(image.ok);
  const ok = Boolean(sessionOk && listOk && detailOk && chaptersOk && pagesOk && imageOk);

  return sourceResult(source, {
    ok,
    error: ok ? undefined : pages?.error || chapters?.error || detail?.error || list.error || session.error || "GocTruyenTranhVui API read flow failed",
    finalUrl: pages?.finalUrl || chapters?.finalUrl || detail?.finalUrl || list.finalUrl || session.finalUrl || baseUrl,
    latencyMs: Math.round(performance.now() - started),
    note: pageNeedsToken ? "List and chapter API work; page images require a WebView Authorization token." : undefined,
    confidence: ok ? "read-flow" : "none",
    primaryCheckId: "read-pages",
    checks: [
      check("dns", "DNS", dns.ok, {
        detail: dns.detail || baseUrl,
        error: dns.error,
        latencyMs: dns.latencyMs,
        statusCode: dns.status,
      }),
      check("session", "Refresh session", sessionOk, {
        detail: session.finalUrl || `${baseUrl}/trang-chu`,
        error: session.error || (!cookie ? "Missing session cookie" : undefined),
        latencyMs: session.latencyMs,
        statusCode: session.status,
      }),
      check("read-list", "Read list", listOk, {
        count: comics.length,
        detail: `${comics.length} comics from ${listUrl}`,
        error: list.error,
        latencyMs: list.latencyMs,
        statusCode: list.status,
      }),
      check("read-detail", "Read detail", detailOk, {
        detail: detailUrl || "No GocTruyenTranhVui comic",
        error: detail?.error,
        latencyMs: detail?.latencyMs,
        statusCode: detail?.status,
      }),
      check("read-chapters", "Read chapters", chaptersOk, {
        count: chapterItems.length,
        detail: chaptersUrl || "No GocTruyenTranhVui comic id",
        error: chapters?.error,
        latencyMs: chapters?.latencyMs,
        statusCode: chapters?.status,
      }),
      check("read-pages", "Read pages", pagesOk, {
        count: images.length,
        detail: pagesUrl,
        error: pages?.error,
        latencyMs: pages?.latencyMs,
        note: pageNeedsToken ? "Pages require WebView Authorization token; extension refreshes it through WebView." : undefined,
        statusCode: pages?.status,
      }),
      check("read-image", "Read image", imageOk, {
        bytes: image.bytes,
        contentType: image.contentType,
        detail: imageUrl || coverUrl || image.finalUrl,
        error: image.error,
        latencyMs: image.latencyMs,
        statusCode: image.status,
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
  const item = items.find((entry) => entry?.slug);
  const detail = item?.slug
    ? await fetchJson(`https://otruyenapi.com/v1/api/truyen-tranh/${item.slug}`, {
        accept: "application/json",
        referer: `${source.baseUrl}/`,
      })
    : null;
  const serverData = detail?.json?.data?.item?.chapters?.[0]?.server_data || [];
  const chapter = serverData.find((entry) => entry?.chapter_api_data);
  const pages = chapter?.chapter_api_data
    ? await fetchJson(chapter.chapter_api_data, {
        accept: "application/json",
        referer: `${source.baseUrl}/`,
      })
    : null;
  const imageData = pages?.json?.data?.item;
  const firstImage = Array.isArray(imageData?.chapter_image) ? imageData.chapter_image[0] : null;
  const imageUrl = firstImage
    ? `${pages.json.data.domain_cdn}/${imageData.chapter_path}/${firstImage.image_file}`
    : "";
  const image = await checkImageReadable(imageUrl);
  const listOk = api.ok && api.json?.status === "success" && items.length > 0;
  const detailOk = Boolean(detail?.ok && detail.json?.data?.item?._id);
  const chaptersOk = Boolean(chapter?.chapter_api_data);
  const pagesOk = Boolean(pages?.ok && firstImage);
  const ok = Boolean(listOk && detailOk && chaptersOk && pagesOk && image.ok);

  return sourceResult(source, {
    ok,
    error: ok ? undefined : image.error || pages?.error || detail?.error || api.error || "OTruyen read flow failed",
    finalUrl: pages?.finalUrl || detail?.finalUrl || api.finalUrl,
    latencyMs: Math.round(performance.now() - started),
    primaryCheckId: "read-pages",
    confidence: ok ? "read-flow" : "none",
    checks: [
      check("read-list", "Read list", listOk, {
        count: items.length,
        detail: `${items.length} items from ${OTRUYEN_API_URL}`,
        error: api.error,
        latencyMs: api.latencyMs,
        statusCode: api.status,
      }),
      check("read-detail", "Read detail", detailOk, {
        detail: item?.slug ? `https://otruyenapi.com/v1/api/truyen-tranh/${item.slug}` : "No OTruyen slug",
        error: detail?.error,
        latencyMs: detail?.latencyMs,
        statusCode: detail?.status,
      }),
      check("read-chapters", "Read chapters", chaptersOk, {
        detail: chapter?.chapter_api_data || "No chapter API",
        latencyMs: detail?.latencyMs,
        statusCode: detail?.status,
      }),
      check("read-pages", "Read pages", pagesOk, {
        count: imageData?.chapter_image?.length || 0,
        detail: chapter?.chapter_api_data || "No pages",
        error: pages?.error,
        latencyMs: pages?.latencyMs,
        statusCode: pages?.status,
      }),
      check("read-image", "Read image", image.ok, {
        bytes: image.bytes,
        contentType: image.contentType,
        detail: imageUrl || image.finalUrl,
        error: image.error,
        latencyMs: image.latencyMs,
        statusCode: image.status,
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
  const accessCheck = check("access-page", "CuuTruyen access page", access.ok && candidates.length > 0, {
    count: candidates.length,
    detail: candidates.length ? `${candidates.length} candidate domains` : CUUTRUYEN_ACCESS_URL,
    error: access.error,
    latencyMs: access.latencyMs,
    statusCode: access.status,
  });

  const list = await firstReachable(candidates, (baseUrl) =>
    fetchJson(`${baseUrl}${CUUTRUYEN_API_PATH}`, {
      accept: "application/json",
      referer: `${baseUrl}/`,
    }),
  );
  const mangas = Array.isArray(list.result?.json?.data) ? list.result.json.data : [];
  const manga = mangas.find((item) => item?.id != null);
  const baseUrl = list.baseUrl || candidates[0] || source.baseUrl;

  const detail = manga
    ? await fetchJson(`${baseUrl}/api/v2/mangas/${manga.id}`, {
        accept: "application/json",
        referer: `${baseUrl}/`,
      })
    : null;
  const chapters = manga
    ? await fetchJson(`${baseUrl}/api/v2/mangas/${manga.id}/chapters`, {
        accept: "application/json",
        referer: `${baseUrl}/`,
      })
    : null;
  const chapterItems = Array.isArray(chapters?.json?.data) ? chapters.json.data : [];
  const chapter = chapterItems.find((item) => item?.id != null);
  const pages = chapter
    ? await fetchJson(`${baseUrl}/api/v2/chapters/${chapter.id}`, {
        accept: "application/json",
        referer: `${baseUrl}/`,
      })
    : null;
  const pageItems = Array.isArray(pages?.json?.data?.pages) ? pages.json.data.pages : [];
  const page = pageItems.find((item) => typeof item?.image_url === "string" && item.image_url);
  const imageUrl = page ? normalizeCuuTruyenImageUrl(page.image_url) : null;
  const image = page
    ? await timedFetch(imageUrl, {
        headers: {
          accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          referer: `${baseUrl}/`,
        },
        timeoutMs: SOURCE_TIMEOUT_MS,
      })
    : null;

  const listOk = Boolean(list.result?.ok && mangas.length > 0 && manga);
  const detailOk = Boolean(detail?.ok && detail.json?.data?.id != null);
  const chaptersOk = Boolean(chapters?.ok && chapterItems.length > 0 && chapter);
  const pagesOk = Boolean(pages?.ok && pageItems.length > 0 && page);
  const imageOk = Boolean(image?.ok && image.bytes > 0 && image.contentType?.startsWith("image/"));
  const ok = listOk && detailOk && chaptersOk && pagesOk && imageOk;
  const transportResults = [list.result, detail, chapters, pages, image].filter(Boolean);
  const inconclusive = Boolean(
    !ok &&
    access.ok &&
    candidates.length > 0 &&
    transportResults.some((result) => result.status === 0) &&
    transportResults.every((result) => result.ok || result.status === 0),
  );

  return sourceResult(source, {
    ok,
    error: ok || inconclusive
      ? undefined
      : image?.error || pages?.error || chapters?.error || detail?.error || list.result?.error || access.error || "CuuTruyen read flow failed",
    finalUrl: image?.finalUrl || pages?.finalUrl || chapters?.finalUrl || detail?.finalUrl || list.result?.finalUrl || access.finalUrl,
    latencyMs: Math.round(performance.now() - started),
    note: inconclusive ? "Máy kiểm tra không hoàn tất được kết nối TLS; extension dùng Chromium WebView cho luồng CuuTruyen." : undefined,
    confidence: ok ? "high" : "none",
    inconclusive,
    primaryCheckId: "read-pages",
    checks: [
      accessCheck,
      check("read-list", "CuuTruyen manga list", listOk, {
        count: mangas.length,
        detail: list.baseUrl || baseUrl,
        error: list.result?.error,
        latencyMs: list.result?.latencyMs,
        statusCode: list.result?.status,
      }),
      check("read-detail", "CuuTruyen manga detail", detailOk, {
        detail: manga ? `${baseUrl}/api/v2/mangas/${manga.id}` : "No manga returned",
        error: detail?.error,
        latencyMs: detail?.latencyMs,
        statusCode: detail?.status,
      }),
      check("read-chapters", "CuuTruyen chapters", chaptersOk, {
        count: chapterItems.length,
        detail: chapter ? `${baseUrl}/api/v2/mangas/${manga.id}/chapters` : "No chapter returned",
        error: chapters?.error,
        latencyMs: chapters?.latencyMs,
        statusCode: chapters?.status,
      }),
      check("read-pages", "CuuTruyen pages", pagesOk, {
        count: pageItems.length,
        detail: chapter ? `${baseUrl}/api/v2/chapters/${chapter.id}` : "No chapter returned",
        error: pages?.error,
        latencyMs: pages?.latencyMs,
        statusCode: pages?.status,
      }),
      check("read-image", "CuuTruyen image", imageOk, {
        bytes: image?.bytes,
        detail: imageUrl,
        error: image?.error,
        latencyMs: image?.latencyMs,
        statusCode: image?.status,
      }),
    ],
  });
}

async function checkCuuTruyenMoeSource(source) {
  const started = performance.now();
  const baseUrl = source.baseUrl?.replace(/\/$/, "");
  const dns = await timedDnsLookup(baseUrl);
  const listUrl = `${baseUrl}/tim-kiem?sort=-views&filter%5Bstatus%5D=2,1&page=1`;
  const list = await fetchHtml(listUrl, { referer: `${baseUrl}/` });
  const discontinued = /ng(?:u|ừ)ng cung c(?:a|ấ)p d(?:i|ị)ch v(?:u|ụ)|ngừng cung cấp dịch vụ/i.test(list.body || "");
  const mangaLinks = extractHtmlLinks(list.body, list.finalUrl || listUrl)
    .filter((url) => sameSiteUrl(url, list.finalUrl || listUrl) && /\/truyen\//i.test(new URL(url).pathname));
  const listOk = Boolean(list.ok && !discontinued && mangaLinks.length > 0);

  return sourceResult(source, {
    ok: false,
    error: discontinued ? "Service discontinued gate page" : list.error || "CuuTruyen Moe read flow failed",
    finalUrl: list.finalUrl || baseUrl,
    latencyMs: Math.round(performance.now() - started),
    note: discontinued ? "The site returns a discontinued-service gate page, not a readable manga list." : undefined,
    confidence: "none",
    primaryCheckId: "read-pages",
    checks: [
      check("dns", "DNS", dns.ok, {
        detail: dns.detail || baseUrl,
        error: dns.error,
        latencyMs: dns.latencyMs,
        statusCode: dns.status,
      }),
      check("read-list", "Read list", listOk, {
        count: mangaLinks.length,
        detail: listUrl,
        error: discontinued ? "Service discontinued gate page" : list.error,
        latencyMs: list.latencyMs,
        statusCode: list.status,
      }),
    ],
  });
}

function normalizeMinoImageUrl(url) {
  if (!url) return "";
  if (url.startsWith("//")) return `https:${url}`;
  return url;
}

function selectMinoImageServer(servers = []) {
  return (
    servers.find((server) => {
      try {
        const host = new URL(normalizeMinoImageUrl(server.imageUrl)).host;
        return host && !host.includes("ibyteimg.com");
      } catch {
        return false;
      }
    }) ||
    servers[0] ||
    null
  );
}

async function checkImageReadable(imageUrl, headers = {}) {
  if (!imageUrl) {
    return {
      ok: false,
      error: "Missing image URL",
      latencyMs: 0,
      status: 0,
    };
  }

  let result = await timedFetch(imageUrl, {
    headers: {
      accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      ...headers,
    },
    method: "HEAD",
    readBody: false,
    timeoutMs: SOURCE_TIMEOUT_MS,
  });

  if (result.status === 405 || result.status === 403 || result.status === 0) {
    result = await timedFetch(imageUrl, {
      headers: {
        accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        ...headers,
      },
      method: "GET",
      readBody: false,
      timeoutMs: SOURCE_TIMEOUT_MS,
    });
  }

  return {
    ...result,
    ok: Boolean(result.ok && (!result.contentType || result.contentType.startsWith("image/"))),
  };
}

async function checkMinoCategory(category) {
  const listUrl = `${MINO_API_URL}/books?take=6&page=1&category=${category}`;
  const list = await fetchJson(listUrl, {
    accept: "application/json",
    origin: "https://minotruyenv7.xyz",
    referer: "https://minotruyenv7.xyz/",
  });
  const books = Array.isArray(list.json?.data?.books) ? list.json.data.books : [];
  const listOk = Boolean(list.ok && books.length > 0);

  let detail = null;
  let chapters = null;
  let pages = null;
  let image = null;
  let selectedBook = null;
  let selectedChapter = null;

  for (const book of books) {
    const bookId = book?.bookId;
    if (!bookId) continue;

    detail = await fetchJson(`${MINO_API_URL}/books/${bookId}`, {
      accept: "application/json",
      origin: "https://minotruyenv7.xyz",
      referer: "https://minotruyenv7.xyz/",
    });
    const detailBook = detail.json?.data?.book;
    const detailOk = Boolean(detail.ok && detailBook?.bookId);
    if (!detailOk) continue;

    chapters = await fetchJson(`${MINO_API_URL}/books/${bookId}/chapters?order=desc&take=10`, {
      accept: "application/json",
      origin: "https://minotruyenv7.xyz",
      referer: "https://minotruyenv7.xyz/",
    });
    const chapterItems = Array.isArray(chapters.json?.data?.chapters) ? chapters.json.data.chapters : [];
    selectedChapter = chapterItems.find((chapter) => chapter?.chapterId);
    if (!chapters.ok || !selectedChapter) continue;

    pages = await fetchJson(`${MINO_API_URL}/books/${bookId}/chapters/${selectedChapter.chapterId}`, {
      accept: "application/json",
      origin: "https://minotruyenv7.xyz",
      referer: "https://minotruyenv7.xyz/",
    });
    const pageItems = Array.isArray(pages.json?.data?.chapter?.images) ? pages.json.data.chapter.images : [];
    const firstPage = pageItems
      .slice()
      .sort((left, right) => Number(left.order || 0) - Number(right.order || 0))
      .find((item) => Array.isArray(item?.servers) && item.servers.length > 0);
    const server = selectMinoImageServer(firstPage?.servers);
    image = await checkImageReadable(normalizeMinoImageUrl(server?.imageUrl || ""));

    selectedBook = book;
    if (image.ok) break;
  }

  const detailOk = Boolean(detail?.ok && detail.json?.data?.book?.bookId);
  const chapterItems = Array.isArray(chapters?.json?.data?.chapters) ? chapters.json.data.chapters : [];
  const pageItems = Array.isArray(pages?.json?.data?.chapter?.images) ? pages.json.data.chapter.images : [];
  const chaptersOk = Boolean(chapters?.ok && chapterItems.length > 0);
  const pagesOk = Boolean(pages?.ok && pageItems.length > 0);
  const imageOk = Boolean(image?.ok);
  const ok = Boolean(listOk && detailOk && chaptersOk && pagesOk && imageOk);

  return {
    category,
    ok,
    selectedBook,
    selectedChapter,
    checks: [
      check(`mino-list-${category}`, `Mino list ${category}`, listOk, {
        count: books.length,
        detail: `${books.length} books from ${listUrl}`,
        error: list.error,
        latencyMs: list.latencyMs,
        statusCode: list.status,
      }),
      check(`mino-detail-${category}`, `Mino detail ${category}`, detailOk, {
        detail: selectedBook?.bookId ? `${MINO_API_URL}/books/${selectedBook.bookId}` : "No readable book detail",
        error: detail?.error,
        latencyMs: detail?.latencyMs,
        statusCode: detail?.status,
      }),
      check(`mino-chapters-${category}`, `Mino chapters ${category}`, chaptersOk, {
        count: chapterItems.length,
        detail: selectedBook?.bookId ? `${chapterItems.length} chapters from book ${selectedBook.bookId}` : "No chapters",
        error: chapters?.error,
        latencyMs: chapters?.latencyMs,
        statusCode: chapters?.status,
      }),
      check(`mino-pages-${category}`, `Mino pages ${category}`, pagesOk, {
        count: pageItems.length,
        detail: selectedChapter?.chapterId ? `${pageItems.length} pages from chapter ${selectedChapter.chapterId}` : "No pages",
        error: pages?.error,
        latencyMs: pages?.latencyMs,
        statusCode: pages?.status,
      }),
      check(`mino-image-${category}`, `Mino image ${category}`, imageOk, {
        bytes: image?.bytes,
        contentType: image?.contentType,
        detail: image?.finalUrl,
        error: image?.error || (!imageOk && image?.contentType ? `Unexpected content-type ${image.contentType}` : undefined),
        latencyMs: image?.latencyMs,
        statusCode: image?.status,
      }),
    ],
  };
}

async function checkMinoTruyenSource(source) {
  const started = performance.now();
  const results = await runLimited(MINO_CATEGORIES, 2, checkMinoCategory);
  const ok = results.every((result) => result.ok);
  const failed = results.find((result) => !result.ok);

  return sourceResult(source, {
    ok,
    error: ok ? undefined : `${failed?.category || "MinoTruyen"} read flow failed`,
    finalUrl: MINO_API_URL,
    latencyMs: Math.round(performance.now() - started),
    confidence: ok ? "read-flow" : "none",
    primaryCheckId: "read-pages",
    checks: results.flatMap((result) => result.checks),
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

function normalizeCuuTruyenImageUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.hostname === "storage-ct.lrclib.net") {
      url.hostname = "storage-bravo.cuutruyen.net";
    }
    return url.toString();
  } catch {
    return rawUrl;
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

  if (level === "healthy") return `Tất cả ${totalSources} nguồn đang hoạt động.`;
  if (level === "degraded") return `${workingSources}/${totalSources} nguồn đang hoạt động.`;
  return `0/${totalSources} nguồn đang hoạt động.`;
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
  const previousStatus = await readPreviousStatus();
  const sourceEntries = flattenSources(index);
  const genericSourceEntries = sourceEntries.filter((source) => !sourceSpecificChecker(source));
  const uniqueBaseUrls = [...new Set(genericSourceEntries.map((source) => source.baseUrl).filter(Boolean))];

  const baseUrlChecks = await runLimited(uniqueBaseUrls, SOURCE_CONCURRENCY, async (baseUrl) => [
    baseUrl,
    await checkBaseUrl(baseUrl),
  ]);
  const baseUrlResults = new Map(baseUrlChecks);
  const rawSources = await runLimited(sourceEntries, SOURCE_CONCURRENCY, (source) =>
    checkSource(source, baseUrlResults),
  );
  const sources = applySourceHistory(rawSources, previousStatus, checkedAt).map((source, index) => {
    const rawSource = rawSources[index];
    return source.ok
      ? source
      : {
          ...source,
          error: rawSource.error,
          note: source.note || rawSource.note,
          ok: false,
          status: source.status || "error",
        };
  });
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
    checkPolicy: {
      failureThreshold: FAILURE_THRESHOLD,
      signals: ["dns", "base-url", "source-api", "read-flow", "history"],
    },
    stats: {
      totalExtensions: index.length,
      totalSources: sources.length,
      workingSources,
      errorSources: sources.length - workingSources,
      warningSources: sources.filter((item) => item.status === "warning").length,
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
    summary: "Bộ kiểm tra trạng thái lỗi trước khi hoàn tất.",
  };

  await fs.writeFile("status.json", `${JSON.stringify(payload, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
});
