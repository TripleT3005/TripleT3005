import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";

// Configuration

const PNG_SIZES = [16, 32, 64, 80, 128, 256];
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 80, 128, 256];
const ICO_PNG_MIN_SIZE = 256;
const BROWSERS = [
  process.env.BROWSER,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

// Rendering

function findBrowser() {
  const browser = BROWSERS.find((candidate) => candidate && existsSync(candidate));
  if (!browser) throw new Error("No Chromium-based browser found; set BROWSER to its executable");
  return browser;
}

function renderPage(svg, sizes) {
  const source = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  return `<!DOCTYPE html><html><body><pre id="out"></pre><script>
const image = new Image();
image.onload = () => {
  const result = {};
  for (const size of ${JSON.stringify(sizes)}) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const context = canvas.getContext("2d");
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, size, size);
    const data = context.getImageData(0, 0, size, size).data;
    let binary = "";
    for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]);
    result[size] = btoa(binary);
  }
  document.getElementById("out").textContent = JSON.stringify(result);
};
image.onerror = () => { document.getElementById("out").textContent = "ERROR"; };
image.src = ${JSON.stringify(source)};
</script></body></html>`;
}

function renderPixels(svg, sizes) {
  const directory = mkdtempSync(join(tmpdir(), "icons-"));
  try {
    const page = join(directory, "render.html");
    writeFileSync(page, renderPage(svg, sizes));
    const dom = execFileSync(findBrowser(), ["--headless=new", "--disable-gpu", "--no-first-run", `--user-data-dir=${join(directory, "profile")}`, "--virtual-time-budget=10000", "--dump-dom", pathToFileURL(page).href], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    const json = /<pre id="out">([^<]*)<\/pre>/.exec(dom)?.[1];
    if (!json || json === "ERROR") throw new Error("The browser could not render the SVG");
    return new Map(Object.entries(JSON.parse(json)).map(([size, data]) => [Number(size), Buffer.from(data, "base64")]));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// PNG

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

export function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// ICO

export function encodeBitmap(size, rgba) {
  const maskRow = Math.ceil(size / 32) * 4;
  const image = Buffer.alloc(40 + size * size * 4 + maskRow * size);
  image.writeUInt32LE(40, 0);
  image.writeInt32LE(size, 4);
  image.writeInt32LE(size * 2, 8);
  image.writeUInt16LE(1, 12);
  image.writeUInt16LE(32, 14);
  image.writeUInt32LE(size * size * 4 + maskRow * size, 20);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const from = ((size - 1 - y) * size + x) * 4;
      const to = 40 + (y * size + x) * 4;
      image.set([rgba[from + 2], rgba[from + 1], rgba[from], rgba[from + 3]], to);
    }
  }
  return image;
}

export function encodeIco(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, index) => {
    const entry = 6 + index * 16;
    header[entry] = size >= 256 ? 0 : size;
    header[entry + 1] = size >= 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.data)]);
}

// Main

function main() {
  const directory = resolve(process.argv[2] ?? "assets/icons");
  const svg = readFileSync(join(directory, "icon.svg"), "utf8");
  const pixels = renderPixels(svg, [...new Set([...PNG_SIZES, ...ICO_SIZES])]);
  for (const size of PNG_SIZES) writeFileSync(join(directory, `icon-${size}.png`), encodePng(size, pixels.get(size)));
  const images = ICO_SIZES.map((size) => ({ size, data: size >= ICO_PNG_MIN_SIZE ? encodePng(size, pixels.get(size)) : encodeBitmap(size, pixels.get(size)) }));
  writeFileSync(join(directory, "icon.ico"), encodeIco(images));
  console.log(`Rendered ${directory}: icon.ico (${ICO_SIZES.join(", ")}), icon-{${PNG_SIZES.join(",")}}.png`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
