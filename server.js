import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8787);
const STEAM_API_BASE = process.env.STEAM_API_BASE || "https://partner.steam-api.com";
const STEAM_PUBLISHER_KEY = process.env.STEAM_PUBLISHER_KEY || process.env.STEAM_WEB_API_KEY || "";
const STEAM_APP_ID = process.env.STEAM_APP_ID || "3463540";
const TOTAL_COINS_GOAL = Number(process.env.TOTAL_COINS_GOAL || 24000000);
const SESSION_TIMEOUT_MS = Number(process.env.SESSION_TIMEOUT_MS || 120000);
const POWERUP_DURATION_MS = Number(process.env.POWERUP_DURATION_MS || 24 * 60 * 60 * 1000);
const PRIMARY_TIMER_MS = Number(process.env.PRIMARY_TIMER_MS || 60000);
const OLD_CLOCK_TIMER_MS = Number(process.env.OLD_CLOCK_TIMER_MS || 120000);
const GRANT_GRACE_MS = 5000;
const SESSION_HISTORY_LIMIT = 20;
const STATE_VERSION = 2;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");

const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Session-Token",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Cache-Control": "no-store"
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, jsonHeaders);
  response.end(JSON.stringify(payload));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonBody(request) {
  const text = await readBody(request);
  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    const error = new Error("invalid-json");
    error.statusCode = 400;
    throw error;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nowMs() {
  return Date.now();
}

function toIso(ms) {
  return new Date(ms).toISOString();
}

function getTimerDuration(timerIndex) {
  if (timerIndex === 0) {
    return PRIMARY_TIMER_MS;
  }

  if (timerIndex === 1) {
    return OLD_CLOCK_TIMER_MS;
  }

  return 0;
}

function createEmptyTimer(timerIndex) {
  return {
    accumulatedMs: 0,
    unlocked: timerIndex === 0,
    lastClaimAt: null,
    readyAt: null
  };
}

function normalizeTimer(rawTimer, timerIndex) {
  const durationMs = getTimerDuration(timerIndex);
  const accumulatedMs = Number(rawTimer?.accumulatedMs || 0);

  return {
    accumulatedMs: Math.min(durationMs, Math.max(0, accumulatedMs)),
    unlocked: timerIndex === 0 ? true : Boolean(rawTimer?.unlocked),
    lastClaimAt: typeof rawTimer?.lastClaimAt === "string" ? rawTimer.lastClaimAt : null,
    readyAt: typeof rawTimer?.readyAt === "string" ? rawTimer.readyAt : null
  };
}

function normalizeSessionRecord(rawSession) {
  if (!isPlainObject(rawSession)) {
    return null;
  }

  const sessionId = typeof rawSession.sessionId === "string" ? rawSession.sessionId : "";
  const tokenHash = typeof rawSession.tokenHash === "string" ? rawSession.tokenHash : "";
  if (!sessionId || !tokenHash) {
    return null;
  }

  return {
    sessionId,
    tokenHash,
    startedAt: Number(rawSession.startedAt || 0),
    lastHeartbeatAt: Number(rawSession.lastHeartbeatAt || rawSession.startedAt || 0),
    expiresAt: Number(rawSession.expiresAt || 0),
    active: Boolean(rawSession.active),
    totalActiveMs: Number(rawSession.totalActiveMs || 0),
    endedAt: typeof rawSession.endedAt === "string" ? rawSession.endedAt : null,
    endReason: typeof rawSession.endReason === "string" ? rawSession.endReason : null
  };
}

function normalizeHistoryEntry(rawEntry) {
  if (!isPlainObject(rawEntry)) {
    return null;
  }

  const sessionId = typeof rawEntry.sessionId === "string" ? rawEntry.sessionId : "";
  if (!sessionId) {
    return null;
  }

  return {
    sessionId,
    startedAt: Number(rawEntry.startedAt || 0),
    endedAt: typeof rawEntry.endedAt === "string" ? rawEntry.endedAt : null,
    reason: typeof rawEntry.reason === "string" ? rawEntry.reason : "unknown",
    totalActiveMs: Number(rawEntry.totalActiveMs || 0)
  };
}

function normalizePlayer(rawPlayer) {
  const source = isPlainObject(rawPlayer) ? rawPlayer : {};
  const timers = isPlainObject(source.timers) ? source.timers : {};
  const powerups = isPlainObject(source.powerups) ? source.powerups : {};
  const sessionHistory = Array.isArray(source.sessionHistory) ? source.sessionHistory : [];

  return {
    timers: {
      0: normalizeTimer(timers[0] || timers["0"], 0),
      1: normalizeTimer(timers[1] || timers["1"], 1)
    },
    currentSession: normalizeSessionRecord(source.currentSession),
    sessionHistory: sessionHistory
      .map(normalizeHistoryEntry)
      .filter(Boolean)
      .slice(0, SESSION_HISTORY_LIMIT),
    powerups: {
      hammerUntil: Number(powerups.hammerUntil || 0),
      mirrorUntil: Number(powerups.mirrorUntil || 0)
    }
  };
}

function normalizeState(rawState) {
  const source = isPlainObject(rawState) ? rawState : {};
  const players = isPlainObject(source.players) ? source.players : {};
  const grants = isPlainObject(source.grants) ? source.grants : {};
  const sessionsByTokenHash = isPlainObject(source.sessionsByTokenHash) ? source.sessionsByTokenHash : {};

  const normalizedPlayers = {};
  for (const [steamId, rawPlayer] of Object.entries(players)) {
    normalizedPlayers[steamId] = normalizePlayer(rawPlayer);
  }

  const normalizedSessionsByTokenHash = {};
  for (const [tokenHash, entry] of Object.entries(sessionsByTokenHash)) {
    if (!isPlainObject(entry)) {
      continue;
    }

    if (typeof entry.steamId !== "string" || typeof entry.sessionId !== "string") {
      continue;
    }

    normalizedSessionsByTokenHash[tokenHash] = {
      steamId: entry.steamId,
      sessionId: entry.sessionId
    };
  }

  return {
    version: STATE_VERSION,
    globalCoins: Math.max(0, Number(source.globalCoins || 0)),
    grants,
    players: normalizedPlayers,
    sessionsByTokenHash: normalizedSessionsByTokenHash
  };
}

async function readState() {
  try {
    const text = await fs.readFile(DATA_FILE, "utf8");
    return normalizeState(JSON.parse(text));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }

    return normalizeState({});
  }
}

async function writeState(state) {
  const normalized = normalizeState(state);
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(normalized, null, 2), "utf8");
  await fs.rename(tmp, DATA_FILE);
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function createSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

function requestIdFromRound(roundId) {
  const hash = crypto.createHash("sha256").update(String(roundId)).digest();
  const value = hash.readBigUInt64BE(0);
  return (value === 0n ? 1n : value).toString();
}

function requestIdFromRoundAndIndex(roundId, index) {
  return requestIdFromRound(`${roundId}:${index}`);
}

function requireAuthConfig() {
  if (!STEAM_PUBLISHER_KEY) {
    throw new Error("STEAM_PUBLISHER_KEY is missing");
  }
}

function requireGrantConfig() {
  requireAuthConfig();
}

async function authenticateSteamTicket(ticket, identity) {
  requireAuthConfig();

  const url = new URL("/ISteamUserAuth/AuthenticateUserTicket/v1/", STEAM_API_BASE);
  url.searchParams.set("key", STEAM_PUBLISHER_KEY);
  url.searchParams.set("appid", STEAM_APP_ID);
  url.searchParams.set("ticket", ticket);
  url.searchParams.set("identity", identity || "steamcoin-backend");

  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`AuthenticateUserTicket HTTP ${response.status}: ${text}`);
  }

  const payload = JSON.parse(text);
  const steamId = payload?.response?.params?.steamid;
  if (!steamId) {
    throw new Error(`AuthenticateUserTicket did not return steamid: ${text}`);
  }

  return steamId;
}

function getPlayer(state, steamId) {
  if (!state.players[steamId]) {
    state.players[steamId] = normalizePlayer({});
  }

  return state.players[steamId];
}

function ensureTimer(player, timerIndex) {
  if (timerIndex !== 0 && timerIndex !== 1) {
    throw new Error("invalid-timer-index");
  }

  if (!player.timers[timerIndex]) {
    player.timers[timerIndex] = createEmptyTimer(timerIndex);
  }

  return player.timers[timerIndex];
}

function isMirrorActive(player, atMs) {
  return Number(player.powerups?.mirrorUntil || 0) > atMs;
}

function syncTimerUnlocksFromPayload(player, payload) {
  const timer1 = ensureTimer(player, 1);
  timer1.unlocked = Boolean(payload?.oldClockActive);
}

function syncPowerupsFromPayload(player, payload, atMs) {
  if (!player.powerups) {
    player.powerups = {
      hammerUntil: 0,
      mirrorUntil: 0
    };
  }

  if (payload?.mirrorActive) {
    player.powerups.mirrorUntil = Math.max(Number(player.powerups.mirrorUntil || 0), atMs + POWERUP_DURATION_MS);
  }

  if (payload?.hammerActive) {
    player.powerups.hammerUntil = Math.max(Number(player.powerups.hammerUntil || 0), atMs + POWERUP_DURATION_MS);
  }
}

function getActiveSessionRef(state, steamId) {
  const player = state.players[steamId];
  if (!player?.currentSession?.active) {
    return null;
  }

  const session = player.currentSession;
  const tokenEntry = state.sessionsByTokenHash[session.tokenHash];
  if (!tokenEntry || tokenEntry.steamId !== steamId || tokenEntry.sessionId !== session.sessionId) {
    return null;
  }

  return { player, session, steamId, tokenHash: session.tokenHash };
}

function resolveGrantSessionRef(state, steamId, sessionToken) {
  const normalizedSessionToken = typeof sessionToken === "string" ? sessionToken.trim() : "";
  if (normalizedSessionToken) {
    const tokenHash = hashToken(normalizedSessionToken);
    const entry = state.sessionsByTokenHash[tokenHash];
    if (entry) {
      const player = state.players[entry.steamId];
      const session = player?.currentSession;
      if (session?.active && session.sessionId === entry.sessionId && session.tokenHash === tokenHash) {
        return { player, session, steamId: entry.steamId, tokenHash, source: "session-token" };
      }
    }
  }

  const activeSession = getActiveSessionRef(state, steamId);
  if (activeSession) {
    return { ...activeSession, source: "active-session-fallback" };
  }

  return null;
}

function flushSessionProgress(player, atMs) {
  const session = player.currentSession;
  if (!session?.active) {
    return 0;
  }

  const elapsed = Math.max(0, atMs - Number(session.lastHeartbeatAt || session.startedAt || atMs));
  if (elapsed <= 0) {
    session.lastHeartbeatAt = atMs;
    session.expiresAt = atMs + SESSION_TIMEOUT_MS;
    return 0;
  }

  session.totalActiveMs = Number(session.totalActiveMs || 0) + elapsed;

  for (const timerIndex of [0, 1]) {
    const timer = ensureTimer(player, timerIndex);
    if (!timer.unlocked) {
      continue;
    }

    const durationMs = getTimerDuration(timerIndex);
    if (durationMs <= 0 || timer.accumulatedMs >= durationMs) {
      continue;
    }

    const nextValue = Math.min(durationMs, timer.accumulatedMs + elapsed);
    timer.accumulatedMs = nextValue;
    if (nextValue >= durationMs && !timer.readyAt) {
      timer.readyAt = toIso(atMs);
    }
  }

  session.lastHeartbeatAt = atMs;
  session.expiresAt = atMs + SESSION_TIMEOUT_MS;
  return elapsed;
}

function finalizeSession(state, steamId, atMs, reason) {
  const player = state.players[steamId];
  if (!player?.currentSession?.active) {
    return null;
  }

  flushSessionProgress(player, atMs);

  const session = player.currentSession;
  session.active = false;
  session.endedAt = toIso(atMs);
  session.endReason = reason;

  player.sessionHistory = [
    {
      sessionId: session.sessionId,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      reason,
      totalActiveMs: Number(session.totalActiveMs || 0)
    },
    ...player.sessionHistory
  ].slice(0, SESSION_HISTORY_LIMIT);

  delete state.sessionsByTokenHash[session.tokenHash];
  player.currentSession = null;

  return session;
}

async function sweepExpiredSessions(state, atMs) {
  let changed = false;

  for (const steamId of Object.keys(state.players)) {
    const player = state.players[steamId];
    const session = player?.currentSession;
    if (!session?.active) {
      continue;
    }

    if (atMs - Number(session.lastHeartbeatAt || session.startedAt || atMs) > SESSION_TIMEOUT_MS + GRANT_GRACE_MS) {
      finalizeSession(state, steamId, atMs, "timeout");
      changed = true;
    }
  }

  if (changed) {
    await writeState(state);
  }

  return changed;
}

function buildTimerSnapshot(player) {
  return [0, 1].map((timerIndex) => {
    const timer = ensureTimer(player, timerIndex);
    const durationMs = getTimerDuration(timerIndex);
    const accumulatedMs = Math.max(0, Math.min(durationMs, Number(timer.accumulatedMs || 0)));

    return {
      index: timerIndex,
      durationMs,
      unlocked: Boolean(timer.unlocked),
      accumulatedMs,
      remainingMs: Math.max(0, durationMs - accumulatedMs),
      ready: Boolean(timer.unlocked) && accumulatedMs >= durationMs,
      running: Boolean(player.currentSession?.active) && Boolean(timer.unlocked) && accumulatedMs < durationMs,
      lastClaimAt: timer.lastClaimAt,
      readyAt: timer.readyAt
    };
  });
}

function buildSessionSnapshot(player) {
  const session = player.currentSession;
  if (!session?.active) {
    return {
      active: false,
      sessionId: null,
      expiresAt: null,
      lastHeartbeatAt: null,
      totalActiveMs: 0
    };
  }

  return {
    active: true,
    sessionId: session.sessionId,
    expiresAt: toIso(session.expiresAt),
    lastHeartbeatAt: toIso(session.lastHeartbeatAt),
    totalActiveMs: Number(session.totalActiveMs || 0)
  };
}

function validateSessionPayload(payload) {
  if (!isPlainObject(payload)) {
    return "invalid-json";
  }

  if (!payload.steamAuthTicket || typeof payload.steamAuthTicket !== "string") {
    return "missing-steam-auth-ticket";
  }

  if (payload.authIdentity !== undefined && typeof payload.authIdentity !== "string") {
    return "invalid-auth-identity";
  }

  return "";
}

function validateHeartbeatPayload(payload) {
  if (!isPlainObject(payload)) {
    return "invalid-json";
  }

  if (!payload.sessionToken || typeof payload.sessionToken !== "string") {
    return "missing-session-token";
  }

  return "";
}

function validateEndPayload(payload) {
  return validateHeartbeatPayload(payload);
}

function validateGrantRequest(payload) {
  if (!isPlainObject(payload)) {
    return "invalid-json";
  }

  if (!payload.roundId || typeof payload.roundId !== "string") {
    return "missing-round-id";
  }

  if (!payload.steamAuthTicket || typeof payload.steamAuthTicket !== "string") {
    return "missing-steam-auth-ticket";
  }

  if (payload.authIdentity !== undefined && typeof payload.authIdentity !== "string") {
    return "invalid-auth-identity";
  }

  if (payload.coinAmount !== 1 && payload.coinAmount !== 2) {
    return "invalid-coin-amount";
  }

  if (payload.timerIndex !== 0 && payload.timerIndex !== 1) {
    return "invalid-timer-index";
  }

  if (payload.sessionToken !== undefined && typeof payload.sessionToken !== "string") {
    return "invalid-session-token";
  }

  return "";
}

async function handleSessionStart(request, response) {
  const payload = await readJsonBody(request);
  const validationError = validateSessionPayload(payload);
  if (validationError) {
    sendJson(response, 400, { ok: false, message: validationError });
    return;
  }

  const steamId = await authenticateSteamTicket(payload.steamAuthTicket, payload.authIdentity);
  const atMs = nowMs();
  const state = await readState();
  await sweepExpiredSessions(state, atMs);

  const player = getPlayer(state, steamId);
  syncTimerUnlocksFromPayload(player, payload);
  syncPowerupsFromPayload(player, payload, atMs);
  if (player.currentSession?.active) {
    finalizeSession(state, steamId, atMs, "replaced");
  }

  const sessionId = crypto.randomUUID();
  const sessionToken = createSessionToken();
  const tokenHash = hashToken(sessionToken);

  player.currentSession = {
    sessionId,
    tokenHash,
    startedAt: atMs,
    lastHeartbeatAt: atMs,
    expiresAt: atMs + SESSION_TIMEOUT_MS,
    active: true,
    totalActiveMs: 0,
    endedAt: null,
    endReason: null
  };

  state.sessionsByTokenHash[tokenHash] = {
    steamId,
    sessionId
  };

  await writeState(state);

  sendJson(response, 200, {
    ok: true,
    steamId,
    sessionId,
    sessionToken,
    serverNow: toIso(atMs),
    sessionTimeoutMs: SESSION_TIMEOUT_MS,
    timers: buildTimerSnapshot(player),
    session: buildSessionSnapshot(player),
    globalCoins: state.globalCoins,
    totalCoinsGoal: TOTAL_COINS_GOAL
  });
}

async function handleSessionHeartbeat(request, response) {
  const payload = await readJsonBody(request);
  const validationError = validateHeartbeatPayload(payload);
  if (validationError) {
    sendJson(response, 400, { ok: false, message: validationError });
    return;
  }

  const atMs = nowMs();
  const state = await readState();
  await sweepExpiredSessions(state, atMs);

  const tokenHash = hashToken(payload.sessionToken);
  const entry = state.sessionsByTokenHash[tokenHash];
  if (!entry) {
    sendJson(response, 401, { ok: false, message: "invalid-session-token" });
    return;
  }

  const player = state.players[entry.steamId];
  const session = player?.currentSession;
  if (!session?.active || session.sessionId !== entry.sessionId || session.tokenHash !== tokenHash) {
    sendJson(response, 409, { ok: false, message: "session-not-active" });
    return;
  }

  syncTimerUnlocksFromPayload(player, payload);
  syncPowerupsFromPayload(player, payload, atMs);

  if (atMs - Number(session.lastHeartbeatAt || session.startedAt || atMs) > SESSION_TIMEOUT_MS + GRANT_GRACE_MS) {
    finalizeSession(state, entry.steamId, atMs, "timeout");
    await writeState(state);
    sendJson(response, 409, { ok: false, message: "session-expired" });
    return;
  }

  const elapsedMsApplied = flushSessionProgress(player, atMs);
  await writeState(state);

  sendJson(response, 200, {
    ok: true,
    steamId: entry.steamId,
    sessionId: session.sessionId,
    serverNow: toIso(atMs),
    session: buildSessionSnapshot(player),
    timers: buildTimerSnapshot(player),
    elapsedMsApplied
  });
}

async function handleSessionEnd(request, response) {
  const payload = await readJsonBody(request);
  const validationError = validateEndPayload(payload);
  if (validationError) {
    sendJson(response, 400, { ok: false, message: validationError });
    return;
  }

  const atMs = nowMs();
  const state = await readState();
  await sweepExpiredSessions(state, atMs);

  const tokenHash = hashToken(payload.sessionToken);
  const entry = state.sessionsByTokenHash[tokenHash];
  if (!entry) {
    sendJson(response, 200, { ok: true, message: "already-ended", session: null });
    return;
  }

  const player = state.players[entry.steamId];
  const session = player?.currentSession;
  if (!session?.active || session.sessionId !== entry.sessionId || session.tokenHash !== tokenHash) {
    sendJson(response, 200, { ok: true, message: "already-ended", session: null });
    return;
  }

  finalizeSession(state, entry.steamId, atMs, "client-end");
  await writeState(state);

  sendJson(response, 200, {
    ok: true,
    message: "session-ended",
    serverNow: toIso(atMs),
    timers: buildTimerSnapshot(player),
    session: buildSessionSnapshot(player)
  });
}

async function handleGrant(request, response) {
  requireGrantConfig();

  let payload;
  try {
    payload = await readJsonBody(request);
  } catch (error) {
    sendJson(response, error.statusCode || 400, { ok: false, message: error.message || "invalid-json" });
    return;
  }

  const validationError = validateGrantRequest(payload);
  if (validationError) {
    sendJson(response, 400, { ok: false, message: validationError });
    return;
  }

  const steamId = await authenticateSteamTicket(payload.steamAuthTicket, payload.authIdentity);
  const atMs = nowMs();
  const state = await readState();
  await sweepExpiredSessions(state, atMs);

  const existing = state.grants[payload.roundId];
  if (existing) {
    if (existing.steamId !== steamId) {
      sendJson(response, 409, { ok: false, message: "round-id-owned-by-another-user" });
      return;
    }

    sendJson(response, 200, {
      ok: true,
      coinAmount: existing.coinAmount,
      globalCoins: state.globalCoins,
      message: "idempotent-replay"
    });
    return;
  }

  let coinAmount = payload.coinAmount;
  let timerIndex = payload.timerIndex;
  let grantMode = "legacy";
  let sessionId = null;

  if (payload.sessionToken || getActiveSessionRef(state, steamId)) {
    const sessionRef = resolveGrantSessionRef(state, steamId, payload.sessionToken);

    if (!sessionRef) {
      sendJson(response, 401, { ok: false, message: "invalid-session-token" });
      return;
    }

    if (sessionRef.steamId !== steamId) {
      sendJson(response, 409, { ok: false, message: "session-does-not-belong-to-ticket" });
      return;
    }

    const player = sessionRef.player;
    const session = sessionRef.session;
    syncTimerUnlocksFromPayload(player, payload);
    syncPowerupsFromPayload(player, payload, atMs);
    if (atMs - Number(session.lastHeartbeatAt || session.startedAt || atMs) > SESSION_TIMEOUT_MS + GRANT_GRACE_MS) {
      finalizeSession(state, steamId, atMs, "timeout");
      await writeState(state);
      sendJson(response, 409, { ok: false, message: "session-expired" });
      return;
    }

    flushSessionProgress(player, atMs);

    const timer = ensureTimer(player, timerIndex);
    if (!timer.unlocked) {
      sendJson(response, 409, { ok: false, message: "timer-locked" });
      return;
    }

    const durationMs = getTimerDuration(timerIndex);
    if (timer.accumulatedMs + GRANT_GRACE_MS < durationMs) {
      sendJson(response, 409, {
        ok: false,
        message: "timer-not-ready",
        timerIndex,
        accumulatedMs: timer.accumulatedMs,
        durationMs,
        remainingMs: Math.max(0, durationMs - timer.accumulatedMs),
        graceMs: GRANT_GRACE_MS
      });
      return;
    }

    coinAmount = isMirrorActive(player, atMs) ? 2 : 1;
    grantMode = "session";
    sessionId = session.sessionId;

    timer.accumulatedMs = 0;
    timer.readyAt = null;
    timer.lastClaimAt = toIso(atMs);

    session.lastHeartbeatAt = atMs;
    session.expiresAt = atMs + SESSION_TIMEOUT_MS;
  } else if (coinAmount !== 1 && coinAmount !== 2) {
    sendJson(response, 400, { ok: false, message: "invalid-coin-amount" });
    return;
  }

  state.globalCoins = Math.min(TOTAL_COINS_GOAL, state.globalCoins + coinAmount);
  state.grants[payload.roundId] = {
    steamId,
    timerIndex,
    coinAmount,
    requestId: requestIdFromRound(payload.roundId),
    sessionId,
    grantMode,
    grantedAt: toIso(atMs)
  };

  await writeState(state);

  sendJson(response, 200, {
    ok: true,
    coinAmount,
    globalCoins: state.globalCoins,
    totalCoinsGoal: TOTAL_COINS_GOAL,
    message: grantMode === "session" ? "grant-validated-ok" : "grant-validated-legacy-ok"
  });
}

async function handleRequest(request, response) {
  try {
    if (request.method === "OPTIONS") {
      response.writeHead(204, jsonHeaders);
      response.end();
      return;
    }

    const atMs = nowMs();
    const state = await readState();

    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        appid: STEAM_APP_ID,
        version: STATE_VERSION,
        sessionTimeoutMs: SESSION_TIMEOUT_MS,
        timers: {
          primary: PRIMARY_TIMER_MS,
          oldClock: OLD_CLOCK_TIMER_MS
        }
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/progress") {
      await sweepExpiredSessions(state, atMs);
      const activeSessions = Object.values(state.players).filter((player) => player?.currentSession?.active).length;
      sendJson(response, 200, {
        ok: true,
        globalCoins: state.globalCoins,
        totalCoinsGoal: TOTAL_COINS_GOAL,
        remainingCoins: Math.max(0, TOTAL_COINS_GOAL - state.globalCoins),
        activeSessions,
        serverNow: toIso(atMs),
        version: STATE_VERSION
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/session/start") {
      await handleSessionStart(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/session/heartbeat") {
      await handleSessionHeartbeat(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/session/end") {
      await handleSessionEnd(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/round/chest-open") {
      await handleGrant(request, response);
      return;
    }

    sendJson(response, 404, { ok: false, message: "not-found" });
  } catch (error) {
    sendJson(response, error.statusCode || 500, {
      ok: false,
      message: error.message || "server-error"
    });
  }
}

http.createServer(handleRequest).listen(PORT, () => {
  console.log(`SteamCoin backend listening on http://127.0.0.1:${PORT}`);
});
