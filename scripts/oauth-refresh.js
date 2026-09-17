const http = require('http');
const fs = require('fs');
const path = require('path');
const { OAuth2Client } = require('google-auth-library');

const REDIRECT_PORT = 3000;
const REDIRECT_PATH = '/';
const REDIRECT_URI = process.argv[2] || `http://localhost:${REDIRECT_PORT}${REDIRECT_PATH}`;

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

(async () => {
  const clientId = readEnv('GOOGLE_CLIENT_ID');
  const clientSecret = readEnv('GOOGLE_CLIENT_SECRET');

  const client = new OAuth2Client(clientId, clientSecret, REDIRECT_URI);

  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
  });

  console.log('Opening the browser... login and grant access.');
  console.log('Redirect URI used:', REDIRECT_URI);
  console.log('If this URI is not registered in Google Cloud Console, pass it as an argument:');
  console.log('  node scripts/oauth-refresh.js http://localhost:3000/callback');
  console.log('\nAuth URL:');
  console.log(authUrl);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, REDIRECT_URI);
      const code = url.searchParams.get('code');
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h3>No authorization code found. Close this tab.</h3>');
        return;
      }

      const { tokens } = await client.getToken(code);
      console.log('\nToken exchange succeeded.');

      if (!tokens.refresh_token) {
        console.log('WARNING: No refresh_token returned. Token:', tokens);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h3>No refresh token returned (already authorized before). Re-run with "revoke" or use a different account.</h3>');
        server.close();
        return;
      }

      updateEnv('GOOGLE_REFRESH_TOKEN', tokens.refresh_token);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h3>Authorization successful! You can close this tab.</h3>');
      console.log('Refresh token has been written to .env');
      server.close();
    } catch (err) {
      console.error('Token exchange failed:', err.message);
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end('<h3>Authorization failed. See terminal for details.</h3>');
      server.close();
    }
  });

  const port = new URL(REDIRECT_URI).port || 80;
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `\nPort ${port} is already in use.`,
      );
      console.error(`Hint: stop whatever is running on ${port} (e.g. the app's own server), then rerun:`);
      console.error(`  node scripts/oauth-refresh.js ${REDIRECT_URI}`);
      console.error(`Or pass a different registered redirect URI, e.g.:`);
      console.error(`  node scripts/oauth-refresh.js http://localhost:3345/`);
    } else {
      console.error('\nServer error:', err.message);
    }
    server.close();
    process.exit(1);
  });
  server.listen(port, 'localhost', () => {
    console.log(`\nWaiting for the callback on http://localhost:${port}${REDIRECT_PATH}`);
  });
})();