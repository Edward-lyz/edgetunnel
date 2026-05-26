import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const SOURCE_URL = "https://api.uouin.com/cloudflare.html";
const GROUP_LABELS = new Map([
  ["电信", "CN_CT_Uouin"],
  ["联通", "CN_CU_Uouin"],
  ["移动", "CN_CM_Uouin"],
  ["多线", "CN_BGP_Uouin"],
  ["IPV6", "IPv6"],
]);

const includeIpv6 = process.env.INCLUDE_IPV6 === "true";
const perGroupLimit = Number.parseInt(process.env.PER_GROUP_LIMIT || "10", 10);
const maxAgeHours = Number.parseInt(process.env.MAX_AGE_HOURS || "48", 10);
const gslegeEnabled = process.env.GSLEGE_ENABLED !== "false";
const gslegeRegions = (process.env.GSLEGE_REGIONS || "JP,SG,US")
  .split(",")
  .map((region) => region.trim().toUpperCase())
  .filter(Boolean);
const gslegePerRegionLimit = Number.parseInt(process.env.GSLEGE_PER_REGION_LIMIT || "10", 10);
const gslegePort = process.env.GSLEGE_PORT || "443";

const chrome = findChrome();
const rendered = dumpRenderedDom(chrome);
const rows = parseRows(rendered);
const freshRows = assertFresh(rows);
const uouinOutput = selectRows(freshRows);
const gslegeOutput = gslegeEnabled ? await fetchGslegeRows() : [];
const output = dedupeByAddress([...uouinOutput, ...gslegeOutput]);

if (output.length === 0) {
  throw new Error("No Cloudflare IP rows were parsed from the configured sources.");
}

process.stdout.write(`${output.join("\n")}\n`);

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "google-chrome-stable",
    "google-chrome",
    "chromium-browser",
    "chromium",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.includes("/") && !existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }

  throw new Error("Chrome/Chromium was not found. Set CHROME_PATH or install Chrome.");
}

function dumpRenderedDom(chromePath) {
  const result = spawnSync(
    chromePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--virtual-time-budget=12000",
      "--dump-dom",
      SOURCE_URL,
    ],
    { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
  );

  if (result.status !== 0 || !result.stdout) {
    throw new Error(`Chrome failed to render ${SOURCE_URL}: ${result.stderr || "empty output"}`);
  }

  return result.stdout;
}

function parseRows(html) {
  const rows = [];
  const trPattern = /<tr[^>]*>(.*?)<\/tr>/gis;
  let trMatch;

  while ((trMatch = trPattern.exec(html)) !== null) {
    const cells = [...trMatch[1].matchAll(/<(?:th|td)[^>]*>(.*?)<\/(?:th|td)>/gis)]
      .map((match) => cleanCell(match[1]));

    if (cells.length < 9) continue;

    const [, line, ip, loss, ping, speed, bandwidth, , time] = cells;
    if (!isIp(ip)) continue;

    const group = GROUP_LABELS.get(line) || line || "CF";
    const address = ip.includes(":") ? `[${ip}]` : ip;
    rows.push({
      group,
      ip,
      time,
      line: `${address}:443#${group}_${compactMetric(ping)}_${compactMetric(speed)}`,
      loss,
      bandwidth,
    });
  }

  return rows;
}

function cleanCell(value) {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function compactMetric(value) {
  return value
    .replace(/\s+/g, "")
    .replace(/mb\/s/gi, "Mbps")
    .replace(/ms/gi, "ms");
}

function isIp(value) {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) || /^[0-9a-f:]+$/i.test(value);
}

function assertFresh(rows) {
  const now = Date.now();
  const parsed = rows
    .map((row) => ({ ...row, timestamp: parseTimestamp(row.time) }))
    .filter((row) => Number.isFinite(row.timestamp));

  const newest = Math.max(...parsed.map((row) => row.timestamp));
  const ageHours = (now - newest) / 36e5;
  if (!Number.isFinite(newest) || ageHours > maxAgeHours) {
    throw new Error(
      `Rendered page data is stale or JS did not load. Parsed ${rows.length} rows; newest timestamp: ${
        Number.isFinite(newest) ? new Date(newest).toISOString() : "none"
      }.`,
    );
  }

  return parsed;
}

function parseTimestamp(value) {
  const match = value.match(/^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return Number.NaN;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

function selectRows(rows) {
  const seenLines = new Set();
  const groupCounts = new Map();
  const selected = [];

  for (const row of rows) {
    if (!includeIpv6 && row.group === "IPv6") continue;
    const count = groupCounts.get(row.group) || 0;
    if (count >= perGroupLimit) continue;
    if (seenLines.has(row.line)) continue;

    selected.push(row.line);
    seenLines.add(row.line);
    groupCounts.set(row.group, count + 1);
  }

  return selected;
}

async function fetchGslegeRows() {
  const groups = await Promise.all(gslegeRegions.map((region) => fetchGslegeRegion(region)));
  return groups.flat();
}

async function fetchGslegeRegion(region) {
  const source = `https://raw.githubusercontent.com/gslege/CloudflareIP/refs/heads/main/${encodeURIComponent(region)}.txt`;
  const response = await fetch(source, {
    headers: { "user-agent": "edgetunnel-addresses-updater" },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch gslege ${region}.txt: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  const selected = [];
  const seenHosts = new Set();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const host = line.split("#")[0].trim();
    if (!isIp(host) || seenHosts.has(host)) continue;

    selected.push(formatAddress(host, gslegePort, `${region}_GS_${String(selected.length + 1).padStart(2, "0")}`));
    seenHosts.add(host);

    if (selected.length >= gslegePerRegionLimit) break;
  }

  return selected;
}

function formatAddress(host, port, remark) {
  const address = host.includes(":") ? `[${host}]` : host;
  return `${address}:${port}#${remark}`;
}

function dedupeByAddress(lines) {
  const selected = [];
  const seen = new Set();

  for (const line of lines) {
    const address = line.split("#")[0];
    if (seen.has(address)) continue;
    selected.push(line);
    seen.add(address);
  }

  return selected;
}
