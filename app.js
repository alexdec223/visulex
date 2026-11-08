/* Visulex Reader (phone web app)
   Camera -> sharpest of a few frames -> crop the reading box ->
   PaddleOCR (PP-OCRv4 detection + English recognition) on the phone ->
   phone's own voice reads it, highlighting each word as it is spoken.
   No photo leaves the phone. */

const $ = (id) => document.getElementById(id);
const MIN_CONFIDENCE = 50;
const TARGET_WIDTH = 1600;        // crop is scaled to about this width for OCR

let stream = null;
let worker = null;
let workerReady = null;
let words = [];                   // [{text, bbox}] in reading order
let photoScale = 1;
let session = 0;                  // bumps on every new read or stop
let voice = null;

/* ---------------- screens ---------------- */

function show(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("active", s.id === id));
}

function status(text) { $("status").textContent = text; }

/* ---------------- speech ---------------- */

/* Reader settings, kept on this phone between visits. */
const DEFAULTS = { voiceURI: "", rate: 1.0, volume: 1.0, textSize: 25 };
let settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem("visulex-settings") || "{}")); } catch (e) { /* private mode */ }
function saveSettings() {
  try { localStorage.setItem("visulex-settings", JSON.stringify(settings)); } catch (e) { /* private mode */ }
}

function englishVoices() {
  if (!("speechSynthesis" in window)) return [];
  const seen = new Set();
  return speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang) && !seen.has(v.voiceURI) && seen.add(v.voiceURI));
}

function voiceScore(v) {
  return (/karen/i.test(v.name) ? 8 : 0) +
    (v.lang === "en-AU" ? 4 : 0) +
    (/en[-_]GB/i.test(v.lang) ? 2 : 0) +
    (/premium|enhanced/i.test(v.name) ? 1 : 0);
}

function pickVoice() {
  const voices = englishVoices();
  voice = voices.find((v) => v.voiceURI === settings.voiceURI) ||
    voices.slice().sort((a, b) => voiceScore(b) - voiceScore(a))[0] || null;
  if (typeof fillVoiceList === "function") fillVoiceList();
}
if ("speechSynthesis" in window) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}

// iPhone only allows speech that starts from a tap. Speaking an empty
// utterance inside the tap unlocks it for the reading that follows.
function unlockSpeech() {
  if (!("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(" ");
  u.volume = 0;
  speechSynthesis.speak(u);
}

function stopSpeech() {
  session++;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  markWord(-1, true);
}

/* Speaks the words one sentence at a time. Uses the voice's own word
   timing when the phone provides it; otherwise estimates it. */
function speakWords(list, mySession, onWord = markWord) {
  const sentences = [];
  let current = [];
  list.forEach((w, i) => {
    current.push(i);
    if (/[.!?;:]$/.test(w.text) || current.length >= 25) { sentences.push(current); current = []; }
  });
  if (current.length) sentences.push(current);

  let s = 0;
  const next = () => {
    if (mySession !== session) return;
    if (s >= sentences.length) { onWord(list.length, true); return; }
    const idx = sentences[s++];
    const text = idx.map((i) => list[i].text).join(" ");
    const starts = [];
    let pos = 0;
    idx.forEach((i) => { starts.push(pos); pos += list[i].text.length + 1; });

    const u = new SpeechSynthesisUtterance(text);
    if (voice) { u.voice = voice; u.lang = voice.lang; } else { u.lang = "en-AU"; }
    u.rate = settings.rate;
    u.volume = settings.volume;

    let gotBoundary = false;
    let timers = [];
    u.onboundary = (e) => {
      if (mySession !== session) return;
      if (e.name && e.name !== "word") return;
      gotBoundary = true;
      timers.forEach(clearTimeout);
      let k = 0;
      while (k + 1 < starts.length && starts[k + 1] <= e.charIndex) k++;
      onWord(idx[k]);
    };
    u.onstart = () => {
      onWord(idx[0]);
      // Fallback: if no word timing arrives, estimate it from word length.
      setTimeout(() => {
        if (gotBoundary || mySession !== session) return;
        const perChar = 0.068 / u.rate;     // seconds per character, typical voice
        let t = 0;
        idx.forEach((i, n) => {
          const at = t;
          timers.push(setTimeout(() => { if (mySession === session && !gotBoundary) onWord(i); }, at * 1000));
          t += (list[i].text.length + 1.5) * perChar;
        });
      }, 350);
    };
    u.onend = () => { timers.forEach(clearTimeout); next(); };
    u.onerror = () => { timers.forEach(clearTimeout); next(); };
    speechSynthesis.speak(u);
  };
  next();
}

/* ---------------- highlighting ---------------- */

let currentWord = -1;

function markWord(i, finished = false) {
  currentWord = i;
  document.querySelectorAll("#caption .w").forEach((el, n) => {
    el.classList.toggle("now", n === i && !finished);
    el.classList.toggle("done", n < i);
  });
  const now = document.querySelector("#caption .w.now");
  if (now) now.scrollIntoView({ block: "nearest", behavior: "smooth" });
  drawPhoto();
  $("stopBtn").textContent = finished ? "Done" : "Stop";
}

let photoImage = null;

function drawPhoto() {
  const canvas = $("photo");
  if (!photoImage) return;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(photoImage, 0, 0, canvas.width, canvas.height);
  words.forEach((w, n) => {
    const b = w.bbox;
    const x = b.x0 * photoScale, y = b.y0 * photoScale;
    const width = (b.x1 - b.x0) * photoScale, height = (b.y1 - b.y0) * photoScale;
    if (n === currentWord) {
      ctx.fillStyle = "rgba(80, 102, 120, 0.35)";
      ctx.fillRect(x - 3, y - 3, width + 6, height + 6);
      ctx.strokeStyle = "#506678";
      ctx.lineWidth = 4;
      ctx.strokeRect(x - 3, y - 3, width + 6, height + 6);
    } else {
      ctx.strokeStyle = n < currentWord ? "rgba(120,120,120,0.8)" : "rgba(80, 102, 120, 0.6)";
      ctx.lineWidth = 2;
      ctx.strokeRect(x - 2, y - 2, width + 4, height + 4);
    }
  });
}

/* ---------------- OCR ---------------- */

function loadWorker() {
  if (workerReady) return workerReady;
  worker = new PaddleOCR("");
  workerReady = worker.load((f) => status(`Loading the reader… ${Math.round(f * 100)}%`)).then(() => worker);
  workerReady.catch(() => { workerReady = null; });
  return workerReady;
}

// Ready message, with the camera resolution so it is easy to check.
function readyText() {
  const v = $("video");
  return v.videoWidth ? `Line up some text, then tap Read · ${v.videoWidth}×${v.videoHeight}` : "Line up some text, then tap Read";
}

function readingOrder(list) {
  // The OCR returns words in reading order; drop low confidence noise.
  return list.filter((w) => w.confidence >= MIN_CONFIDENCE && /[A-Za-z0-9]/.test(w.text));
}

async function recognise(sourceCanvas) {
  const work = $("work");
  work.width = sourceCanvas.width;
  work.height = sourceCanvas.height;
  work.getContext("2d").drawImage(sourceCanvas, 0, 0);
  const started = performance.now();
  const w = await loadWorker();
  const { words: found } = await w.recognize(work);
  console.log(`OCR ${Math.round(performance.now() - started)} ms, ${found.length} words`);
  return readingOrder(found);
}

/* ---------------- camera ---------------- */

async function startCamera() {
  if (stream) return true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 3840 }, height: { ideal: 2160 } },  // more pixels per letter = better OCR
    });
  } catch (err) {
    alert("The camera could not start. Please allow camera access for this site and try again.\n\n" + err.message);
    return false;
  }
  const video = $("video");
  video.srcObject = stream;
  await video.play().catch(() => {});
  const track = stream.getVideoTracks()[0];
  try { await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }); } catch (e) { /* not supported */ }
  console.log(`Camera ${video.videoWidth} x ${video.videoHeight}`);
  return true;
}

// Copies exactly the part of the video inside the on screen box.
function captureBox() {
  const video = $("video");
  const vw = video.clientWidth, vh = video.clientHeight;
  const iw = video.videoWidth, ih = video.videoHeight;
  const scale = Math.max(vw / iw, vh / ih);            // object-fit: cover
  const ox = (vw - iw * scale) / 2, oy = (vh - ih * scale) / 2;
  const vr = video.getBoundingClientRect();
  const fr = $("frame").getBoundingClientRect();
  let sx = (fr.left - vr.left - ox) / scale, sy = (fr.top - vr.top - oy) / scale;
  let sw = fr.width / scale, sh = fr.height / scale;
  sx = Math.max(0, sx); sy = Math.max(0, sy);
  sw = Math.min(iw - sx, sw); sh = Math.min(ih - sy, sh);
  const out = document.createElement("canvas");
  const up = Math.min(2.5, Math.max(1, TARGET_WIDTH / sw));
  out.width = Math.round(sw * up);
  out.height = Math.round(sh * up);
  const ctx = out.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return out;
}

/* ---------------- reading flow ---------------- */

function setCaptionMessage(text) {
  $("caption").innerHTML = `<span class="msg">${text}</span>`;
}

function setCaptionWords(list) {
  $("caption").innerHTML = list.map((w, i) => `<span class="w" data-i="${i}">${escapeHtml(w.text)}</span>`).join(" ");
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function showPhoto(canvas) {
  photoImage = canvas;
  const photo = $("photo");
  photoScale = Math.min(1, 1000 / canvas.width);
  photo.width = Math.round(canvas.width * photoScale);
  photo.height = Math.round(canvas.height * photoScale);
  currentWord = -1;
  words = [];
  drawPhoto();
}

let lastCanvas = null;

async function readCanvas(canvas) {
  stopSpeech();
  const mySession = session;
  lastCanvas = canvas;
  show("result");
  showPhoto(canvas);
  setCaptionMessage("Finding the words…");
  $("stopBtn").textContent = "Stop";
  let found = [];
  try {
    found = await recognise(canvas);
  } catch (err) {
    setCaptionMessage("Something went wrong reading the text. Tap Scan to try again.");
    return;
  }
  if (mySession !== session) return;
  words = found;
  if (!words.length) {
    setCaptionMessage("No text found. Move a little closer, add light, and keep the text inside the box.");
    speakWords([{ text: "I couldn't find any text. Try moving a little closer." }], mySession);
    return;
  }
  setCaptionWords(words);
  drawPhoto();
  speakWords(words, mySession);
}

/* ---------------- buttons ---------------- */

$("startBtn").addEventListener("click", async () => {
  unlockSpeech();
  loadWorker().then(() => { status(readyText()); $("readBtn").disabled = false; })
    .catch(() => status("The reader could not load. Check the internet and reload the page."));
  const ok = await startCamera();
  if (ok) show("camera");
});

$("sampleBtn").addEventListener("click", async () => {
  unlockSpeech();
  const img = new Image();
  img.src = "sample.jpg";
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext("2d").drawImage(img, 0, 0);
  readCanvas(c);
});

// Sharpness of a capture: variance of a simple Laplacian on a small greyscale copy.
function sharpness(canvas) {
  const w = 320, h = Math.max(8, Math.round((canvas.height / canvas.width) * 320));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
    sum += l; sum2 += l * l; n++;
  }
  return sum2 / n - (sum / n) ** 2;
}

// Hand held phones shake: take a few frames and keep the sharpest.
async function captureBest(frames = 4, gapMs = 90) {
  let best = null, bestScore = -1;
  for (let k = 0; k < frames; k++) {
    if (k) await new Promise((r) => setTimeout(r, gapMs));
    const c = captureBox();
    const s = sharpness(c);
    if (s > bestScore) { bestScore = s; best = c; }
  }
  return best;
}

$("readBtn").addEventListener("click", async () => {
  unlockSpeech();
  const video = $("video");
  if (!video.videoWidth) return;
  $("readBtn").disabled = true;
  status("Hold still…");
  const shot = await captureBest();
  $("readBtn").disabled = false;
  status("Line up some text, then tap Read");
  readCanvas(shot);
});

$("againBtn").addEventListener("click", () => {
  unlockSpeech();
  if (!words.length) return;
  stopSpeech();
  const mySession = session;
  speakWords(words, mySession);
});

$("stopBtn").addEventListener("click", () => stopSpeech());

$("backBtn").addEventListener("click", async () => {
  stopSpeech();
  if (stream) show("camera");
  else if (await startCamera()) { show("camera"); loadWorker().then(() => { $("readBtn").disabled = false; status(readyText()); }); }
  else show("start");
});

/* ---------------- settings ---------------- */

const REGIONS = { "en-AU": "Australia", "en-GB": "United Kingdom", "en-IE": "Ireland", "en-NZ": "New Zealand",
  "en-US": "United States", "en-ZA": "South Africa", "en-IN": "India", "en-SC": "Scotland" };
// Novelty voices on Apple devices: not suitable for reading.
const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Fred|Junior|Kathy|Ralph)\b/i;
const PREVIEW_TEXT = "Reading should feel easy, calm and possible for every student.";
const previewWords = PREVIEW_TEXT.split(" ").map((text) => ({ text }));

function regionOf(v) { return REGIONS[v.lang.replace("_", "-")] || "Other English"; }

function fillVoiceList() {
  const sel = $("voiceSelect");
  const voices = englishVoices().filter((v) => !NOVELTY.test(v.name));
  if (!voices.length) { sel.innerHTML = "<option>Default voice</option>"; sel.disabled = true; return; }
  sel.disabled = false;
  const order = ["Australia", "United Kingdom", "Ireland", "New Zealand", "Scotland", "United States", "South Africa", "India", "Other English"];
  const groups = {};
  voices.forEach((v) => (groups[regionOf(v)] = groups[regionOf(v)] || []).push(v));
  sel.innerHTML = order.filter((g) => groups[g]).map((g) =>
    `<optgroup label="${g}">` +
    groups[g].sort((a, b) => voiceScore(b) - voiceScore(a) || a.name.localeCompare(b.name))
      .map((v) => `<option value="${escapeHtml(v.voiceURI)}">${escapeHtml(v.name)}</option>`).join("") +
    "</optgroup>").join("");
  if (voice) sel.value = voice.voiceURI;
}

function setFill(input) {
  const f = (input.value - input.min) / (input.max - input.min);
  input.style.setProperty("--fill", `${(f * 100).toFixed(1)}%`);
}

function applySettings() {
  document.documentElement.style.setProperty("--caption-size", `${settings.textSize}px`);
  $("rateRange").value = settings.rate;
  $("volumeRange").value = settings.volume;
  $("sizeRange").value = settings.textSize;
  ["rateRange", "volumeRange", "sizeRange"].forEach((id) => setFill($(id)));
  const r = settings.rate;
  $("rateVal").textContent = `${r.toFixed(2).replace(/0$/, "")}×${Math.abs(r - 1) < 0.001 ? " · Normal" : ""}`;
  $("volumeVal").textContent = `${Math.round(settings.volume * 100)}%`;
  $("sizeVal").textContent = `${settings.textSize} px`;
}

function previewWord(i, finished = false) {
  document.querySelectorAll("#previewText .w").forEach((el, n) => {
    el.classList.toggle("now", n === i && !finished);
    el.classList.toggle("done", n < i && !finished);
  });
  $("previewBtn").classList.toggle("playing", !finished);
  $("previewBtn").lastElementChild.textContent = finished ? "Play preview" : "Stop preview";
}

function playPreview() {
  stopSpeech();
  previewWord(-1);
  speakWords(previewWords, session, previewWord);
}

function openSettings() {
  unlockSpeech();
  stopSpeech();
  fillVoiceList();
  applySettings();
  $("previewText").innerHTML = previewWords.map((w) => `<span class="w">${escapeHtml(w.text)}</span>`).join(" ");
  previewWord(-1, true);
  $("settings").classList.add("open");
  $("settings").setAttribute("aria-hidden", "false");
}

function closeSettings() {
  stopSpeech();
  previewWord(-1, true);
  $("settings").classList.remove("open");
  $("settings").setAttribute("aria-hidden", "true");
}

document.querySelectorAll("[data-open-settings]").forEach((b) => b.addEventListener("click", openSettings));
$("settingsDone").addEventListener("click", closeSettings);
$("previewBtn").addEventListener("click", () => {
  if ($("previewBtn").classList.contains("playing")) { stopSpeech(); previewWord(-1, true); } else playPreview();
});
$("voiceSelect").addEventListener("change", (e) => {
  settings.voiceURI = e.target.value;
  pickVoice(); saveSettings(); playPreview();
});
[["rateRange", "rate"], ["volumeRange", "volume"], ["sizeRange", "textSize"]].forEach(([id, key]) => {
  $(id).addEventListener("input", (e) => { settings[key] = Number(e.target.value); applySettings(); });
  // Hear the change when the slider is let go (text size shows straight away).
  $(id).addEventListener("change", () => { saveSettings(); if (key !== "textSize") playPreview(); });
});
$("resetBtn").addEventListener("click", () => {
  settings = { ...DEFAULTS };
  saveSettings(); pickVoice(); applySettings(); playPreview();
});
applySettings();

// Start loading the OCR engine straight away so the first Read is quick.
window.addEventListener("load", () => { loadWorker().catch(() => {}); });

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
