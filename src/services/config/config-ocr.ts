import { existsSync } from 'node:fs';
import type { OcrAuthHeader, OcrConfig, OcrLlmConfig } from './config-types.js';
import { isRecord, readJsonFile } from './config-nested.js';
import { globalConfigPath } from './config-migration.js';
import { getUserConfigPath, readConfigFileSafely } from './config-safety.js';

/**
 * OCR LLM endpoint config lives in the slim 2.0 user-layer
 * `~/.peaks/config.json` under `ocr.llm.*`. The user populates
 * these fields by hand (or by running
 * `peaks code-review config-template` and pasting the output).
 * peaks-cli never auto-writes OCR config.
 *
 * The 5-state OCR detector consumes `getOcrLlmConfig`; when the
 * returned block is missing required fields it produces a
 * `config-missing` state with a templated `nextActions` payload.
 */

const OCR_AUTH_HEADERS: ReadonlySet<OcrAuthHeader> = new Set<OcrAuthHeader>(['authorization', 'x-api-key', 'bearer']);

function toOcrLlmConfig(value: unknown): OcrLlmConfig {
  if (!isRecord(value)) return {};
  const url = typeof value.url === 'string' && value.url.trim().length > 0 ? value.url.trim() : undefined;
  const authToken = typeof value.authToken === 'string' && value.authToken.length > 0 ? value.authToken : undefined;
  const model = typeof value.model === 'string' && value.model.trim().length > 0 ? value.model.trim() : undefined;
  const useAnthropic = typeof value.useAnthropic === 'boolean' ? value.useAnthropic : undefined;
  const rawAuthHeader = typeof value.authHeader === 'string' ? value.authHeader : undefined;
  const authHeader = rawAuthHeader !== undefined && OCR_AUTH_HEADERS.has(rawAuthHeader as OcrAuthHeader)
    ? (rawAuthHeader as OcrAuthHeader)
    : undefined;
  return {
    ...(url !== undefined ? { url } : {}),
    ...(authToken !== undefined ? { authToken } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(useAnthropic !== undefined ? { useAnthropic } : {}),
    ...(authHeader !== undefined ? { authHeader } : {})
  };
}

function toOcrConfig(value: unknown): OcrConfig {
  if (!isRecord(value)) return {};
  return {
    ...(isRecord(value.llm) ? { llm: toOcrLlmConfig(value.llm) } : {})
  };
}

export function readOcrFromRawConfigFile(): Record<string, unknown> | null {
  const path = globalConfigPath();
  if (!existsSync(path)) return null;
  const content = readConfigFileSafely(path, 'Global config path must stay inside the user root');
  const raw = JSON.parse(content) as Record<string, unknown>;
  return isRecord(raw.ocr) ? raw.ocr : null;
}

/**
 * Read the ocr LLM endpoint config from the user-layer
 * `~/.peaks/config.json`. The user populates this themselves by
 * pasting the `peaks code-review config-template` output (or by
 * running `peaks config set --key ocr.llm.url --value '...'`).
 * peaks-cli never auto-writes these values.
 */
export function getOcrConfig(): OcrConfig {
  const userPath = getUserConfigPath();
  const userConfig = readJsonFile(userPath) ?? {};
  return toOcrConfig(userConfig.ocr);
}

/**
 * Return the resolved `OcrLlmConfig` block (`peaksConfig.ocr.llm`)
 * or `null` when the user has not populated the user config. The
 * 5-state OCR detector uses this as the source of truth; when the
 * returned block is missing required fields it produces a
 * `config-missing` state with a templated `nextActions` payload
 * the user can paste into their config.
 */
export function getOcrLlmConfig(): OcrLlmConfig | null {
  const ocr = getOcrConfig();
  if (!ocr.llm) return null;
  return ocr.llm;
}