import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import QRCode from 'qrcode';

import { openDatabase } from './db.js';
import {
  AuthError,
  AuthService,
  COOKIE_MAX_AGE_SECONDS,
  COOKIE_NAME,
  RedemptionLimiter,
  tokenFromCookieHeader
} from './auth.js';
import { versionedWeb } from './serve-sw.js';
import { ShareError, ShareService } from './shares.js';
import { ProjectAssetError, ProjectAssetService } from './project-assets.js';
import { ProjectError, ProjectService } from './projects.js';
import { resolveProjectEncryption } from './project-keys.js';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WEB_DIR = path.join(moduleDirectory, '../web');
const PROTECTED_CLIENT_PATHS = [
  /^\/editor\.js$/,
  /^\/storage\.js$/,
  /^\/project-sync\.js$/,
  /^\/core(?:\/|$)/,
  /^\/workers(?:\/|$)/
];

const envInteger = (name, fallback) => {
  const parsed = Number.parseInt(process.env[name], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

function setPrivateNoStore(res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
}

function setDeviceCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE_SECONDS * 1000,
    path: '/',
    priority: 'high'
  });
}

function clearDeviceCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/'
  });
}

function sameOriginBase(req) {
  const supplied = String(req.get('origin') || '').trim();
  if (!supplied) return null;
  try {
    const origin = new URL(supplied);
    return origin.host === req.get('host') ? origin.origin : null;
  } catch {
    return null;
  }
}

function redemptionKey(req, trustProxyHeaders) {
  if (trustProxyHeaders) {
    const cloudflareAddress = String(req.get('cf-connecting-ip') || '').trim();
    if (cloudflareAddress) return cloudflareAddress;
    const forwarded = String(req.get('x-forwarded-for') || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket?.remoteAddress || 'unknown';
}

function errorResponse(res, status, message, code = 'request_failed') {
  setPrivateNoStore(res);
  return res.status(status).json({ error: message, code });
}

export function createApp(options = {}) {
  const database = options.db || openDatabase();
  const webDirectory = options.webDir || DEFAULT_WEB_DIR;
  const auth = options.auth || new AuthService(database, options.authOptions);
  const configuredShareKey = String(
    options.shareEncryptionKey ?? process.env.SHARE_ENCRYPTION_KEY ?? '',
  ).trim();
  const shares = options.shares || new ShareService(database, {
    directory: options.shareDirectory,
    encryptionSecret: configuredShareKey || auth.adminToken,
    maximumBytes: options.shareMaximumBytes,
  });
  const projectEncryption = resolveProjectEncryption({
    projectEncryptionKey: options.projectEncryptionKey,
    projectEncryptionKeyId: options.projectEncryptionKeyId,
    projectDecryptionKeys: options.projectDecryptionKeys,
    shareEncryptionKey: configuredShareKey,
    adminToken: auth.adminToken,
  });
  const projectAssets = options.projectAssets || new ProjectAssetService(database, {
    directory: options.projectAssetDirectory,
    ...projectEncryption,
    maximumBytes: options.projectAssetMaximumBytes,
    maximumWorkspaceBytes: options.projectWorkspaceMaximumBytes,
  });
  const projects = options.projects || new ProjectService(database, {
    directory: options.projectDirectory,
    ...projectEncryption,
    maximumBytes: options.projectMaximumBytes,
    maximumWorkspaceBytes: options.projectWorkspaceMaximumBytes,
    assets: projectAssets,
  });
  const limiter = options.limiter || new RedemptionLimiter({
    maxPerKey: envInteger('REDEEM_MAX_FAILURES_PER_MINUTE', 8),
    maxGlobal: envInteger('REDEEM_MAX_FAILURES_GLOBAL_PER_MINUTE', 120)
  });
  const trustProxyHeaders = options.trustProxyHeaders
    ?? process.env.TRUST_PROXY_HEADERS === 'true';
  const app = express();

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    next();
  });
  // JSON-only anonymous redemption forces a browser cross-origin request to
  // preflight. This server deliberately enables no CORS.
  app.use(express.json({ limit: '32kb', strict: true }));

  const currentDevice = (req) => {
    const token = tokenFromCookieHeader(req.headers.cookie);
    return auth.deviceForToken(token);
  };

  const requireDevice = (req, res, next) => {
    const device = currentDevice(req);
    if (!device) {
      return errorResponse(
        res,
        401,
        'This device needs a valid invite.',
        'not_registered'
      );
    }
    req.device = device;
    return next();
  };

  const requireWorkspace = (req, res, next) => {
    const expectedWorkspaceId = String(req.get('x-kerfloom-workspace') || '').trim();
    if (!expectedWorkspaceId) {
      return errorResponse(
        res,
        428,
        'Reload Kerfloom before synchronizing projects.',
        'workspace_required',
      );
    }
    if (expectedWorkspaceId !== req.device.workspaceId) {
      return errorResponse(
        res,
        409,
        'The linked workspace changed. Reload before synchronizing projects.',
        'workspace_changed',
      );
    }
    return next();
  };

  const requireAdmin = (req, res, next) => {
    if (!auth.adminTokenMatches(req.get('x-admin-token'))) {
      // The private surface is intentionally undiscoverable from the public
      // hostname. Caddy also refuses it before it reaches this process.
      return errorResponse(res, 404, 'Not found', 'not_found');
    }
    return next();
  };

  // Public and deliberately uninformative: deploy.sh needs only liveness.
  app.get('/api/health', (req, res) => {
    // A listening process with an unavailable persistent volume is not
    // healthy, so include a real (but non-revealing) database round trip.
    database.prepare('SELECT 1 AS ready').get();
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, name: 'stencil-cnc', time: new Date().toISOString() });
  });

  const redeem = (req, res) => {
    const key = redemptionKey(req, trustProxyHeaders);
    if (limiter.isBlocked(key)) {
      return errorResponse(
        res,
        429,
        'Too many attempts. Wait a minute and try again.',
        'throttled'
      );
    }

    try {
      const result = auth.redeemInvite(req.body?.code, req.body?.label);
      setPrivateNoStore(res);
      setDeviceCookie(res, result.token);
      // The token exists only in the HttpOnly cookie, never in browser storage
      // or a JSON response.
      return res.json({ ok: true, device: result.device });
    } catch (error) {
      if (error instanceof AuthError) {
        limiter.recordFailure(key);
        return errorResponse(res, error.status, error.message, error.code);
      }
      throw error;
    }
  };

  app.post('/api/auth/redeem', redeem);
  // Older sibling apps use this name; keeping the alias makes the service easy
  // to drive with the same tooling while the bootstrap uses /api/auth/redeem.
  app.post('/api/invites/redeem', redeem);

  app.get('/api/auth/me', requireDevice, (req, res) => {
    setPrivateNoStore(res);
    res.json({ ok: true, device: req.device });
  });

  const shareFailure = (res, error) => {
    if (error instanceof ShareError) {
      return errorResponse(res, error.status, error.message, error.code);
    }
    throw error;
  };

  app.get('/api/shares', requireDevice, (req, res) => {
    setPrivateNoStore(res);
    try {
      return res.json({ shares: shares.list(req.device.id) });
    } catch (error) {
      return shareFailure(res, error);
    }
  });

  const projectFailure = (res, error) => {
    if (error instanceof ProjectError || error instanceof ProjectAssetError) {
      setPrivateNoStore(res);
      return res.status(error.status).json({
        error: error.message,
        code: error.code,
        ...error.details,
      });
    }
    throw error;
  };

  app.get('/api/projects', requireDevice, requireWorkspace, (req, res) => {
    setPrivateNoStore(res);
    try {
      return res.json({ projects: projects.list(req.device.workspaceId) });
    } catch (error) {
      return projectFailure(res, error);
    }
  });

  app.get('/api/projects/:id/bundle', requireDevice, requireWorkspace, (req, res) => {
    setPrivateNoStore(res);
    try {
      const result = projects.bundle(req.device.workspaceId, req.params.id);
      res.setHeader('ETag', `"${result.row.revision}"`);
      res.type('application/vnd.kerfloom.project-bundle+json');
      return res.send(result.buffer);
    } catch (error) {
      return projectFailure(res, error);
    }
  });

  app.get('/api/projects/:id/state', requireDevice, requireWorkspace, (req, res) => {
    setPrivateNoStore(res);
    try {
      const result = projects.state(req.device.workspaceId, req.params.id);
      res.setHeader('ETag', `"${result.row.revision}"`);
      res.type(result.row.storageFormat === 'asset-manifest-v1'
        ? 'application/vnd.kerfloom.project-manifest+json'
        : 'application/vnd.kerfloom.project-bundle+json');
      return res.send(result.buffer);
    } catch (error) {
      return projectFailure(res, error);
    }
  });

  app.post(
    '/api/project-assets',
    requireDevice,
    requireWorkspace,
    express.raw({ type: 'application/octet-stream', limit: projectAssets.maximumBytes }),
    (req, res) => {
      setPrivateNoStore(res);
      try {
        const result = projectAssets.upload(req.device.workspaceId, req.body, {
          sha256: req.get('x-kerfloom-asset-sha256'),
          kind: req.get('x-kerfloom-asset-kind'),
          mimeType: req.get('x-kerfloom-asset-type'),
        });
        return res.status(result.created ? 201 : 200).json(result);
      } catch (error) {
        return projectFailure(res, error);
      }
    },
  );

  app.get('/api/project-assets/:id', requireDevice, requireWorkspace, (req, res) => {
    setPrivateNoStore(res);
    try {
      const result = projectAssets.read(req.device.workspaceId, req.params.id);
      res.setHeader('ETag', `"${result.asset.sha256}"`);
      res.setHeader('Content-Length', String(result.buffer.length));
      res.type(result.asset.mimeType);
      return res.send(result.buffer);
    } catch (error) {
      return projectFailure(res, error);
    }
  });

  app.put(
    '/api/projects/:id',
    requireDevice,
    requireWorkspace,
    express.raw({
      type: [
        'application/vnd.kerfloom.project-bundle+json',
        'application/vnd.kerfloom.project-manifest+json',
        'application/octet-stream',
      ],
      limit: projects.maximumBytes,
    }),
    (req, res) => {
      setPrivateNoStore(res);
      try {
        const project = projects.save(
          req.device.workspaceId,
          req.params.id,
          req.body,
          req.get('if-match'),
        );
        res.setHeader('ETag', `"${project.revision}"`);
        return res.status(project.revision === 1 ? 201 : 200).json({ project });
      } catch (error) {
        return projectFailure(res, error);
      }
    },
  );

  app.delete('/api/projects/:id', requireDevice, requireWorkspace, (req, res) => {
    setPrivateNoStore(res);
    try {
      return res.json(projects.delete(
        req.device.workspaceId,
        req.params.id,
        req.get('if-match'),
      ));
    } catch (error) {
      return projectFailure(res, error);
    }
  });

  // A linked device can issue a one-use invite into its own workspace. Admin
  // invites still create isolated workspaces unless a workspace is explicit.
  app.get('/api/workspace/devices', requireDevice, (req, res) => {
    setPrivateNoStore(res);
    return res.json({
      current_device_id: req.device.id,
      ...auth.listWorkspaceAccess(req.device.workspaceId),
    });
  });

  app.post('/api/workspace/device-invites', requireDevice, async (req, res, next) => {
    if (req.body?.label !== undefined && typeof req.body.label !== 'string') {
      return errorResponse(res, 400, 'label must be a string', 'bad_request');
    }
    let invite = null;
    try {
      invite = auth.createInvite(
        req.body?.label,
        req.device.workspaceId,
        sameOriginBase(req),
      );
      const qrDataUrl = invite.url
        ? await QRCode.toDataURL(invite.url, {
          errorCorrectionLevel: 'M',
          margin: 2,
          width: 264,
          color: { dark: '#13242c', light: '#ffffff' },
        })
        : null;
      setPrivateNoStore(res);
      return res.status(201).json({ ...invite, qr_data_url: qrDataUrl });
    } catch (error) {
      // Do not leave a live credential behind when its QR response could not
      // be completed. The user can safely retry and receive a fresh link.
      if (invite) auth.revokeWorkspaceInvite(req.device.workspaceId, invite.id);
      if (error instanceof AuthError) {
        return errorResponse(res, error.status, error.message, error.code);
      }
      return next(error);
    }
  });

  app.delete('/api/workspace/device-invites/:id', requireDevice, (req, res) => {
    if (!auth.revokeWorkspaceInvite(req.device.workspaceId, req.params.id)) {
      return errorResponse(res, 404, 'Active invitation not found', 'not_found');
    }
    setPrivateNoStore(res);
    return res.json({ revoked: Number(req.params.id) });
  });

  app.post('/api/workspace/devices/:id/revoke', requireDevice, (req, res) => {
    if (req.params.id === req.device.id) {
      return errorResponse(
        res,
        409,
        'This device cannot disconnect itself. Use another linked device or the administrator console.',
        'current_device',
      );
    }
    if (!auth.revokeWorkspaceDevice(req.device.workspaceId, req.params.id)) {
      return errorResponse(res, 404, 'Linked device not found', 'not_found');
    }
    setPrivateNoStore(res);
    return res.json({ id: req.params.id, revoked: true });
  });

  app.post(
    '/api/shares',
    requireDevice,
    express.raw({
      type: ['application/vnd.stencil-cnc.share+json', 'application/octet-stream'],
      limit: shares.maximumBytes,
    }),
    (req, res) => {
      setPrivateNoStore(res);
      try {
        const share = shares.create(req.device.id, req.body, {
          expiresDays: req.query.expiresDays,
        });
        return res.status(201).json({
          ...share,
          path: `/share/${share.id}`,
        });
      } catch (error) {
        return shareFailure(res, error);
      }
    },
  );

  app.post('/api/shares/:id/claim', requireDevice, (req, res) => {
    setPrivateNoStore(res);
    try {
      return res.json(shares.claim(req.params.id, req.get('x-share-token'), req.device.id));
    } catch (error) {
      return shareFailure(res, error);
    }
  });

  app.get('/api/shares/:id/bundle', requireDevice, (req, res) => {
    setPrivateNoStore(res);
    try {
      const result = shares.bundle(req.params.id, req.get('x-share-token'), req.device.id);
      res.type('application/vnd.stencil-cnc.share+json');
      res.setHeader('Content-Disposition', `attachment; filename="stencil-share-${result.row.id}.json"`);
      return res.send(result.buffer);
    } catch (error) {
      return shareFailure(res, error);
    }
  });

  app.delete('/api/shares/:id', requireDevice, (req, res) => {
    setPrivateNoStore(res);
    try {
      return res.json(shares.revoke(req.params.id, req.device.id));
    } catch (error) {
      return shareFailure(res, error);
    }
  });

  // The analysis service turns a photograph into a source mask. It holds no
  // sessions of its own and is not published anywhere, so this route is the
  // only way in and the session check has to happen here, once.
  //
  // The body is forwarded untouched rather than parsed and rebuilt: multipart
  // boundaries are easy to get subtly wrong, and nothing here needs to know
  // what is inside the envelope.
  const ANALIZA_URL = process.env.ANALIZA_URL || '';
  const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_BYTES || 30 * 1024 * 1024);

  app.post(
    '/api/analizeaza',
    requireDevice,
    express.raw({ type: () => true, limit: MAX_UPLOAD }),
    async (req, res) => {
      setPrivateNoStore(res);
      if (!ANALIZA_URL) {
        return errorResponse(res, 503, 'Analysis is not configured.', 'analysis_unavailable');
      }
      try {
        const upstream = await fetch(`${ANALIZA_URL}/api/analizeaza`, {
          method: 'POST',
          headers: { 'Content-Type': req.get('content-type') || 'application/octet-stream' },
          body: req.body,
          signal: AbortSignal.timeout(60_000)
        });
        const payload = await upstream.text();
        res.status(upstream.status);
        res.type(upstream.headers.get('content-type') || 'application/json');
        return res.send(payload);
      } catch (error) {
        // A timeout and a dead container look the same to the caller, and both
        // mean the same thing: try again, nothing was lost.
        return errorResponse(res, 502, 'The analysis service did not answer.', 'analysis_failed');
      }
    }
  );

  app.post('/api/auth/logout', (req, res) => {
    setPrivateNoStore(res);
    clearDeviceCookie(res);
    res.json({ ok: true });
  });

  // pwa-invite-console contract. The console carries no credential; private
  // Caddy supplies X-Admin-Token from its own protected environment.
  app.get('/api/admin/devices', requireAdmin, (req, res) => {
    setPrivateNoStore(res);
    res.json(auth.listDevices());
  });

  app.post('/api/admin/devices/:id/revoke', requireAdmin, (req, res) => {
    if (typeof req.body?.revoked !== 'boolean') {
      return errorResponse(res, 400, 'revoked must be true or false', 'bad_request');
    }
    if (!auth.setDeviceRevoked(req.params.id, req.body.revoked)) {
      return errorResponse(res, 404, 'Device not found', 'not_found');
    }
    setPrivateNoStore(res);
    return res.json({ id: req.params.id, revoked: req.body.revoked });
  });

  app.post('/api/admin/devices/:id/label', requireAdmin, (req, res) => {
    if (typeof req.body?.label !== 'string') {
      return errorResponse(res, 400, 'label must be a string', 'bad_request');
    }
    if (!auth.setDeviceLabel(req.params.id, req.body.label)) {
      return errorResponse(res, 404, 'Device not found', 'not_found');
    }
    setPrivateNoStore(res);
    return res.json({ id: req.params.id, label: req.body.label.trim().slice(0, 60) });
  });

  app.delete('/api/admin/devices/:id', requireAdmin, (req, res) => {
    if (!auth.deleteDevice(req.params.id)) {
      return errorResponse(res, 404, 'Device not found', 'not_found');
    }
    setPrivateNoStore(res);
    return res.json({ deleted: req.params.id });
  });

  app.get('/api/admin/invites', requireAdmin, (req, res) => {
    setPrivateNoStore(res);
    res.json(auth.listInvites());
  });

  app.post('/api/admin/invites', requireAdmin, (req, res) => {
    if (req.body?.label !== undefined && typeof req.body.label !== 'string') {
      return errorResponse(res, 400, 'label must be a string', 'bad_request');
    }
    setPrivateNoStore(res);
    try {
      return res.status(201).json(auth.createInvite(req.body?.label, req.body?.workspaceId));
    } catch (error) {
      if (error instanceof AuthError) {
        return errorResponse(res, error.status, error.message, error.code);
      }
      throw error;
    }
  });

  app.post('/api/admin/invites/:id/revoke', requireAdmin, (req, res) => {
    if (!auth.revokeInvite(req.params.id)) {
      return errorResponse(res, 404, 'Unused invite not found', 'not_found');
    }
    setPrivateNoStore(res);
    return res.json({ revoked: req.params.id });
  });

  app.post('/api/admin/invites/prune', requireAdmin, (req, res) => {
    setPrivateNoStore(res);
    res.json({ deleted: auth.pruneInvites() });
  });

  app.post('/api/admin/devices/prune', requireAdmin, (req, res) => {
    setPrivateNoStore(res);
    res.json({ deleted: auth.pruneDevices() });
  });

  // pwa-kit's escape hatch remains public so a stale/half-installed client can
  // always reach it. It clears caches and workers, intentionally not cookies.
  app.get('/bust', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Clear-Site-Data', '"cache"');
    res.sendFile(path.join(webDirectory, 'bust.html'));
  });

  const versioned = versionedWeb(webDirectory);
  app.use(versioned);

  // The shell, styles, icons and bootstrap are public so an unlinked device
  // can render the invite gate. The actual editor, storage adapter, geometry
  // core and workers are released only to a valid HttpOnly-cookie session.
  app.use((req, res, next) => {
    if (!PROTECTED_CLIENT_PATHS.some((pattern) => pattern.test(req.path))) return next();
    return requireDevice(req, res, () => {
      res.setHeader('Cache-Control', 'private, no-cache, must-revalidate');
      res.setHeader('Vary', 'Cookie');
      next();
    });
  });

  app.use(express.static(webDirectory, {
    index: false,
    fallthrough: true,
    setHeaders: (res, filePath) => {
      // The session layer above may already have marked this response
      // `private`, and static serving runs after it: overwriting here dropped
      // exactly the directive that stops a shared proxy from keeping a
      // per-session module. Whoever decided first knows more than we do.
      if (res.getHeader('Cache-Control')) return;
      const extension = path.extname(filePath).toLowerCase();
      if (['.html', '.js', '.css', '.webmanifest'].includes(extension)) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      } else if (['.png', '.svg', '.webp'].includes(extension)) {
        res.setHeader('Cache-Control', 'public, max-age=604800');
      }
    }
  }));

  app.use('/api', (req, res) => errorResponse(res, 404, 'Endpoint not found', 'not_found'));
  app.get(/.*/, (req, res) => versioned.sendShell(res));

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error?.type === 'entity.too.large') {
      return errorResponse(res, 413, 'The complete project package is too large to share.', 'bundle_too_large');
    }
    if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
      return errorResponse(res, 400, 'Malformed JSON body', 'bad_json');
    }
    console.error('request failed:', error);
    return errorResponse(res, 500, 'Internal server error', 'internal_error');
  });

  app.locals.auth = auth;
  app.locals.shares = shares;
  app.locals.projects = projects;
  app.locals.projectAssets = projectAssets;
  app.locals.db = database;
  app.locals.webVersion = versioned.version;
  return app;
}

const defaultDatabase = openDatabase();
export const app = createApp({ db: defaultDatabase });

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const port = envInteger('PORT', 3000);
  const host = process.env.BIND_HOST || '0.0.0.0';
  const server = app.listen(port, host, () => {
    console.log(`Kerfloom listening on ${host}:${port}`);
  });

  const stop = () => {
    server.close(() => {
      defaultDatabase.close();
      process.exit(0);
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

export default app;
