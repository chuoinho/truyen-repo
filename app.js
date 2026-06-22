const OWNER = "chuoinho";
const REPO = "truyen-repo";
const BRANCH = "repo";
const RAW_BASE = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}`;
const GITHUB_BASE = `https://github.com/${OWNER}/${REPO}/tree/${BRANCH}`;
const REPO_URL = `${RAW_BASE}/index.min.json`;
const INDEX_PB_URL = `${RAW_BASE}/index.pb`;
const REPO_JSON_URL = `${RAW_BASE}/repo.json`;
const STATUS_URL = "status.json";
const INSTALL_URL = `tachiyomi://add-repo?url=${encodeURIComponent(REPO_URL)}`;

const $ = (selector) => document.querySelector(selector);

function setText(selector, value) {
  const element = $(selector);
  if (element) element.textContent = value;
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
  return String(name || "").replace(/^Tachiyomi:\s*/i, "");
}

function flattenIndexSources(index) {
  return (index || []).flatMap((extension) =>
    (extension.sources || []).map((source, sourceIndex) => ({
      id: source.id || `${extension.pkg || extension.name}:${sourceIndex}`,
      name: source.name || cleanExtensionName(extension.name),
      baseUrl: source.baseUrl,
      extensionName: cleanExtensionName(extension.name),
      package: extension.pkg,
      ok: null,
      status: "unknown",
      checks: [],
    })),
  );
}

function formatDate(value) {
  if (!value) return "Chua co du lieu";
  return new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(value));
}

function formatMs(value) {
  if (!Number.isFinite(value)) return "--";
  if (value < 1000) return `${value} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

function statusLabel(level) {
  if (level === "healthy") return "working";
  if (level === "degraded") return "partial";
  if (level === "down") return "error";
  return "loading";
}

function statusForCheck(ok) {
  return ok ? "working" : "error";
}

function renderIndex(index) {
  const sources = flattenIndexSources(index);
  setText("#sourceCount", `${sources.length}`);
  setText("#workingCount", "--");
  $("#apkLink").href = `${GITHUB_BASE}/apk`;
}

function renderCheckList(container, checks) {
  clear(container);

  if (!checks?.length) {
    container.append(el("p", "empty", "Chua co du lieu kiem tra."));
    return;
  }

  checks.forEach((item) => {
    const row = el("div", "check-row");
    row.dataset.ok = String(Boolean(item.ok));

    const main = el("div", "check-main");
    main.append(el("strong", "", item.name || item.id));
    const detail = item.detail || item.error || `HTTP ${item.statusCode || "--"}`;
    main.append(el("span", "", detail));

    const meta = el("div", "check-meta");
    meta.append(el("span", "badge", item.status || statusForCheck(item.ok)));
    if (item.statusCode !== undefined) meta.append(el("span", "", `HTTP ${item.statusCode}`));
    meta.append(el("span", "", formatMs(item.latencyMs)));

    row.append(main, meta);
    container.append(row);
  });
}

function renderSources(sources) {
  const container = $("#sourceList");
  clear(container);

  if (!sources?.length) {
    container.append(el("p", "empty", "Chua co du lieu source."));
    return;
  }

  const sortedSources = [...sources].sort((a, b) => {
    if (Boolean(a.ok) !== Boolean(b.ok)) return a.ok ? 1 : -1;
    return String(a.name).localeCompare(String(b.name), "vi");
  });

  sortedSources.forEach((source) => {
    const item = el("article", "source-item");
    item.dataset.ok = String(Boolean(source.ok));

    const head = el("div", "source-head");
    const title = el("div");
    title.append(el("strong", "", source.name || "Unknown source"));
    title.append(
      el(
        "span",
        "",
        [source.extensionName || source.package, source.baseUrl || "No base URL"]
          .filter(Boolean)
          .join(" · "),
      ),
    );
    const badge = el("span", "badge", source.status || statusForCheck(source.ok));
    head.append(title, badge);

    const baseCheck = source.checks?.find((checkItem) => checkItem.id === "base-url");
    const sample = el("p", "sample");
    sample.textContent = source.ok
      ? `working · HTTP ${baseCheck?.statusCode || "--"} · ${formatMs(source.latencyMs)}`
      : `error · ${source.error || baseCheck?.error || `HTTP ${baseCheck?.statusCode || "--"}`}`;

    const checks = el("div", "check-list compact");
    renderCheckList(checks, source.checks || []);

    item.append(head, sample, checks);
    container.append(item);
  });
}

function renderQuickInfo(status, index) {
  const fallbackSources = flattenIndexSources(index);
  const stats = status?.stats || {};
  const totalSources = stats.totalSources ?? status?.sources?.length ?? fallbackSources.length;
  const workingSources =
    stats.workingSources ?? status?.sources?.filter((source) => source.ok).length ?? 0;

  setText("#sourceCount", `${totalSources}`);
  setText("#workingCount", `${workingSources}/${totalSources}`);
  setText("#checkedAt", formatDate(status?.checkedAt));
  setText("#durationMs", formatMs(status?.durationMs));
  setText("#footerNote", `Last check: ${formatDate(status?.checkedAt)}`);
}

function renderStatus(status, index) {
  const level = status?.level || "unknown";
  $("#statusBox").dataset.level = level;
  setText("#statusText", statusLabel(level));
  setText("#statusSummary", status?.summary || "Chua doc duoc status.json.");
  renderQuickInfo(status, index);
  renderSources(status?.sources || flattenIndexSources(index));
  renderCheckList($("#repoChecks"), status?.repository?.checks || status?.repo?.checks || []);
}

async function loadJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function hydrate() {
  $("#repoUrlText").textContent = REPO_URL;
  $("#installLink").href = INSTALL_URL;
  $("#indexJsonLink").href = REPO_URL;
  $("#indexPbLink").href = INDEX_PB_URL;
  $("#repoJsonLink").href = REPO_JSON_URL;
  $("#statusJsonLink").href = STATUS_URL;

  let index = [];
  try {
    index = await loadJson(REPO_URL);
  } catch {
    index = [];
  }
  renderIndex(index);

  try {
    renderStatus(await loadJson(STATUS_URL), index);
  } catch (error) {
    renderStatus(
      {
        level: "unknown",
        summary: `Khong doc duoc status.json: ${error.message}`,
        sources: flattenIndexSources(index),
        repository: { checks: [] },
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
    button.textContent = "Copied";
  } catch {
    button.textContent = "Copy failed";
  }

  setTimeout(() => {
    button.textContent = original;
  }, 1400);
}

$("#copyButton").addEventListener("click", copyRepoUrl);
hydrate();
