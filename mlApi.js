const fetch = require('node-fetch');
const mlTokenManager = require('./mlTokenManager');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Consulta o substatus de um shipment no ML.
 * Retorna o substatus (ex: "buffered", "ready_to_ship", etc.) ou null em caso de erro.
 */
async function consultarSubstatusShipment(shipmentId, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const token = await mlTokenManager.getAccessToken();
      await sleep(300);

      const res = await fetch(`https://api.mercadolibre.com/shipments/${shipmentId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (res.status === 429) {
        const wait = attempt * 2000;
        console.warn(`[mlApi] Rate limit 429 em shipment ${shipmentId}. Aguardando ${wait}ms...`);
        await sleep(wait);
        continue;
      }

      if (res.status === 401 && attempt < retries) {
        console.warn('[mlApi] 401, renovando token ML...');
        await sleep(1000);
        continue;
      }

      if (!res.ok) {
        const txt = await res.text();
        console.error(`[mlApi] Erro ao consultar shipment ${shipmentId}: ${res.status} ${txt}`);
        return null;
      }

      const data = await res.json();
      const substatus = data?.substatus || null;
      console.log(`[mlApi] Shipment ${shipmentId} substatus: ${substatus}`);
      return substatus;

    } catch (e) {
      console.error(`[mlApi] Exceção ao consultar shipment ${shipmentId} (tentativa ${attempt}):`, e.message);
      if (attempt < retries) await sleep(1500);
    }
  }

  console.error(`[mlApi] Falhou após ${retries} tentativas para shipment ${shipmentId}.`);
  return null;
}

module.exports = { consultarSubstatusShipment };
