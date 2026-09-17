const fs = require('fs');
const path = require('path');

// OAuth 2.0 Device Authorization Grant — designed for headless / browserless
// machines. The operator approves once on any device (phone/laptop) via
// https://google.com/device; no browser is needed on this machine.

function readEnv(name) {
  const envPath = path.join(__dirname, '..', '.env');
  const content = fs.readFileSync(envPath, 'utf8');
  const match = content.match(new RegExp(`^${name}=(.*)$`, 'm'));
  if (!match) throw new Error(`Missing ${name} in .env`);
  return match[1].trim();
}

function updateEnv(name, value) {
  const envPath = path.join(__dirname, '..', '.env');
  const content = fs.readFileSync(envPath, 'utf8');
  const updated = content.replace(
    new RegExp(`^${name}=.*$`, 'm'),
    `${name}=${value}`,
  );
  fs.writeFileSync(envPath, updated, 'utf8');
  console.log(`Updated ${name} in .env`);
}

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
];

async function requestDeviceCode(clientId) {
  const body = new URLSearchParams({
    client_id: clientId,
    scope: SCOPES.join(' '),
  });
  const res = await fetch('https://oauth2.googleapis.com/device/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json();
  if (!res.ok) {
    if (data.error === 'invalid_client') {
      throw new Error(
        'Google rejected the client for device flow. In Google Cloud Console -> Credentials, ' +
          'create an OAuth client ID of type "TVs and Limited Input devices", put its ' +
          'client ID and secret into .env (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET), and rerun this script.',
      );
    }
    throw new Error(`Device code request failed: ${JSON.stringify(data)}`);
  }
  return data;
}

async function pollForTokens(clientId, clientSecret, deviceCode) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json();
  if (!res.ok) {
    if (data.error === 'authorization_pending') return null;
    if (data.error === 'slow_down') return { slowDown: true };
    if (data.error === 'access_denied') {
      throw new Error('Access was denied by the user. Run the script again to retry.');
    }
    if (data.error === 'expired_token') {
      throw new Error('The device code expired. Run the script again to get a new code.');
    }
    throw new Error(`Token request failed: ${JSON.stringify(data)}`);
  }
  return data;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  try {
    const clientId = readEnv('GOOGLE_CLIENT_ID');
    const clientSecret = readEnv('GOOGLE_CLIENT_SECRET');

    console.log('Requesting a device code...');
    const device = await requestDeviceCode(clientId);

    console.log('\n====================================================');
    console.log('On ANY device with a browser (e.g. your phone):');
    console.log(`  1. Open:   ${device.verification_url}`);
    console.log(`  2. Enter:  ${device.user_code}`);
    console.log('  3. Sign in as the HR Google account and click Allow.');
    console.log('====================================================\n');

    let pollIntervalMs = (device.interval || 5) * 1000;
    const expiresAt = Date.now() + device.expires_in * 1000;

    while (Date.now() < expiresAt) {
      await sleep(pollIntervalMs);
      const tokens = await pollForTokens(clientId, clientSecret, device.device_code);

      if (tokens) {
        if (tokens.slowDown) {
          pollIntervalMs += 5000;
          continue;
        }
        if (!tokens.refresh_token) {
          throw new Error('No refresh_token in response. Tokens: ' + JSON.stringify(tokens));
        }
        updateEnv('GOOGLE_REFRESH_TOKEN', tokens.refresh_token);
        console.log('\nAuthorization successful! GOOGLE_REFRESH_TOKEN saved to .env');
        console.log('The app can now fetch fresh access tokens without any browser.');
        process.exit(0);
      }

      console.log('Waiting for approval...');
    }

    console.error('\nTimed out waiting for approval. Run the script again for a fresh code.');
    process.exit(1);
  } catch (err) {
    console.error('\nError:', err.message);
    process.exit(1);
  }
})();