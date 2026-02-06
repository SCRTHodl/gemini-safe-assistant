import { config } from "dotenv";
import { z } from "zod";

config();

const envSchema = z.object({
  GEMINI_API_KEY: z.string().min(1, "GEMINI_API_KEY is required"),
  GATEWAY_URL: z.string().url().default("http://localhost:8787"),
  GEMINI_MODEL: z.string().default("gemini-1.5-pro"),
  TTS_ENABLED: z.string().default("false"),
  TTS_MODEL: z.string().default("gemini-2.5-flash-preview-tts"),
  TTS_VOICE: z.string().default("Kore"),
  WEB_PORT: z.string().default("8788"),
  EXPLAIN_CACHE_ENABLED: z.string().default("true"),
  EXPLAIN_CACHE_TTL_SECONDS: z.string().default("86400"),
  TTS_CACHE_ENABLED: z.string().default("true"),
  TTS_CACHE_DIR: z.string().default("./tts-cache"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Environment validation failed:");
  for (const issue of parsed.error.issues) {
    console.error(`   ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
