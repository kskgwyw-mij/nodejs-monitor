import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { loadDotEnv } from './env.js';

// Files we create (database, WAL, etc.) are readable by this user only.
process.umask(0o077);

loadDotEnv();
const config = loadConfig();
const db = openDatabase(config.databasePath);
const app = createApp({ config, db });

if (!config.isProduction && !process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET not set: using a random secret (sessions reset on restart). Set it for production.');
}

const serverOptions = {
  maxHeaderSize: 16 * 1024,
  requestTimeout: 30_000, // whole request must arrive within 30s
  headersTimeout: 15_000, // headers within 15s (slowloris mitigation)
  keepAliveTimeout: 5_000,
};

const server = config.tls
  ? https.createServer(
      {
        ...serverOptions,
        cert: readFileSync(config.tls.certFile),
        key: readFileSync(config.tls.keyFile),
        minVersion: 'TLSv1.2',
      },
      app,
    )
  : http.createServer(serverOptions, app);

server.maxHeadersCount = 100;
server.maxRequestsPerSocket = 1000;

server.listen(config.port, config.host, () => {
  const { address, port } = server.address();
  const scheme = config.tls ? 'https' : 'http';
  const shown = address.includes(':') ? `[${address}]` : address;
  console.log(`SecureNotes listening on ${scheme}://${shown}:${port} (${config.nodeEnv}, Node ${process.version})`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down...`);
  server.close(() => {
    app.locals.sessionStore.close();
    db.close();
    process.exit(0);
  });
  server.closeIdleConnections();
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
