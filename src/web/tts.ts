import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { env } from "../env.js";

export interface TtsRequest {
  text: string;
  voice?: string;
  wantAlignment?: boolean;
}

export interface AlignmentData {
  words: string[];
  startMs: number[];
}

export interface TtsResponse {
  contentType: string;
  audioBase64: string;
  alignment?: AlignmentData;
  ttsAvailable: boolean;
  ttsSource?: "cache" | "gemini" | "disabled" | "error";
  error?: string;
}

// ── TTS file cache helpers ──

function ttsCacheEnabled(): boolean {
  return env.TTS_CACHE_ENABLED === "true";
}

function ttsCacheDir(): string {
  return path.resolve(env.TTS_CACHE_DIR);
}

function ttsCacheKey(text: string): string {
  const raw = `${text}|${env.TTS_MODEL}|${env.TTS_VOICE}`;
  return createHash("sha256").update(raw).digest("hex");
}

function ttsCachePath(key: string): string {
  return path.join(ttsCacheDir(), `${key}.wav`);
}

function ensureCacheDir(): void {
  const dir = ttsCacheDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function readTtsCache(text: string): TtsResponse | null {
  if (!ttsCacheEnabled()) return null;
  try {
    const key = ttsCacheKey(text);
    const fp = ttsCachePath(key);
    if (!existsSync(fp)) return null;
    const audioBase64 = readFileSync(fp, "utf-8");
    if (!audioBase64) return null;
    const alignment = fallbackAlignment(text);
    const textHash = createHash("sha256").update(text).digest("hex").slice(0, 12);
    console.log(`[tts] cache HIT key=${key.slice(0, 16)} hash=${textHash} len=${text.length}`);
    return {
      contentType: "audio/wav",
      audioBase64,
      alignment,
      ttsAvailable: true,
      ttsSource: "cache",
    };
  } catch {
    return null;
  }
}

function writeTtsCache(text: string, audioBase64: string): void {
  if (!ttsCacheEnabled()) return;
  try {
    ensureCacheDir();
    const key = ttsCacheKey(text);
    const fp = ttsCachePath(key);
    writeFileSync(fp, audioBase64, "utf-8");
    const textHash = createHash("sha256").update(text).digest("hex").slice(0, 12);
    console.log(`[tts] cache SET key=${key.slice(0, 16)} hash=${textHash}`);
  } catch (err) {
    console.warn(`[tts] cache write failed: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Compute fallback word-level alignment using a 180 WPM estimate
 * or a known audio duration in milliseconds.
 */
function fallbackAlignment(text: string, audioDurationMs?: number): AlignmentData {
  const words = text.split(/\s+/).filter(Boolean);
  const WPM = 180;
  const duration = audioDurationMs ?? (words.length / WPM) * 60_000;
  const wordDuration = words.length > 0 ? duration / words.length : 0;
  const startMs = words.map((_, i) => Math.round(i * wordDuration));
  return { words, startMs };
}

/**
 * Build a WAV header for raw Linear16 PCM data.
 * Gemini TTS returns raw PCM (16-bit, 24 kHz, mono) which browsers
 * cannot play directly. Wrapping in a WAV header makes it playable.
 */
function pcmToWavBase64(pcmBase64: string, sampleRate = 24000, channels = 1, bitsPerSample = 16): string {
  const pcmBytes = Buffer.from(pcmBase64, "base64");
  const dataSize = pcmBytes.length;
  const headerSize = 44;
  const fileSize = headerSize + dataSize;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);

  const header = Buffer.alloc(headerSize);
  // RIFF header
  header.write("RIFF", 0);
  header.writeUInt32LE(fileSize - 8, 4);
  header.write("WAVE", 8);
  // fmt sub-chunk
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);          // sub-chunk size
  header.writeUInt16LE(1, 20);           // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  // data sub-chunk
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBytes]).toString("base64");
}

/**
 * Call Gemini API for TTS using the official REST schema.
 * Uses x-goog-api-key header (key never in URL query string).
 * Body uses camelCase per Gemini API spec.
 *
 * Falls back gracefully: returns ttsAvailable=false if TTS fails.
 */
export async function synthesize(req: TtsRequest): Promise<TtsResponse> {
  // Check file cache first
  const cached = readTtsCache(req.text);
  if (cached) return cached;

  const ttsModel = env.TTS_MODEL;
  const voice = req.voice ?? env.TTS_VOICE;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${ttsModel}:generateContent`;

  const body = {
    contents: [
      {
        parts: [{ text: req.text }],
      },
    ],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: voice,
          },
        },
      },
    },
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      let errDetail = `status ${res.status}`;
      try {
        const errJson = await res.json() as Record<string, unknown>;
        const errObj = errJson.error as Record<string, unknown> | undefined;
        if (errObj?.message) errDetail += `: ${String(errObj.message)}`;
      } catch {
        const errText = await res.text().catch(() => "");
        if (errText) errDetail += `: ${errText.slice(0, 300)}`;
      }
      console.error(`[tts] Gemini TTS error — ${errDetail}`);
      return textOnlyFallback(req.text);
    }

    const data = await res.json();

    // Extract audio from response — Gemini uses camelCase: inlineData
    const candidate = data?.candidates?.[0];
    const parts = candidate?.content?.parts;
    if (!parts || parts.length === 0) {
      console.error("[tts] No parts in TTS response");
      return textOnlyFallback(req.text);
    }

    // Find the inlineData part with audio
    const audioPart = parts.find(
      (p: Record<string, unknown>) => p.inlineData,
    );
    if (!audioPart?.inlineData) {
      console.error("[tts] No inlineData in TTS response parts");
      return textOnlyFallback(req.text);
    }

    const pcmBase64: string = audioPart.inlineData.data;
    const mimeType: string = audioPart.inlineData.mimeType ?? "audio/L16;rate=24000";

    // Convert raw PCM to WAV for browser playback
    const wavBase64 = pcmToWavBase64(pcmBase64);

    // Log safely: provider, text_length, alignment_available
    console.log(
      `[tts] provider=gemini, model=${ttsModel}, text_length=${req.text.length}, alignment_available=false`,
    );

    // Gemini TTS does not return word-level timestamps; use fallback alignment
    const alignment = req.wantAlignment !== false
      ? fallbackAlignment(req.text)
      : undefined;

    // Cache the audio for future requests
    writeTtsCache(req.text, wavBase64);

    return {
      contentType: "audio/wav",
      audioBase64: wavBase64,
      alignment,
      ttsAvailable: true,
      ttsSource: "gemini",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[tts] TTS synthesis failed: ${msg}`);
    return textOnlyFallback(req.text);
  }
}

function textOnlyFallback(text: string): TtsResponse {
  return {
    contentType: "text/plain",
    audioBase64: "",
    alignment: fallbackAlignment(text),
    ttsAvailable: false,
    ttsSource: "error",
    error: "TTS unavailable",
  };
}
