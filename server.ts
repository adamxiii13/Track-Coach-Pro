import express from 'express';
import { createServer as createViteServer } from 'vite';
import { google } from 'googleapis';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import SQLiteStoreFactory from 'connect-sqlite3';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Database (Only for sessions if needed, but connect-sqlite3 handles its own)
const db = new Database('sessions.db');

const app = express();
const PORT = 3000;

const SQLiteStore = SQLiteStoreFactory(session);

app.set('trust proxy', 1);

app.use(express.json());
app.use(cookieParser());
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: '.' }) as any,
  secret: process.env.SESSION_SECRET || 'track-coach-pro-secret-key-123',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: true, 
    sameSite: 'lax',
    httpOnly: true,
    maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
  }
}));

const getOAuth2Client = () => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const appUrl = process.env.APP_URL;

  if (!clientId || !clientSecret || !appUrl) {
    throw new Error('Missing environment variables');
  }

  return new google.auth.OAuth2(
    clientId,
    clientSecret,
    `${appUrl.replace(/\/$/, '')}/auth/google/callback`
  );
};

// Auth URL
app.get('/api/auth/google/url', (req, res) => {
  try {
    const client = getOAuth2Client();
    const url = client.generateAuthUrl({
      access_type: 'offline',
      scope: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive.file'
      ],
      prompt: 'consent'
    });
    res.json({ url });
  } catch (error) {
    console.error('Auth URL error:', error);
    res.status(500).json({ 
      error: 'Server configuration incomplete. Please set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and APP_URL in Settings.' 
    });
  }
});

// Callback
app.get(['/auth/google/callback', '/auth/google/callback/'], async (req, res) => {
  const { code } = req.query;
  console.log('OAuth callback received with code');
  try {
    const client = getOAuth2Client();
    const { tokens } = await client.getToken(code as string);
    console.log('Tokens retrieved successfully');
    (req.session as any).tokens = tokens;
    
    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
      }
      
      res.send(`
        <html>
          <body>
            <script>
              if (window.opener) {
                window.opener.postMessage({ 
                  type: 'OAUTH_AUTH_SUCCESS',
                  tokens: ${JSON.stringify(tokens)}
                }, '*');
                window.close();
              } else {
                window.location.href = '/';
              }
            </script>
            <p>Authentication successful. This window should close automatically.</p>
          </body>
        </html>
      `);
    });
  } catch (error: any) {
    console.error('Error getting tokens:', error);
    const details = error.response?.data || error.message;
    res.status(500).send(`Authentication failed: ${JSON.stringify(details)}`);
  }
});

// Custom Auth Routes Removed (Using Firebase)

// Data Persistence (Handled by Firestore)

// Export to Sheets
app.post('/api/export/sheets', async (req, res) => {
  console.log('Export request received');
  let tokens = req.body.tokens || (req.session as any).tokens;
  
  if (!tokens) {
    console.log('No tokens found in request or session');
    return res.status(401).json({ error: 'Not authenticated' });
  }
  console.log('Tokens found, proceeding with export');

  const { raceName, meetName, runners } = req.body;
  
  try {
    const client = getOAuth2Client();
    client.setCredentials(tokens);
    const sheets = google.sheets({ version: 'v4', auth: client });

    // 1. Create a new spreadsheet
    const spreadsheet = await sheets.spreadsheets.create({
      requestBody: {
        properties: {
          title: `${raceName} - ${meetName || 'Track Meet'} - ${new Date().toLocaleDateString()}`,
        },
      },
    });

    const spreadsheetId = spreadsheet.data.spreadsheetId!;

    // 2. Prepare data
    const rows = [];
    // Header
    rows.push(['Race Name', raceName]);
    rows.push(['Meet Name', meetName || 'N/A']);
    rows.push(['Export Date', new Date().toLocaleString()]);
    rows.push([]); // Spacer
    rows.push(['Runner Name', 'Total Time', 'Log Type', 'Segment Time', 'Cumulative Time']);

    runners.forEach((runner: any) => {
      rows.push([runner.name, runner.totalTime, 'TOTAL', runner.totalTime, runner.totalTime]);
      runner.logs.forEach((log: any) => {
        rows.push(['', '', `${log.type} ${log.number || ''}`, log.formatted, log.formattedCumulative || log.formatted]);
      });
      rows.push([]); // Spacer between runners
    });

    // 3. Write data
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'Sheet1!A1',
      valueInputOption: 'RAW',
      requestBody: {
        values: rows,
      },
    });

    res.json({ url: spreadsheet.data.spreadsheetUrl });
  } catch (error: any) {
    console.error('Export error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Vite middleware
if (process.env.NODE_ENV !== 'production') {
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa',
  });
  app.use(vite.middlewares);
} else {
  app.use(express.static(path.join(__dirname, 'dist')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
