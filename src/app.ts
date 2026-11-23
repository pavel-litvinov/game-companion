import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { ZodError } from 'zod';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { Config } from './config.js';
import { type Authenticate } from './auth.js';
import type {Provider} from 'oidc-provider';
import { isCommand } from './schema.js';
import { AppError } from './service.js';
import { createMcpEndpoint } from './mcp.js';
import { installOAuthRoutes } from './oauth.js';

export function createApp(config: Config, authenticate: Authenticate, provider?:Provider) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use((req, res, next) => {
    const origin = req.get('origin');
    const allowedHost = new URL(config.publicUrl).host;
    // OAuth browser redirect chains can legitimately carry Origin: null.
    // Their forms use signed interaction cookies + our per-interaction CSRF
    // token; oidc-provider validates OAuth state/redirects/PKCE itself. Apply
    // strict Origin checks to the bearer API, rather than breaking OAuth.
    const bearerApi=req.path==='/mcp'||req.path.startsWith('/v1/');
    if (req.get('host') !== allowedHost || (bearerApi && origin && origin !== new URL(config.publicUrl).origin)) {
      res.status(403).json({ error: 'untrusted_origin_or_host' }); return;
    }
    // TLS terminates at our local tunnel. Do not let client-supplied proxy
    // headers change the provider's canonical issuer or generated URLs.
    req.headers['x-forwarded-host']=allowedHost;
    req.headers['x-forwarded-proto']=new URL(config.publicUrl).protocol.slice(0,-1);
    next();
  });
  app.use(rateLimit({ windowMs: 60000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }));
  app.use('/reg',rateLimit({windowMs:3600000,limit:10,standardHeaders:'draft-8',legacyHeaders:false}));
  app.get('/healthz', (_req, res) => { res.json({ status: 'ok', version: '0.1.0' }); });
  const resource = `${config.publicUrl}/mcp`;
  const metadata = {
    resource, authorization_servers: [config.publicUrl],
    scopes_supported: ['companion','offline_access'], bearer_methods_supported: ['header'], resource_name: 'Game Companion',
  };
  app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (_req, res) => { res.json(metadata); });
  app.use(['/v1','/mcp'],express.json({ limit: '100kb', strict: true }));
  app.post('/v1/commands/:action', async (req, res) => {
    const service = await authenticate(req.get('authorization'), false);
    if (!isCommand(req.params.action)) throw new AppError(404, 'unknown_command');
    res.json(await service.command(req.params.action, req.body));
  });
  app.post('/v1/query', async (req, res) => {
    const service = await authenticate(req.get('authorization'), false);
    res.json(await service.query(req.body));
  });
  app.all('/mcp', async (req, res) => {
    if (req.method !== 'POST') { res.set('Allow', 'POST').status(405).json({ error: 'method_not_allowed' }); return; }
    const service = await authenticate(req.get('authorization'), true);
    const handler = createMcpEndpoint(service);
    try { await toNodeHandler(handler, { maxRequestBodySize: 100000 })(req, res, req.body); }
    finally { await handler.close(); }
  });
  if(provider) installOAuthRoutes(app,config,provider);
  app.use((_req, res) => { res.status(404).json({ error: 'not_found' }); });
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    let status = error instanceof AppError ? error.status : error instanceof ZodError ? 422 : 500;
    let code = error instanceof AppError ? error.code : error instanceof ZodError ? 'invalid_input' : 'internal_error';
    if (error?.type === 'entity.too.large') { status = 413; code = 'body_too_large'; }
    if (error?.type === 'entity.parse.failed') { status = 400; code = 'invalid_json'; }
    if (error?.name==='SessionNotFound') {status=400;code='authorization_expired_restart_connection';}
    if (status === 401) res.set('WWW-Authenticate', `Bearer resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource/mcp"`);
    // Never include database details, tokens, request bodies, or source text.
    res.status(status).json({ error: code });
  };
  app.use(errors);
  return app;
}
