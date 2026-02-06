/* Gemini Safe Assistant — Web Demo Frontend */

// ── State ──
let audio = null;
let alignment = null;
let animFrameId = null;
let isPlaying = false;

// ── DOM refs ──
const $ = (sel) => document.querySelector(sel);
const statusEl = $("#status");
const resultPanel = $("#resultPanel");
const explanationPanel = $("#explanationPanel");
const explanationText = $("#explanationText");
const explanationError = $("#explanationError");
const progressFill = $("#progressFill");
const driftLabel = $("#driftLabel");
const planList = $("#planList");
const actionJson = $("#actionJson");
const decisionBadge = $("#decisionBadge");
const decisionDetails = $("#decisionDetails");
const auditCard = $("#auditCard");
const auditDetails = $("#auditDetails");
const btnPlay = $("#btnPlay");
const btnRestart = $("#btnRestart");
const iconPlay = $("#iconPlay");
const iconPause = $("#iconPause");
const autoNarrate = $("#autoNarrate");
const sourceTag = $("#sourceTag");
const driftDemoCard = $("#driftDemoCard");
const driftPreviewText = $("#driftPreviewText");
const driftValidatorBadge = $("#driftValidatorBadge");
const replayCard = $("#replayCard");
const replayReason = $("#replayReason");

// ── Scenario buttons ──
document.querySelectorAll("[data-scenario]").forEach((btn) => {
  btn.addEventListener("click", () => runScenario(btn.dataset.scenario));
});

btnPlay.addEventListener("click", togglePlayPause);
btnRestart.addEventListener("click", restartAudio);

// ── Run a scenario ──
async function runScenario(id) {
  document.querySelectorAll(".btn").forEach((b) => (b.disabled = true));
  stopAudio();
  showStatus("Running scenario...", "loading");
  hideAll();

  try {
    const res = await fetch(`/api/scenario/${id}`, { method: "POST" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    // Scenario 1: drift demo — no technical panels, no auto-TTS
    if (data.result.driftMeta) {
      renderDriftDemo(data);
      hideStatus();
      return;
    }

    // Scenario 2: replay demo — show step 1 result + replay card
    if (data.result.replayDenied) {
      renderReplayDemo(data);
      hideStatus();
      return;
    }

    // Scenarios 3 & 4: standard flow
    renderResult(data);

    const speakText = data.result.explanation || data.narration || "";
    const explainSrc = data.result.explanationSource || "";

    if (autoNarrate.checked && speakText) {
      showStatus("Generating speech...", "loading");
      await fetchAndPlayTts(speakText);
    } else if (speakText) {
      renderExplanationWords(speakText);
      explanationPanel.classList.remove("hidden");
    }

    showSourceTag(explainSrc);
    hideStatus();
  } catch (err) {
    showStatus(`Error: ${err.message}`, "error");
  } finally {
    document.querySelectorAll(".btn").forEach((b) => (b.disabled = false));
  }
}

// ── Render replay demo (Scenario 2) ──
function renderReplayDemo(data) {
  const r = data.result;
  const explainSrc = r.explanationSource || "";

  // Render step 1 result panels (plan, action, decision=ALLOW, audit)
  renderResult(data);

  // Show replay card with step 2 denial
  replayReason.textContent = r.replayError || "receipt already executed";
  replayCard.classList.remove("hidden");

  // Show explanation (about replay denial)
  const speakText = r.explanation || "";
  if (autoNarrate.checked && speakText) {
    showStatus("Generating speech...", "loading");
    fetchAndPlayTts(speakText).then(() => {
      showSourceTag(explainSrc);
      hideStatus();
    });
  } else if (speakText) {
    renderExplanationWords(speakText);
    explanationPanel.classList.remove("hidden");
    showSourceTag(explainSrc);
  }
}

// ── Render drift demo (Scenario 1) ──
function renderDriftDemo(data) {
  const r = data.result;
  const meta = r.driftMeta;

  // Show explanation panel with fallback text + drift label
  renderExplanationWords(r.explanation);
  explanationPanel.classList.remove("hidden");
  driftLabel.classList.remove("hidden");

  // Show drift demo card with rejected preview
  driftPreviewText.textContent = meta.rejectedTextPreview || "";
  driftValidatorBadge.textContent = meta.validatorPassed ? "PASSED" : "REJECTED";
  driftValidatorBadge.className = `badge ${meta.validatorPassed ? "allow" : "deny"}`;
  driftDemoCard.classList.remove("hidden");

  // Do NOT show result panel (no action/decision/audit)
}

// ── Render scenario result ──
function renderResult(data) {
  const r = data.result;

  // Plan
  planList.innerHTML = "";
  if (r.proposed?.plan?.length > 0) {
    r.proposed.plan.forEach((step) => {
      const li = document.createElement("li");
      li.textContent = step;
      planList.appendChild(li);
    });
    $("#planCard").classList.remove("hidden");
  } else {
    $("#planCard").classList.add("hidden");
  }

  // Action
  if (r.proposed) {
    actionJson.textContent = JSON.stringify(
      {
        action_type: r.proposed.action_type,
        target_system: r.proposed.target_system,
        payload: r.proposed.payload,
      },
      null,
      2
    );
    $("#actionCard").classList.remove("hidden");
  } else {
    $("#actionCard").classList.add("hidden");
  }

  // Decision
  if (r.decision) {
    const isAllow = r.decision === "ALLOW";
    decisionBadge.textContent = r.decision;
    decisionBadge.className = `badge ${isAllow ? "allow" : "deny"}`;

    let details = "";
    if (!isAllow) {
      if (r.deny_code) details += `Code: <code>${esc(r.deny_code)}</code><br/>`;
      if (r.deny_reason) details += `Reason: <code>${esc(r.deny_reason)}</code><br/>`;
    }
    if (r.receipt_id) details += `Receipt: <code>${esc(r.receipt_id)}</code><br/>`;
    if (r.policy_hash) details += `Policy: <code>${esc(r.policy_hash.slice(0, 16))}...</code><br/>`;
    if (r.payload_hash) details += `Payload: <code>${esc(r.payload_hash.slice(0, 16))}...</code>`;
    decisionDetails.innerHTML = details;
    $("#decisionCard").classList.remove("hidden");
  } else {
    $("#decisionCard").classList.add("hidden");
  }

  // Audit
  if (r.audit) {
    auditCard.classList.remove("hidden");
    auditDetails.innerHTML = [
      `State: <code>${esc(r.audit.state)}</code>`,
      `Signature: <code>${esc(r.audit.signature_valid)}</code>`,
      `Executed: <code>${esc(r.audit.executed_at)}</code>`,
    ].join("<br/>");
  } else {
    auditCard.classList.add("hidden");
  }

  resultPanel.classList.remove("hidden");
}

// ── TTS + Explanation Speech ──
async function fetchAndPlayTts(text) {
  renderExplanationWords(text);
  explanationPanel.classList.remove("hidden");
  explanationError.classList.add("hidden");
  resetProgressBar();

  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, wantAlignment: true }),
    });

    if (!res.ok) throw new Error(`TTS API returned ${res.status}`);

    const data = await res.json();

    if (!data.ttsAvailable || !data.audioBase64) {
      showExplanationError(data.error || "TTS unavailable");
      return;
    }

    if (data.ttsSource) showSourceTag(null, data.ttsSource);

    alignment = data.alignment || null;

    const audioBlob = base64ToBlob(data.audioBase64, data.contentType);
    const audioUrl = URL.createObjectURL(audioBlob);

    stopAudio();
    audio = new Audio(audioUrl);

    audio.addEventListener("ended", () => {
      isPlaying = false;
      updatePlayIcon();
      cancelAnimationFrame(animFrameId);
      highlightAllSpoken();
      setProgressBar(100);
    });

    audio.addEventListener("error", () => {
      showExplanationError("Audio playback failed");
      isPlaying = false;
      updatePlayIcon();
    });

    audio.addEventListener("loadedmetadata", () => {
      if (alignment) {
        recalcAlignmentWithDuration(text, audio.duration * 1000);
      }
    });

    await audio.play();
    isPlaying = true;
    updatePlayIcon();
    startSyncLoop();
  } catch (err) {
    showExplanationError(`TTS unavailable`);
  }
}

function recalcAlignmentWithDuration(text, durationMs) {
  if (!alignment) return;
  const words = alignment.words;
  if (words.length === 0) return;
  const wordDuration = durationMs / words.length;
  alignment.startMs = words.map((_, i) => Math.round(i * wordDuration));
}

// ── Sync loop: word highlight + progress bar ──
function startSyncLoop() {
  if (!audio) return;

  function tick() {
    if (!audio || audio.paused) return;
    const currentMs = audio.currentTime * 1000;

    // Progress bar
    if (audio.duration && isFinite(audio.duration)) {
      const pct = (audio.currentTime / audio.duration) * 100;
      setProgressBar(Math.min(pct, 100));
    } else if (alignment && alignment.startMs.length > 0) {
      const lastWordMs = alignment.startMs[alignment.startMs.length - 1];
      const estTotal = lastWordMs * 1.15;
      setProgressBar(Math.min((currentMs / estTotal) * 100, 99));
    }

    // Word highlight
    if (alignment) highlightWord(currentMs);

    animFrameId = requestAnimationFrame(tick);
  }

  animFrameId = requestAnimationFrame(tick);
}

function highlightWord(currentMs) {
  if (!alignment) return;
  const wordEls = explanationText.querySelectorAll(".word");
  if (wordEls.length === 0) return;

  let activeIdx = -1;
  for (let i = alignment.startMs.length - 1; i >= 0; i--) {
    if (currentMs >= alignment.startMs[i]) {
      activeIdx = i;
      break;
    }
  }

  wordEls.forEach((el, i) => {
    el.classList.remove("active", "spoken", "upcoming");
    if (i === activeIdx) {
      el.classList.add("active");
    } else if (i < activeIdx) {
      el.classList.add("spoken");
    } else {
      el.classList.add("upcoming");
    }
  });
}

function highlightAllSpoken() {
  explanationText.querySelectorAll(".word").forEach((el) => {
    el.classList.remove("active", "upcoming");
    el.classList.add("spoken");
  });
}

// ── Render explanation text as word spans ──
function renderExplanationWords(text) {
  const words = text.split(/\s+/).filter(Boolean);
  explanationText.innerHTML = words
    .map((w, i) => `<span class="word upcoming" data-idx="${i}">${esc(w)}</span>`)
    .join(" ");
}

// ── Progress bar ──
function setProgressBar(pct) {
  progressFill.style.width = `${pct}%`;
}

function resetProgressBar() {
  progressFill.style.width = "0%";
}

// ── Playback controls ──
function togglePlayPause() {
  if (!audio) return;
  if (audio.paused) {
    audio.play();
    isPlaying = true;
    startSyncLoop();
  } else {
    audio.pause();
    isPlaying = false;
    cancelAnimationFrame(animFrameId);
  }
  updatePlayIcon();
}

function restartAudio() {
  if (!audio) return;
  audio.currentTime = 0;
  resetProgressBar();
  audio.play();
  isPlaying = true;
  updatePlayIcon();
  startSyncLoop();
}

function stopAudio() {
  if (audio) {
    audio.pause();
    audio.src = "";
    audio = null;
  }
  isPlaying = false;
  cancelAnimationFrame(animFrameId);
  alignment = null;
  updatePlayIcon();
  resetProgressBar();
}

function updatePlayIcon() {
  iconPlay.classList.toggle("hidden", isPlaying);
  iconPause.classList.toggle("hidden", !isPlaying);
}

// ── Helpers ──
function base64ToBlob(b64, mime) {
  const bytes = atob(b64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime || "audio/wav" });
}

function esc(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function showStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = `status ${type || ""}`;
  if (type === "loading") statusEl.classList.add("loading-pulse");
  statusEl.classList.remove("hidden");
}

function hideStatus() {
  statusEl.classList.add("hidden");
}

function showExplanationError(msg) {
  explanationError.textContent = msg;
  explanationError.classList.remove("hidden");
}

function showSourceTag(explainSrc, ttsSrc) {
  const parts = [];
  if (explainSrc === "cache") parts.push("cached");
  if (ttsSrc === "cache") parts.push("audio cached");
  if (parts.length > 0) {
    sourceTag.textContent = parts.join(" · ");
    sourceTag.classList.remove("hidden");
  }
}

function hideAll() {
  resultPanel.classList.add("hidden");
  explanationPanel.classList.add("hidden");
  explanationError.classList.add("hidden");
  driftLabel.classList.add("hidden");
  driftDemoCard.classList.add("hidden");
  replayCard.classList.add("hidden");
  sourceTag.classList.add("hidden");
  resetProgressBar();
}
