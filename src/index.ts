import { createApp } from './app.js';
import { loadConfig } from './config.js';
import {Pool} from 'pg';
import {createService} from './service.js';
import {createOAuth} from './oauth.js';
import {createAuthenticator} from './auth.js';

const config = loadConfig();
const pool=new Pool({connectionString:config.databaseUrl,max:10,connectionTimeoutMillis:5000,statement_timeout:15000});
const service=createService(pool,config.ownerId);
const provider=createOAuth(config,pool);
const server = createApp(config,createAuthenticator(config,provider,service),provider).listen(config.port, config.host, () => {
  console.info(`Game Companion listening on ${config.host}:${config.port}`);
});
server.requestTimeout = 30000;
server.headersTimeout = 10000;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { server.close(() => {void pool.end().then(()=>process.exit(0));}); setTimeout(() => process.exit(1), 10000).unref(); });
}
