const gslegeRegions = (process.env.GSLEGE_REGIONS || "JP,SG,US")
  .split(",")
  .map((region) => region.trim().toUpperCase())
  .filter(Boolean);
const gslegePerRegionLimit = Number.parseInt(process.env.GSLEGE_PER_REGION_LIMIT || "100", 10);
const gslegeRegionLimits = parseRegionLimits(process.env.GSLEGE_REGION_LIMITS || "US=5");
const gslegePort = process.env.GSLEGE_PORT || "443";

const output = dedupeByAddress((await Promise.all(gslegeRegions.map(fetchGslegeRegion))).flat());

if (output.length === 0) {
  throw new Error("No Cloudflare IP rows were parsed from the configured GitHub sources.");
}

process.stdout.write(`${output.join("\n")}\n`);

async function fetchGslegeRegion(region) {
  const source = `https://raw.githubusercontent.com/gslege/CloudflareIP/refs/heads/main/${encodeURIComponent(region)}.txt`;
  const response = await fetch(source, {
    headers: { "user-agent": "edgetunnel-addresses-updater" },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch gslege ${region}.txt: ${response.status} ${response.statusText}`);
  }

  const selected = [];
  const seenHosts = new Set();

  for (const rawLine of (await response.text()).split(/\r?\n/)) {
    const host = rawLine.split("#")[0].trim();
    if (!isIp(host) || seenHosts.has(host)) continue;

    selected.push(formatAddress(host, gslegePort, `${region}_GS_${String(selected.length + 1).padStart(2, "0")}`));
    seenHosts.add(host);

    if (selected.length >= regionLimit(region)) break;
  }

  return selected;
}

function parseRegionLimits(value) {
  const limits = new Map();

  for (const item of value.split(",")) {
    const [region, limit] = item.split("=").map((part) => part.trim());
    const parsed = Number.parseInt(limit, 10);
    if (region && Number.isFinite(parsed) && parsed > 0) {
      limits.set(region.toUpperCase(), parsed);
    }
  }

  return limits;
}

function regionLimit(region) {
  return gslegeRegionLimits.get(region) || gslegePerRegionLimit;
}

function isIp(value) {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) || /^[0-9a-f:]+$/i.test(value);
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
