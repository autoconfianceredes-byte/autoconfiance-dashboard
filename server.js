const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let cachedData = {
  lastUpdate: null,
  metrics: null,
  campaigns: null,
  keywords: null,
  error: null
};

const dataFilePath = path.join(__dirname, 'data.json');

function saveDataToFile() {
  fs.writeFileSync(dataFilePath, JSON.stringify(cachedData, null, 2));
}

function loadDataFromFile() {
  try {
    if (fs.existsSync(dataFilePath)) {
      const data = fs.readFileSync(dataFilePath, 'utf8');
      cachedData = JSON.parse(data);
      console.log('Dados carregados do ficheiro');
    }
  } catch (error) {
    console.log('Erro ao carregar ficheiro:', error.message);
  }
}

async function fetchGoogleAdsData() {
  try {
    console.log('Iniciando sincronização com Google Ads API...');
    
    const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID.replace(/-/g, '');
    const accessToken = await getAccessToken();
    
    const headers = {
      'Authorization': `Bearer ${accessToken}`,
      'Developer-Token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
      'Customer-Id': customerId,
      'Content-Type': 'application/json'
    };

    const query = `
      SELECT 
        campaign.id,
        campaign.name,
        metrics.impressions,
        metrics.clicks,
        metrics.cost_micros,
        metrics.conversions,
        metrics.ctr,
        device.type
      FROM campaign
      WHERE segments.date >= '2026-05-01'
        AND segments.date <= '2026-05-12'
    `;

    const response = await axios.post(
      `https://googleads.googleapis.com/v17/customers/${customerId}/googleAds:search`,
      { query },
      { headers }
    );

    const campaigns = response.data.results || [];
    
    let totalImpressions = 0;
    let totalClicks = 0;
    let totalCost = 0;
    let totalConversions = 0;
    let totalCtr = 0;
    let campaignCount = 0;

    const campaignData = {};

    campaigns.forEach(result => {
      if (result.metrics) {
        const cost = (result.metrics.cost_micros || 0) / 1000000;
        totalImpressions += result.metrics.impressions || 0;
        totalClicks += result.metrics.clicks || 0;
        totalCost += cost;
        totalConversions += result.metrics.conversions || 0;
        totalCtr += result.metrics.ctr || 0;
        campaignCount++;

        const campaignId = result.campaign.id;
        if (!campaignData[campaignId]) {
          campaignData[campaignId] = {
            name: result.campaign.name,
            impressions: 0,
            clicks: 0,
            cost: 0,
            conversions: 0,
            ctr: 0
          };
        }
        campaignData[campaignId].impressions += result.metrics.impressions || 0;
        campaignData[campaignId].clicks += result.metrics.clicks || 0;
        campaignData[campaignId].cost += cost;
        campaignData[campaignId].conversions += result.metrics.conversions || 0;
        campaignData[campaignId].ctr += result.metrics.ctr || 0;
      }
    });

    const avgCtr = campaignCount > 0 ? (totalCtr / campaignCount).toFixed(2) : 0;
    const cpa = totalConversions > 0 ? (totalCost / totalConversions).toFixed(2) : 0;

    cachedData = {
      lastUpdate: new Date().toISOString(),
      metrics: {
        impressions: totalImpressions,
        clicks: totalClicks,
        cost: parseFloat(totalCost.toFixed(2)),
        conversions: Math.round(totalConversions),
        ctr: parseFloat(avgCtr),
        cpa: parseFloat(cpa),
        currency: 'EUR'
      },
      campaigns: Object.values(campaignData).map(c => ({
        ...c,
        cost: parseFloat(c.cost.toFixed(2)),
        ctr: parseFloat((c.ctr / (c.ctr > 0 ? 1 : 100)).toFixed(2))
      })),
      error: null
    };

    saveDataToFile();
    console.log('Sincronização completada com sucesso!');
    console.log('Dados:', cachedData.metrics);

  } catch (error) {
    console.error('Erro ao buscar dados do Google Ads:', error.response?.data || error.message);
    cachedData.error = error.response?.data || error.message;
    saveDataToFile();
  }
}

async function getAccessToken() {
  try {
    const response = await axios.post('https://oauth2.googleapis.com/token', {
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    });

    return response.data.access_token;
  } catch (error) {
    console.error('Erro ao obter access token:', error.message);
    throw error;
  }
}

app.get('/api/data', (req, res) => {
  res.json(cachedData);
});

app.get('/api/sync', async (req, res) => {
  await fetchGoogleAdsData();
  res.json({ message: 'Sincronização iniciada', data: cachedData });
});

app.post('/api/config', (req, res) => {
  const { clientId, customerIdAds, email } = req.body;
  
  const envContent = `GOOGLE_CLIENT_ID=${clientId}
GOOGLE_ADS_CUSTOMER_ID=${customerIdAds}
GOOGLE_ADS_DEVELOPER_TOKEN=${process.env.GOOGLE_ADS_DEVELOPER_TOKEN || 'YOUR_DEV_TOKEN'}
GOOGLE_REFRESH_TOKEN=${process.env.GOOGLE_REFRESH_TOKEN || 'YOUR_REFRESH_TOKEN'}
GOOGLE_CLIENT_SECRET=${process.env.GOOGLE_CLIENT_SECRET || 'YOUR_SECRET'}
PORT=3000`;

  fs.writeFileSync(path.join(__dirname, '.env'), envContent);
  res.json({ message: 'Configuração salva. Reinicie o servidor.' });
});

cron.schedule('0 */6 * * *', async () => {
  console.log('Sincronização automática iniciada (a cada 6 horas)');
  await fetchGoogleAdsData();
});

const PORT = process.env.PORT || 3000;

loadDataFromFile();

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
  console.log('📊 Dashboard disponível em http://localhost:' + PORT);
  console.log('⏰ Sincronização automática a cada 6 horas');
  
  if (!process.env.GOOGLE_CLIENT_ID) {
    console.log('⚠️  Aviso: Configure variáveis de ambiente no ficheiro .env');
  } else {
    fetchGoogleAdsData();
  }
});
