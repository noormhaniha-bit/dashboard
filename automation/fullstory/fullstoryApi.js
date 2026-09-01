// fullstoryApi.js
const axios = require('axios');
require('dotenv').config();

const API_KEY = process.env.FULLSTORY_API_KEY;
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS_PER_APP || '10', 10);

function getBase() {
  return API_KEY?.startsWith('eu1') ? 'https://api.eu1.fullstory.com' : 'https://api.fullstory.com';
}

function authHeaders() {
  return { Authorization: `Basic ${API_KEY}`, Accept: 'application/json' };
}

async function apiGet(path, params = {}) {
  const res = await axios.get(`${getBase()}${path}`, {
    headers: authHeaders(),
    params,
    validateStatus: () => true,
  });
  return res;
}

/**
 * Given a FS customer uid, returns up to MAX_SESSIONS sessions.
 * Uses app_url from the API response — contains the correct numeric session URL.
 */
async function getSessionsForUid(uid) {
  const sessions = [];
  let pageToken = null;

  while (sessions.length < MAX_SESSIONS) {
    const params = { uid, limit: Math.min(MAX_SESSIONS - sessions.length, 50) };
    if (pageToken) params.page_token = pageToken;

    const res = await apiGet('/v2/sessions', params);
    if (res.status !== 200) {
      throw new Error(`GET /v2/sessions failed ${res.status}: ${JSON.stringify(res.data)}`);
    }

    const results = res.data.results || [];
    for (const s of results) {
      if (!s.app_url) continue;
      sessions.push({
        sessionId: s.id,
        replayUrl: s.app_url,
        startTime: s.created_time,
      });
    }

    pageToken = res.data.next_page_token;
    if (!pageToken || results.length === 0) break;
  }

  return sessions;
}

/**
 * Enriches browser-scraped sessions (which only have replayUrl) with startTime
 * by attempting an API lookup for the uid, if available.
 */
async function enrichSessions(scrapedSessions, uid) {
  if (!uid) return scrapedSessions;
  try {
    const apiSessions = await getSessionsForUid(uid);
    return scrapedSessions.map(scraped => {
      const match = apiSessions.find(a => a.replayUrl === scraped.replayUrl);
      return match ? { ...scraped, startTime: match.startTime } : scraped;
    });
  } catch {
    return scrapedSessions;
  }
}

module.exports = { getSessionsForUid, enrichSessions };
