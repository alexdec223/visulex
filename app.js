/* Visulex Reader (phone web app)
   Camera -> crop the reading box -> Tesseract.js OCR on the phone ->
   phone's own voice reads it, highlighting each word as it is spoken.
   No photo leaves the phone. */

const $ = (id) => document.getElementById(id);
const MIN_CONFIDENCE = 55;
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

function pickVoice() {
  const voices = speechSynthesis.getVoices();
  const score = (v) =>
    (/karen/i.test(v.name) ? 8 : 0) +
    (v.lang === "en-AU" ? 4 : 0) +
    (/en[-_]GB/i.test(v.lang) ? 2 : 0) +
    (/^en/i.test(v.lang) ? 1 : 0) +
    (/premium|enhanced/i.test(v.name) ? 1 : 0);
  voice = voices.slice().sort((a, b) => score(b) - score(a))[0] || null;
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
function speakWords(list, mySession) {
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
    if (s >= sentences.length) { markWord(list.length, true); return; }
    const idx = sentences[s++];
    const text = idx.map((i) => list[i].text).join(" ");
    const starts = [];
    let pos = 0;
    idx.forEach((i) => { starts.push(pos); pos += list[i].text.length + 1; });

    const u = new SpeechSynthesisUtterance(text);
    if (voice) { u.voice = voice; u.lang = voice.lang; } else { u.lang = "en-AU"; }
    u.rate = 1.0;

    let gotBoundary = false;
    let timers = [];
    u.onboundary = (e) => {
      if (mySession !== session) return;
      if (e.name && e.name !== "word") return;
      gotBoundary = true;
      timers.forEach(clearTimeout);
      let k = 0;
      while (k + 1 < starts.length && starts[k + 1] <= e.charIndex) k++;
      markWord(idx[k]);
    };
    u.onstart = () => {
      markWord(idx[0]);
      // Fallback: if no word timing arrives, estimate it from word length.
      setTimeout(() => {
        if (gotBoundary || mySession !== session) return;
        const perChar = 0.068 / u.rate;     // seconds per character, typical voice
        let t = 0;
        idx.forEach((i, n) => {
          const at = t;
          timers.push(setTimeout(() => { if (mySession === session && !gotBoundary) markWord(i); }, at * 1000));
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
      ctx.fillStyle = "rgba(255, 213, 0, 0.45)";
      ctx.fillRect(x - 3, y - 3, width + 6, height + 6);
      ctx.strokeStyle = "#ffd500";
      ctx.lineWidth = 4;
      ctx.strokeRect(x - 3, y - 3, width + 6, height + 6);
    } else {
      ctx.strokeStyle = n < currentWord ? "rgba(120,120,120,0.8)" : "rgba(80, 200, 70, 0.9)";
      ctx.lineWidth = 2;
      ctx.strokeRect(x - 2, y - 2, width + 4, height + 4);
    }
  });
}

/* ---------------- OCR ---------------- */

function loadWorker() {
  if (workerReady) return workerReady;
  workerReady = (async () => {
    worker = await Tesseract.createWorker("eng", 1, {
      logger: (m) => {
        if (m.status && m.progress !== undefined && m.status.includes("load")) {
          status(`Loading the reader… ${Math.round(m.progress * 100)}%`);
        }
      },
    });
    await worker.setParameters({ preserve_interword_spaces: "1" });
    return worker;
  })();
  return workerReady;
}

// Greyscale and stretch contrast: helps Tesseract on phone photos.
function prepare(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    d[i] = g; hist[g]++;
  }
  const total = d.length / 4;
  let lo = 0, hi = 255, acc = 0;
  for (; lo < 255; lo++) { acc += hist[lo]; if (acc > total * 0.01) break; }
  acc = 0;
  for (; hi > 0; hi--) { acc += hist[hi]; if (acc > total * 0.01) break; }
  const range = Math.max(hi - lo, 1);
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.max(0, Math.min(255, ((d[i] - lo) * 255) / range));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
}

function readingOrder(list) {
  // Tesseract already returns words line by line; keep that but drop noise.
  return list.filter((w) => w.confidence >= MIN_CONFIDENCE && /[A-Za-z0-9]/.test(w.text));
}

async function recognise(sourceCanvas) {
  const work = $("work");
  work.width = sourceCanvas.width;
  work.height = sourceCanvas.height;
  work.getContext("2d").drawImage(sourceCanvas, 0, 0);
  prepare(work);
  const w = await loadWorker();
  const { data } = await w.recognize(work);
  return readingOrder(data.words || []);
}

/* ---------------- camera ---------------- */

async function startCamera() {
  if (stream) return true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
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
  loadWorker().then(() => { status("Line up some text, then tap Read"); $("readBtn").disabled = false; })
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

$("readBtn").addEventListener("click", () => {
  unlockSpeech();
  const video = $("video");
  if (!video.videoWidth) return;
  readCanvas(captureBox());
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
  else if (await startCamera()) { show("camera"); loadWorker().then(() => { $("readBtn").disabled = false; status("Line up some text, then tap Read"); }); }
  else show("start");
});

// Start loading the OCR engine straight away so the first Read is quick.
window.addEventListener("load", () => { loadWorker().catch(() => {}); });

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
