const OWNER = "chuoinho";
const REPO = "truyen-repo";
const BRANCH = "repo";
const RAW_BASE = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}`;
const REPO_URL = `${RAW_BASE}/index.min.json`;
const INDEX_PB_URL = `${RAW_BASE}/index.pb`;
const REPO_JSON_URL = `${RAW_BASE}/repo.json`;
const GITHUB_URL = `https://github.com/${OWNER}/${REPO}`;
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
    sources: [
      {
        name: "MinoTruyen Manga",
        lang: "vi",
        id: "1911829101129863006",
        baseUrl: "https://minotruyenv7.xyz",
        versionId: 1,
      },
      {
        name: "MinoTruyen Comics",
        lang: "vi",
        id: "3751671803647824606",
        baseUrl: "https://minotruyenv7.xyz",
        versionId: 1,
      },
      {
        name: "MinoTruyen Hentai",
        lang: "vi",
        id: "5865133728324986123",
        baseUrl: "https://minotruyenv7.xyz",
        versionId: 1,
      },
    ],
  },
];

const $ = (selector) => document.querySelector(selector);

function setText(selector, value) {
  const element = $(selector);
  if (element) element.textContent = value;
}

function render(index) {
  const extension = index[0] || fallbackIndex[0];
  const sources = extension.sources || [];

  setText("#extensionCount", String(index.length));
  setText("#sourceCount", String(sources.length));
  setText("#extensionName", extension.name);
  setText("#extensionPackage", extension.pkg);
  setText("#extensionLang", extension.lang);
  setText("#extensionVersion", extension.version);
  setText("#extensionCode", String(extension.code));
  setText("#extensionNsfw", extension.nsfw ? "Yes" : "No");

  $("#sourceList").innerHTML = sources
    .map(
      (source) => `
        <div class="source-row">
          <div>
            <strong>${source.name}</strong>
            <span>${source.baseUrl}</span>
          </div>
          <span class="pill">${source.lang}</span>
        </div>
      `,
    )
    .join("");

  $("#apkLink").href = `${RAW_BASE}/apk/${extension.apk}`;
  $("#lastChecked").textContent = `Loaded ${new Date().toLocaleString()}`;
}

async function hydrate() {
  $("#repoUrlText").textContent = REPO_URL;
  $("#installLink").href = INSTALL_URL;
  $("#indexJsonLink").href = REPO_URL;
  $("#indexPbLink").href = INDEX_PB_URL;
  $("#repoJsonLink").href = REPO_JSON_URL;
  $("#githubLink").href = GITHUB_URL;

  render(fallbackIndex);

  try {
    const response = await fetch(REPO_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    render(await response.json());
  } catch (error) {
    $("#lastChecked").textContent = `Using bundled metadata: ${error.message}`;
  }
}

async function copyRepoUrl() {
  await navigator.clipboard.writeText(REPO_URL);
  const button = $("#copyButton");
  const original = button.textContent;
  button.textContent = "Copied";
  setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

$("#copyButton").addEventListener("click", copyRepoUrl);
hydrate();
