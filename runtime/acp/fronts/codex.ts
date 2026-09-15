/**
 * @module
 * Entry point for the Codex ACP front (FR-L43).
 *
 * Spawned by `runtime/acp/fronts.ts` the same way as the Claude entry —
 * see `runtime/acp/fronts/claude.ts` for why the import is bare and why
 * this module stays out of the library's module graph. Keeping the codex
 * front out of that graph matters more than for Claude: its dependency
 * `@openai/codex` ships a platform-native binary.
 */

import "@agentclientprotocol/codex-acp/dist/index.js";
