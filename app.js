const OWNER = "chuoinho";
const REPO = "truyen-repo";
const BRANCH = "repo";
const RAW_BASE = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}`;
const REPO_URL = `${RAW_BASE}/index.min.json`;
const LOCAL_INDEX_URL = "index.min.json";
const STATUS_URL = "status.json";
const INSTALL_URL = `tachiyomi://add-repo?url=${encodeURIComponent(REPO_URL)}`;

const state = {
  extensions: [],
  filter: "all",
  query: "",
};

const $ = (selector) => document.querySelector(selector);

function setText(selector, value) {
  const element = $(selector);
  if (element) element.textContent = value;
}

function setHref(selector, value) {
  const element = $(selector);
  if (element) element.href = value;
}

function clear(element) {
  if (element) element.replaceChildren();
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function cleanExtensionName(name) {
  return String(name || "Không rõ").replace(/^Tachiyomi:\s*/i, "");
}

function normalizePackage(extension) {
  return extension.package || extension.pkg || "";
}

function normalizeIndex(index) {
  return (index || []).map((extension) => ({
    apk: extension.apk,
    code: extension.code,
    lang: extension.lang,
    name: cleanExtensionName(extension.name),
    nsfw: Number(extension.nsfw) === 1,
    package: normalizePackage(extension),
    sourceCount: extension.sourceCount ?? extension.sources?.length ?? 0,
    version: extension.version,
    sources: (extension.sources || []).map((source, sourceIndex) => ({
      id: String(source.id || `${normalizePackage(extension)}:${sourceIndex}`),
      name: source.name || cleanExtensionName(extension.name),
      baseUrl: source.baseUrl,
      lang: source.lang || extension.lang,
      nsfw: Number(source.nsfw ?? extension.nsfw) === 1,
      package: normalizePackage(extension),
      apk: extension.apk,
      extensionName: cleanExtensionName(extension.name),
      extensionVersion: extension.version,
      versionId: source.versionId,
      ok: null,
      status: "unknown",
      checks: [],
    })),
  }));
}

function formatDate(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

function formatMs(value) {
  if (!Number.isFinite(value)) return "--";
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

function statusLabel(level) {
  if (level === "healthy") return "hoạt động";
  if (level === "degraded") return "cảnh báo";
  if (level === "down") return "lỗi";
  if (level === "loading") return "đang tải";
  return "chưa rõ";
}

function statusText(status) {
  if (status === "working") return "hoạt động";
  if (status === "warning") return "cảnh báo";
  if (status === "error") return "lỗi";
  return "chưa rõ";
}

function statusSummaryText(level, workingSources, totalSources) {
  if (!totalSources) return "Chưa có dữ liệu trạng thái.";
  if (level === "healthy") return `Tất cả ${totalSources} nguồn đang hoạt động.`;
  if (level === "degraded") return `${workingSources}/${totalSources} nguồn đang hoạt động.`;
  if (level === "down") return `0/${totalSources} nguồn đang hoạt động.`;
  return "Chưa xác định được trạng thái nguồn.";
}

function translateNote(value) {
  if (!value) return "";
  if (value.includes("blocks this status runner")) {
    return value.replace(
      /Site is reachable but blocks this status runner with HTTP (\d+)\./,
      "Trang vẫn truy cập được nhưng chặn máy kiểm tra với HTTP $1.",
    );
  }
  if (value.includes("CDN/access page reachable")) {
    return "Trang truy cập/CDN còn hoạt động; API dữ liệu có thể bị chặn từ máy kiểm tra.";
  }
  return translateDetail(value);
}

function translateCheckName(value) {
  if (value === "Base URL") return "URL gốc";
  if (value === "CuuTruyen access page") return "Trang truy cập CuuTruyen";
  if (value === "Cloudflare trace") return "Cloudflare trace";
  if (value === "CuuTruyen API") return "API CuuTruyen";
  if (value === "OTruyen API") return "API OTruyen";
  return value || "Kiểm tra";
}

function translateDetail(value) {
  if (!value) return "";
  return String(value)
    .replace(/(\d+) candidate domains/g, "$1 tên miền ứng viên")
    .replace(/(\d+) items from/g, "$1 mục từ")
    .replace(/fetch failed/g, "kết nối thất bại")
    .replace(/Request timed out/g, "quá thời gian phản hồi")
    .replace(/Invalid JSON/g, "JSON không hợp lệ")
    .replace(/No detail/g, "Không có chi tiết");
}

function statusFromSource(source) {
  if (source.ok === false) return "error";
  if (source.note || source.status === "warning") return "warning";
  if (source.ok === true) return "working";
  return "unknown";
}

function statusFromSources(sources) {
  if (sources.some((source) => statusFromSource(source) === "error")) return "error";
  if (sources.some((source) => statusFromSource(source) === "warning")) return "warning";
  if (sources.some((source) => statusFromSource(source) === "working")) return "working";
  return "unknown";
}

function statusWeight(status) {
  return { error: 0, warning: 1, unknown: 2, working: 3 }[status] ?? 2;
}

function mergeStatus(index, status) {
  const indexExtensions = normalizeIndex(index);
  const statusSourceList = status?.sources || [];
  const sourcesByPackage = new Map();
  statusSourceList.forEach((source) => {
    const packageName = normalizePackage(source);
    if (!packageName) return;
    if (!sourcesByPackage.has(packageName)) sourcesByPackage.set(packageName, []);
    sourcesByPackage.get(packageName).push(source);
  });
  const statusIndex = normalizeIndex(
    (status?.extensions || []).map((extension) => ({
      ...extension,
      pkg: normalizePackage(extension),
      sources: sourcesByPackage.get(normalizePackage(extension)) || [],
    })),
  );
  const baseExtensions = indexExtensions.length ? indexExtensions : statusIndex;
  const statusExtensions = status?.extensions || [];
  const statusSources = new Map(statusSourceList.map((source) => [String(source.id), source]));
  const extensionMeta = new Map(
    statusExtensions.map((extension) => [normalizePackage(extension), extension]),
  );

  return baseExtensions.map((extension) => {
    const meta = extensionMeta.get(extension.package) || {};
    const fallbackSources = sourcesByPackage.get(extension.package) || [];
    const baseSources = extension.sources.length ? extension.sources : fallbackSources;
    const sources = baseSources.map((source) => ({
      ...source,
      ...(statusSources.get(String(source.id)) || {}),
    }));
    const sourceCount = sources.length || meta.sourceCount || extension.sourceCount || 0;
    const next = {
      ...extension,
      ...meta,
      name: cleanExtensionName(meta.name || extension.name),
      nsfw: Number(meta.nsfw ?? extension.nsfw) === 1 || Boolean(extension.nsfw),
      package: normalizePackage(meta) || extension.package,
      sourceCount,
      sources,
    };
    next.status = statusFromSources(sources);
    next.warningCount = sources.filter((source) => statusFromSource(source) === "warning").length;
    next.errorCount = sources.filter((source) => statusFromSource(source) === "error").length;
    return next;
  });
}

function matchesQuery(extension, query) {
  if (!query) return true;
  const haystack = [
    extension.name,
    extension.package,
    extension.apk,
    extension.version,
    ...extension.sources.flatMap((source) => [
      source.name,
      source.baseUrl,
      source.finalUrl,
      source.note,
      source.error,
    ]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

function matchesFilter(extension, filter) {
  if (filter === "all") return true;
  if (filter === "nsfw") return Boolean(extension.nsfw);
  return extension.status === filter;
}

function filteredExtensions() {
  const query = state.query.trim().toLowerCase();
  return state.extensions
    .filter((extension) => matchesFilter(extension, state.filter))
    .filter((extension) => matchesQuery(extension, query))
    .sort((a, b) => {
      const statusDiff = statusWeight(a.status) - statusWeight(b.status);
      if (statusDiff !== 0) return statusDiff;
      return String(a.name).localeCompare(String(b.name), "vi");
    });
}

function sourceChip(source) {
  const stateName = statusFromSource(source);
  const chip = el("span", "source-chip");
  chip.dataset.state = stateName;

  chip.append(el("span", "source-state"));
  const text = el("span");
  text.append(el("strong", "", source.name || "Nguồn chưa rõ"));
  text.append(el("span", "", source.baseUrl || "Chưa có URL gốc"));
  chip.append(text);

  return chip;
}

function badge(status) {
  const node = el("span", "badge", statusText(status));
  node.dataset.status = status;
  return node;
}

function renderCheckGrid(checks) {
  const grid = el("div", "check-grid");

  if (!checks?.length) {
    grid.append(el("div", "check-row", "Chưa có dữ liệu kiểm tra."));
    return grid;
  }

  checks.forEach((check) => {
    const row = el("div", "check-row");
    const name = el("strong", "", translateCheckName(check.name || check.id));
    const status = badge(check.status || (check.ok ? "working" : "error"));
    const detail = el(
      "span",
      "check-detail",
      [translateDetail(check.detail || check.error || "Không có chi tiết"), `HTTP ${check.statusCode ?? "--"}`, formatMs(check.latencyMs)]
        .filter(Boolean)
        .join(" - "),
    );

    row.append(name, status, detail);
    grid.append(row);
  });

  return grid;
}

function renderDetails(extension) {
  const details = el("div", "extension-details");

  const notes = extension.sources
    .map((source) => source.note || source.error)
    .filter(Boolean);
  if (notes.length) {
    details.append(el("p", "extension-note", notes.map(translateNote).join(" ")));
  }

  extension.sources.forEach((source) => {
    const detail = el("div", "source-detail");
    detail.append(el("h3", "", source.name || "Nguồn chưa rõ"));
    detail.append(
      el(
        "p",
        "",
        [source.baseUrl, source.finalUrl && source.finalUrl !== source.baseUrl ? `Chuyển tới: ${source.finalUrl}` : ""]
          .filter(Boolean)
          .join(" - "),
      ),
    );
    detail.append(renderCheckGrid(source.checks || []));
    details.append(detail);
  });

  return details;
}

function renderExtension(extension) {
  const item = el("article", "extension-item");
  item.dataset.status = extension.status;

  const main = el("div", "extension-main");
  const title = el("div", "extension-title");
  const icon = el("img");
  icon.src = `icon/${extension.package}.png`;
  icon.alt = "";
  icon.loading = "lazy";
  icon.addEventListener("error", () => {
    icon.src = "assets/minotruyen.png";
  });

  const titleText = el("div");
  titleText.append(el("strong", "", extension.name));
  titleText.append(
    el(
      "span",
      "",
      [
        extension.version ? `v${extension.version}` : "",
        `${extension.sourceCount} nguồn`,
      ]
        .filter(Boolean)
        .join(" - "),
    ),
  );
  title.append(icon, titleText);

  const chips = el("div", "source-chips");
  extension.sources.forEach((source) => chips.append(sourceChip(source)));

  const actions = el("div", "extension-actions");
  const detailsButton = el("button", "details-toggle", "Chi tiết");
  detailsButton.type = "button";
  detailsButton.addEventListener("click", () => {
    const open = item.classList.toggle("open");
    detailsButton.textContent = open ? "Ẩn" : "Chi tiết";
  });
  actions.append(badge(extension.status), detailsButton);

  main.append(title, chips, actions);
  item.append(main, renderDetails(extension));

  return item;
}

function renderExtensions() {
  const container = $("#extensionList");
  clear(container);

  const visible = filteredExtensions();
  const totalSources = state.extensions.reduce((sum, extension) => sum + extension.sourceCount, 0);
  setText(
    "#extensionSummary",
    `${state.extensions.length} tiện ích, ${totalSources} nguồn. Đang hiển thị ${visible.length}.`,
  );

  if (!visible.length) {
    container.append(el("p", "empty", "Không có tiện ích phù hợp."));
    return;
  }

  visible.forEach((extension) => container.append(renderExtension(extension)));
}

function renderStatus(status, index) {
  const level = status?.level || "unknown";
  const statusBox = $("#status");
  if (statusBox) statusBox.dataset.level = level;

  const stats = status?.stats || {};
  const merged = mergeStatus(index, status);
  const totalSources = stats.totalSources ?? merged.reduce((sum, extension) => sum + extension.sourceCount, 0);
  const workingSources =
    stats.workingSources ??
    merged.reduce(
      (sum, extension) =>
        sum + extension.sources.filter((source) => statusFromSource(source) === "working").length,
      0,
    );
  const warningSources =
    stats.warningSources ??
    merged.reduce((sum, extension) => sum + extension.warningCount, 0);

  state.extensions = merged;

  setText("#statusText", statusLabel(level));
  setText("#workingCount", `${workingSources}/${totalSources}`);
  setText("#statusSummary", statusSummaryText(level, workingSources, totalSources));
  setText("#warningCount", `${warningSources}`);
  setText("#checkedAt", formatDate(status?.checkedAt));
  setText("#intervalHours", status?.intervalHours ? `${status.intervalHours}h` : "--");
  setText("#durationMs", status?.durationMs ? `Kiểm tra trong ${formatMs(status.durationMs)}` : "--");
  setText("#footerNote", `Trạng thái cập nhật mỗi ${status?.intervalHours || 12} giờ.`);

  renderExtensions();
}

async function loadJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function hydrate() {
  $("#repoUrlText").textContent = REPO_URL;
  setHref("#installLink", INSTALL_URL);
  setHref("#navInstallLink", INSTALL_URL);

  let index = [];
  try {
    index = await loadJson(LOCAL_INDEX_URL);
  } catch {
    index = [];
  }

  try {
    renderStatus(await loadJson(STATUS_URL), index);
  } catch (error) {
    renderStatus(
      {
        level: "unknown",
        summary: `Không đọc được status.json: ${error.message}`,
        sources: [],
        stats: {},
      },
      index,
    );
  }
}

async function copyRepoUrl() {
  const button = $("#copyButton");
  const original = button.textContent;

  try {
    await navigator.clipboard.writeText(REPO_URL);
    button.textContent = "Đã sao chép";
  } catch {
    button.textContent = "Không sao chép được";
  }

  setTimeout(() => {
    button.textContent = original;
  }, 1400);
}

$("#copyButton").addEventListener("click", copyRepoUrl);
$("#searchInput").addEventListener("input", (event) => {
  state.query = event.currentTarget.value;
  renderExtensions();
});

document.querySelectorAll(".filter-button").forEach((button) => {
  button.addEventListener("click", () => {
    document
      .querySelectorAll(".filter-button")
      .forEach((filterButton) => filterButton.classList.remove("active"));
    button.classList.add("active");
    state.filter = button.dataset.filter || "all";
    renderExtensions();
  });
});

hydrate();
