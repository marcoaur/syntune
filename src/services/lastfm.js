/**
 * @module  services/lastfm
 * @badge   🟦 SERVICE · NETWORK · CRYPTO(md5-sig) · STATELESS
 * @role    Last.fm web-auth flow, scrobble, track playcount, artist info. Pure fns; caller injects keys.
 * @inputs  { apiKey, secret, sessionKey, artist, title, timestamp }
 * @outputs { sessionKey,username } | { error } | { success } | { playcount,listeners,tags } | { bio,... } | null
 * @deps    crypto, electron(shell), global fetch, ../../i18n
 * @notes   No app config access — main.js IPC handlers read cfg and pass keys in.
 */
const crypto = require('crypto');
const { shell } = require('electron');
const i18n = require('../../i18n');
const t = i18n.t;

function sign(params, secret) {
  const keys = Object.keys(params).filter(k => k !== 'format' && k !== 'callback').sort();
  let str = '';
  for (const k of keys) {
    str += k + params[k];
  }
  str += secret;
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

async function authSession({ apiKey, secret }) {
  try {
    const resToken = await fetch(`https://ws.audioscrobbler.com/2.0/?method=auth.getToken&api_key=${encodeURIComponent(apiKey)}&format=json`);
    const dataToken = await resToken.json();
    if (!dataToken.token) return { error: dataToken.message || t('main.lastfmTokenFail') };

    const token = dataToken.token;
    shell.openExternal(`https://www.last.fm/api/auth/?api_key=${encodeURIComponent(apiKey)}&token=${encodeURIComponent(token)}`);

    for (let i = 0; i < 45; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const sig = sign({ api_key: apiKey, method: 'auth.getSession', token }, secret);
      const resSess = await fetch(`https://ws.audioscrobbler.com/2.0/?method=auth.getSession&api_key=${encodeURIComponent(apiKey)}&token=${encodeURIComponent(token)}&api_sig=${encodeURIComponent(sig)}&format=json`);
      const dataSess = await resSess.json();
      if (dataSess.session) {
        return { sessionKey: dataSess.session.key, username: dataSess.session.name };
      }
      if (dataSess.error && dataSess.error !== 14) {
        return { error: dataSess.message || t('main.lastfmAuthError') };
      }
    }
    return { error: t('main.lastfmAuthTimeout') };
  } catch (err) {
    return { error: err.message };
  }
}

// Caller (main.js) já validou enabled + presença das chaves antes de chamar.
async function scrobble({ apiKey, secret, sessionKey, artist, title, timestamp }) {
  try {
    const params = {
      method: 'track.scrobble',
      api_key: apiKey.trim(),
      sk: sessionKey.trim(),
      'artist[0]': artist,
      'track[0]': title,
      'timestamp[0]': String(timestamp)
    };
    const sig = sign(params, secret.trim());
    params.api_sig = sig;
    params.format = 'json';

    const form = new URLSearchParams();
    for (const k in params) form.append(k, params[k]);

    const res = await fetch('https://ws.audioscrobbler.com/2.0/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    });
    const data = await res.json();
    return { success: !data.error };
  } catch {
    return { success: false };
  }
}

async function getPlaycount({ apiKey, artist, title }) {
  if (!artist || !title) return null;
  const key = (apiKey || '').trim();
  if (!key) return null;

  try {
    const url = `https://ws.audioscrobbler.com/2.0/?method=track.getInfo&api_key=${encodeURIComponent(key)}&artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(title)}&format=json&autocorrect=1`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Syntune/1.0' } });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.track) {
      const playcount = data.track.playcount || '0';
      const listeners = data.track.listeners || '0';
      const tags = (data.track.toptags && Array.isArray(data.track.toptags.tag))
        ? data.track.toptags.tag.slice(0, 5).map(t => t.name)
        : [];
      return { playcount, listeners, tags };
    }
  } catch (err) {
    console.error('Erro Last.fm API:', err.message);
  }
  return null;
}

async function getArtistInfo({ apiKey, artist }) {
  if (!artist) return null;
  const key = (apiKey || '').trim();
  if (!key) return null;

  try {
    const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getInfo&api_key=${encodeURIComponent(key)}&artist=${encodeURIComponent(artist)}&format=json&autocorrect=1&lang=${encodeURIComponent(i18n.getLanguage().split('-')[0])}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Syntune/1.0' } });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.artist) {
      const bio = data.artist.bio && data.artist.bio.summary ? data.artist.bio.summary : '';
      const playcount = data.artist.stats ? data.artist.stats.playcount : '0';
      const listeners = data.artist.stats ? data.artist.stats.listeners : '0';
      const tags = (data.artist.tags && Array.isArray(data.artist.tags.tag))
        ? data.artist.tags.tag.slice(0, 5).map(t => t.name)
        : [];
      return { bio, playcount, listeners, tags };
    }
  } catch (err) {
    console.error('Erro Last.fm Artist API:', err.message);
  }
  return null;
}

module.exports = { sign, authSession, scrobble, getPlaycount, getArtistInfo };
