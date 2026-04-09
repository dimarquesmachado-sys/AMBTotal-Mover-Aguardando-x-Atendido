const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const TOKEN_FILE = process.env.TOKEN_FILE || '/data/tokens.json';

function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[tokenManager] Erro ao carregar tokens:', e.message);
  }
  return null;
}

function saveTokens(tokens) {
  try {
    const dir = path.dirname(TOKEN_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
  } catch (e) {
    console.error('[tokenManager] Erro ao salvar tokens:', e.message);
  }
}

async function refreshAccessToken() {
  const tokens = loadTokens();
  if (!tokens || !tokens.refresh_token) {
    throw new Error('Nenhum refresh_token disponível. Execute /setup primeiro.');
  }

  const clientId = process.env.BLING_CLIENT_ID;
  const clientSecret = process.env.BLING_CLIENT_SECRET;
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await fetch('https://www.bling.com.br/Api/v3/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token
    })
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Falha ao renovar token Bling: ${res.status} ${txt}`);
  }

  const newTokens = await res.json();
  newTokens.obtained_at = Date.now();
  saveTokens(newTokens);
  console.log('[tokenManager] Token Bling renovado com sucesso.');
  return newTokens.access_token;
}

async function getAccessToken() {
  const tokens = loadTokens();
  if (!tokens) throw new Error('Tokens não encontrados. Execute /setup.');

  const expiresIn = tokens.expires_in || 21600;
  const obtainedAt = tokens.obtained_at || 0;
  const age = (Date.now() - obtainedAt) / 1000;

  if (age >= expiresIn - 60) {
    console.log('[tokenManager] Token Bling expirado/prestes a expirar, renovando...');
    return await refreshAccessToken();
  }

  return tokens.access_token;
}

async function exchangeCodeForToken(authCode) {
  const clientId = process.env.BLING_CLIENT_ID;
  const clientSecret = process.env.BLING_CLIENT_SECRET;
  const redirectUri = process.env.BLING_REDIRECT_URI;
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await fetch('https://www.bling.com.br/Api/v3/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authCode,
      redirect_uri: redirectUri
    })
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Falha ao trocar código: ${res.status} ${txt}`);
  }

  const tokens = await res.json();
  tokens.obtained_at = Date.now();
  saveTokens(tokens);
  console.log('[tokenManager] Tokens Bling obtidos e salvos.');
  return tokens;
}

module.exports = { getAccessToken, exchangeCodeForToken, loadTokens };
