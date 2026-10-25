import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Configuration

const owner = process.env.GITHUB_REPOSITORY_OWNER ?? "TripleT3005";
const token = process.env.GITHUB_TOKEN;
const outputDirectory = process.argv[2] ?? "output";
const maxLanguages = 9;

const iconDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "devicon", "icons");

const iconNames = {
  "C#": "csharp",
  "C++": "cplusplus",
  CSS: "css3",
  Dockerfile: "docker",
  HTML: "html5",
  Shell: "bash",
  "Visual Basic .NET": "visualbasic",
  Vue: "vuejs",
  XAML: "dot-net",
};

const monochromeIcons = new Set(["bash"]);

const themes = {
  light: { background: "#F3F4F1", ink: "#1B2B23", muted: "#6B7A72", accent: "#2F6B4E", track: "#DDE2DD" },
  dark: { background: "#111614", ink: "#E5EAE6", muted: "#8A9A91", accent: "#86BC9C", track: "#232B27" },
};

const layout = { width: 460, padding: 24, titleHeight: 56, rowHeight: 30, iconSize: 18, nameX: 52, barX: 172, barWidth: 198 };

// GitHub API

async function getJson(url) {
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`);
  }

  return response.json();
}

async function getLanguageTotals() {
  const repositories = await getJson(`https://api.github.com/users/${owner}/repos?type=owner&per_page=100`);
  const totals = new Map();

  for (const repository of repositories) {
    if (repository.fork || repository.name.toLowerCase() === owner.toLowerCase()) {
      continue;
    }

    const languages = await getJson(repository.languages_url);
    for (const [language, bytes] of Object.entries(languages)) {
      totals.set(language, (totals.get(language) ?? 0) + bytes);
    }
  }

  return totals;
}

function toShares(totals) {
  const sum = [...totals.values()].reduce((a, b) => a + b, 0);
  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, maxLanguages).map(([name, bytes]) => ({ name, share: bytes / sum }));
  const rest = sorted.slice(maxLanguages).reduce((a, [, bytes]) => a + bytes, 0);

  if (rest > 0) {
    top.push({ name: "Other", share: rest / sum });
  }

  return top;
}

// Icons

function loadIcon(language) {
  const name = iconNames[language] ?? language.toLowerCase();

  for (const variant of ["original", "plain"]) {
    const file = join(iconDirectory, name, `${name}-${variant}.svg`);
    if (existsSync(file)) {
      const svg = readFileSync(file, "utf8");
      const viewBox = svg.match(/viewBox="([^"]*)"/)?.[1] ?? "0 0 128 128";
      const content = svg.slice(svg.indexOf(">", svg.indexOf("<svg")) + 1, svg.lastIndexOf("</svg>"));
      return { viewBox, content: monochromeIcons.has(name) ? content.replace(/\s(fill|style)="[^"]*"/g, "") : content };
    }
  }

  return null;
}

// Rendering

function escapeXml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderRow(entry, index, theme) {
  const y = layout.titleHeight + index * layout.rowHeight;
  const centerY = y + layout.rowHeight / 2;
  const iconY = centerY - layout.iconSize / 2;
  const icon = loadIcon(entry.name);
  const filled = Math.max(4, layout.barWidth * entry.share);

  const iconMarkup = icon
    ? `<svg x="${layout.padding}" y="${iconY}" width="${layout.iconSize}" height="${layout.iconSize}" viewBox="${icon.viewBox}" fill="${theme.ink}">${icon.content}</svg>`
    : `<circle cx="${layout.padding + layout.iconSize / 2}" cy="${centerY}" r="5" fill="${theme.muted}"/>`;

  return [
    iconMarkup,
    `<text x="${layout.nameX}" y="${centerY}" dominant-baseline="central" fill="${theme.ink}">${escapeXml(entry.name)}</text>`,
    `<rect x="${layout.barX}" y="${centerY - 4}" width="${layout.barWidth}" height="8" rx="4" fill="${theme.track}"/>`,
    `<rect x="${layout.barX}" y="${centerY - 4}" width="${filled.toFixed(1)}" height="8" rx="4" fill="${theme.accent}"/>`,
    `<text x="${layout.width - layout.padding}" y="${centerY}" dominant-baseline="central" text-anchor="end" fill="${theme.muted}">${(entry.share * 100).toFixed(1)} %</text>`,
  ].join("\n  ");
}

function renderCard(entries, theme) {
  const height = layout.titleHeight + entries.length * layout.rowHeight + layout.padding - 6;
  const rows = entries.map((entry, index) => renderRow(entry, index, theme)).join("\n  ");

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${layout.width}" height="${height}" viewBox="0 0 ${layout.width} ${height}" role="img" aria-label="Most used languages">
<!-- Language icons: Devicon (https://devicon.dev), MIT License, Copyright (c) 2015 konpa -->
<style>text{font-family:system-ui,-apple-system,"Segoe UI Variable","Segoe UI",Roboto,sans-serif;font-size:13px}.title{font-size:15px;font-weight:600}</style>
  <rect x="0.5" y="0.5" width="${layout.width - 1}" height="${height - 1}" rx="12" fill="${theme.background}" stroke="${theme.track}"/>
  <text class="title" x="${layout.padding}" y="34" fill="${theme.ink}">Most used languages</text>
  ${rows}
</svg>
`;
}

// Main

const entries = toShares(await getLanguageTotals());
mkdirSync(outputDirectory, { recursive: true });

for (const [name, theme] of Object.entries(themes)) {
  writeFileSync(join(outputDirectory, `languages-${name}.svg`), renderCard(entries, theme));
}

console.log(entries.map((entry) => `${entry.name}: ${(entry.share * 100).toFixed(1)} %`).join("\n"));
