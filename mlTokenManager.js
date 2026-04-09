const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const ML_TOKEN_FILE = process.env.ML_TOKEN_FILE || '/data/ml_tokens.json';

function loadTokens() {
  try {
    if (fs.existsSync(ML_TOKEN_FILE)) {
      return JSON.parse(fs.readFileSync(ML_TOKEN_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[mlTokenManager] Erro ao carregar tokens ML:', e.message);
  }
  return null;
}

function saveTokens(tokens) {
  try {
    const dir = path.dirname(ML_TOKEN_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ML_TOKEN_FILE, JSON.stringify(tokens, null, 2));
  } catch (e) {
    console.error('[mlTokenManager] Erro ao salvar tokens ML:', e.message);
  }
}

async function refreshAccessToken() {
  const tokens = loadTokens();
  if (!tokens || !tokens.refresh_token) {
    throw new Error('Nenhum refresh_token ML disponível. Execute /setup-ml primeiro.');
  }

  const res = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.ML_CLIENT_ID,
      client_secret: process.env.ML_CLIENT_SECRET,
      refresh_token: tokens.refresh_token
    })
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Falha ao renovar token ML: ${res.status} ${txt}`);
  }

  const newTokens = await res.json();
  newTokens.obtained_at = Date.now();
  saveTokens(newTokens);
  console.log('[mlTokenManager] Token ML renovado com sucesso.');
  return newTokens.access_token;
}

async function getAccessToken() {
  const tokens = loadTokens();
  if (!tokens) throw new Error('Tokens ML não encontrados. Execute /setup-ml.');

  const expiresIn = tokens.expires_in || 21600;
  const obtainedAt = tokens.obtained_at || 0;
  const age = (Date.now() - obtainedAt) / 1000;

  if (age >= expiresIn - 60) {
    console.log('[mlTokenManager] Token ML expirado/prestes a expirar, renovando...');
    return await refreshAccessToken();
  }

  return tokens.access_token;
}

async function exchangeCodeForToken(authCode) {
  const res = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: process.env.ML_CLIENT_ID,
      client_secret: process.env.ML_CLIENT_SECRET,
      code: authCode,
      redirect_uri: process.env.BLING_REDIRECT_URI.replace('/callback', '/callback-ml')
    })
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Falha ao trocar código ML: ${res.status} ${txt}`);
  }

  const tokens = await res.json();
  tokens.obtained_at = Date.now();
  saveTokens(tokens);
  console.log('[mlTokenManager] Tokens ML obtidos e salvos.');
  return tokens;
}

module.exports = { getAccessToken, exchangeCodeForToken, loadTokens };
