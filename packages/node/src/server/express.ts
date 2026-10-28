// The Express adapter: maps Express requests onto the framework-free handlers (handlers.ts).
//
// express is a peer dependency, loaded lazily with require() the first time a router is
// built, so hosts that never call router()/webhookRouter() can run without it installed.
// Only types are imported statically. (tsup's `shims` makes import.meta.url work in CJS.)
import { createRequire } from 'node:module';
import type { NextFunction, Request, Response, Router } from 'express';
import type { ResolvedOptions } from '../client.js';
import type { Logger } from '../types.js';
import type { Handler, HttpRequest, HttpResponse } from './handlers.js';

type ExpressModule = typeof import('express');

const INBOUND = /^\/inbound\/[^/]+$/;

let expressModule: ExpressModule | undefined;
function loadExpress(): ExpressModule {
  try {
    expressModule ??= createRequire(import.meta.url)('express') as ExpressModule;
  } catch (err) {
    throw new Error('goto-sms: router() and webhookRouter() need express; npm install express', {
      cause: err,
    });
  }
  return expressModule;
}

export interface RouterSource {
  options: ResolvedOptions;
  logger: Logger;
  handle: Handler;
}

/** Express's string | string[] query and header values, flattened to one string each. */
function flatten(o: Record<string, unknown>, join: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string') out[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
      const first = v[0] as string | undefined;
      if (first !== undefined) out[k] = join ? v.join(', ') : first;
    }
  }
  return out;
}

function send(res: Response, out: HttpResponse): void {
  // Status and log entries change; nothing here should come from a cache.
  res.set('Cache-Control', 'no-store');
  if (out.redirect !== undefined) {
    res.redirect(out.status, out.redirect);
  } else if (out.html !== undefined) {
    // The admin page: never framed by another site (clickjacking).
    res.set({ 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" });
    res.status(out.status).type('html').send(out.html);
  } else if (out.json !== undefined) {
    res.status(out.status).json(out.json);
  } else {
    res.status(out.status).end();
  }
}

/**
 * Builds the Express router over `src.handle`. With `inboundOnly`, only `POST /inbound/:secret`
 * is handled and everything else falls through to the host's routes.
 */
export function buildExpressRouter(src: RouterSource, o: { inboundOnly?: boolean } = {}): Router {
  const express = loadExpress();
  const router = express.Router();
  const { mountPath } = src.options;
  let warned = false;

  if (o.inboundOnly) {
    router.use((req: Request, _res: Response, next: NextFunction) => {
      if (req.method === 'POST' && INBOUND.test(req.path)) next();
      else next('router');
    });
  }
  router.use(express.json({ limit: '100kb' }));
  router.use((req: Request, res: Response, next: NextFunction) => {
    // The redirect URI and webhook URL are built from the mountPath option, not the request.
    if (!warned && req.baseUrl !== mountPath) {
      warned = true;
      src.logger.warn(
        `goto-sms: mounted at ${req.baseUrl || '/'} but mountPath option is ${mountPath || '/'}; the redirect URI shown will be wrong`,
      );
    }
    // A HEAD (link prefetchers, scanners) must not consume the single-use OAuth state.
    if (req.method === 'HEAD' && req.path === '/callback') {
      res.set('Cache-Control', 'no-store');
      res.status(200).end();
      return;
    }
    const method = req.method === 'HEAD' ? 'GET' : req.method; // Express drops HEAD bodies
    // `/goto-sms` → `./goto-sms/`, so the page's relative URLs resolve under the mount. Kept
    // relative (last segment only) so it also works behind a proxy that strips a prefix.
    const pathname = req.originalUrl.split('?')[0] ?? '';
    if (!o.inboundOnly && method === 'GET' && req.path === '/' && !pathname.endsWith('/')) {
      const last = pathname.slice(pathname.lastIndexOf('/') + 1);
      res.redirect(302, `./${last}/${req.originalUrl.slice(pathname.length)}`);
      return;
    }
    const r: HttpRequest = {
      method,
      path: req.path,
      query: flatten(req.query as Record<string, unknown>, false),
      headers: flatten(req.headers, true),
      body: req.body as unknown,
      raw: req,
    };
    // .catch after .then, so a throwing send() (e.g. res.json) also reaches next() instead of
    // becoming an unhandled rejection that would crash the host.
    src
      .handle(r)
      .then((out) => send(res, out))
      .catch(next);
  });
  // Body-parser failures as the contract's JSON errors, instead of Express's HTML page.
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    const e = err as { type?: string; status?: number };
    if (res.headersSent) return next(err);
    src.logger.debug('goto-sms: request body rejected', { type: e.type ?? 'unknown' });
    if (e.type === 'entity.too.large') {
      res.status(413).json({ error: 'too_large', message: 'Request body is too large' });
    } else if (typeof e.status === 'number' && e.status >= 400 && e.status < 500) {
      res.status(400).json({ error: 'invalid_input', message: "Request body isn't valid JSON" });
    } else {
      res
        .status(500)
        .json({ error: 'internal', message: 'Something went wrong; see the server logs' });
    }
  });
  return router;
}
