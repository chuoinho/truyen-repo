const OWNER = "chuoinho";
const REPO = "truyen-repo";
const BRANCH = "repo";
const RAW_BASE = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}`;
const REPO_URL = `${RAW_BASE}/index.min.json`;
const INDEX_PB_URL = `${RAW_BASE}/index.pb`;
const REPO_JSON_URL = `${RAW_BASE}/repo.json`;
const STATUS_URL = "status.json";
const INSTALL_URL = `tachiyomi://add-repo?url=${encodeURIComponent(REPO_URL)}`;

const fallbackIndex = [
  {
    name: "Tachiyomi: MinoTruyen",
    pkg: "eu.kanade.tachiyomi.extension.vi.minotruyen",
    apk: "tachiyomi-vi.minotruyen-v1.4.5.apk",
    lang: "vi",
    code: 5,
    version: "1.4.5",
    nsfw: 1,
  },
];

const $ = (selector) => document.querySelector(selector);

function setText(selector, value) {
  const element = $(selector);
  if (element) element.textContent = value;
}

function clear(element) {
  element.replaceChildren();
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatDate(value) {
  if (!value) return "Chưa có dữ liệu";
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
  if (level === "healthy") return "Đang hoạt động";
  if (level === "degraded") return "Lỗi một phần";
  if (level === "down") return "Không hoạt động";
  return "Chưa có dữ liệu";
}

function statusForCheck(ok) {
  return ok ? "OK" : "Lỗi";
}

function renderIndex(index) {
  const extension = index[0] || fallbackIndex[0];
  setText("#extensionName", extension.name?.replace("Tachiyomi: ", "") || "MinoTruyen");
  setText("#extensionVersion", extension.version || "--");
  $("#apkLink").href = `${RAW_BASE}/apk/${extension.apk}`;
}

function renderCheckList(container, checks) {
  clear(container);

  if (!checks?.length) {
    container.append(el("p", "empty", "Chưa có dữ liệu kiểm tra."));
    return;
  }

  checks.forEach((item) => {
    const row = el("div", "check-row");
    row.dataset.ok = String(Boolean(item.ok));

    const main = el("div", "check-main");
    main.append(el("strong", "", item.name || item.id));
    const detail = item.detail || `HTTP ${item.status || "--"}`;
    main.append(el("span", "", detail));

    const meta = el("div", "check-meta");
    meta.append(el("span", "badge", statusForCheck(item.ok)));
    meta.append(el("span", "", formatMs(item.latencyMs)));

    row.append(main, meta);
    container.append(row);
  });
}

function renderSources(sources) {
  const container = $("#sourceList");
  clear(container);

  if (!sources?.length) {
    container.append(el("p", "empty", "Chưa có dữ liệu source."));
    return;
  }

  sources.forEach((source) => {
    const item = el("article", "source-item");
    item.dataset.ok = String(Boolean(source.ok));

    const head = el("div", "source-head");
    const title = el("div");
    title.append(el("strong", "", source.name));
    title.append(el("span", "", source.baseUrl || "Chưa rõ domain"));
    const badge = el("span", "badge", statusForCheck(source.ok));
    head.append(title, badge);

    const sample = el("p", "sample");
    sample.textContent = source.sampleBook?.title
      ? `Mẫu: ${source.sampleBook.title}`
      : source.error || "Chưa lấy được truyện mẫu.";

    const checks = el("div", "check-list compact");
    renderCheckList(checks, source.checks || []);

    item.append(head, sample, checks);
    container.append(item);
  });
}

function renderStatus(status) {
  const level = status?.level || "unknown";
  $("#statusBox").dataset.level = level;
  setText("#statusText", statusLabel(level));
  setText("#statusSummary", status?.summary || "Chưa đọc được status.json.");
  setText("#checkedAt", formatDate(status?.checkedAt));
  setText("#durationMs", formatMs(status?.durationMs));
  setText("#footerNote", `Lần kiểm tra gần nhất: ${formatDate(status?.checkedAt)}`);
  renderSources(status?.sources || []);
  renderCheckList($("#repoChecks"), status?.repo?.checks || []);
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

  renderIndex(fallbackIndex);

  try {
    renderIndex(await loadJson(REPO_URL));
  } catch {
    renderIndex(fallbackIndex);
  }

  try {
    renderStatus(await loadJson(STATUS_URL));
  } catch (error) {
    renderStatus({
      level: "unknown",
      summary: `Không đọc được status.json: ${error.message}`,
      sources: [],
      repo: { checks: [] },
    });
  }
}

async function copyRepoUrl() {
  const button = $("#copyButton");
  const original = button.textContent;

  try {
    await navigator.clipboard.writeText(REPO_URL);
    button.textContent = "Đã copy";
  } catch {
    button.textContent = "Copy lỗi";
  }

  setTimeout(() => {
    button.textContent = original;
  }, 1400);
}

$("#copyButton").addEventListener("click", copyRepoUrl);
hydrate();
