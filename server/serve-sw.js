// Server-side half of pwa-kit. Container deployments cannot stamp files as
// they are copied to /var/www, so the content hash is computed once at boot
// and substituted while sw.js and the HTML shell are served.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function hashDirectory(directory) {
  const hash = crypto.createHash('sha256');

  const visit = (current, relative = '') => {
    if (!fs.existsSync(current)) return;
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const relativePath = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(fullPath, relativePath);
      else if (entry.isFile()) {
        hash.update(relativePath);
        hash.update('\0');
        hash.update(fs.readFileSync(fullPath));
      }
    }
  };

  visit(directory);
  return hash.digest('hex').slice(0, 12);
}

export function versionedWeb(webDirectory) {
  const version = hashDirectory(webDirectory);
  const read = (file) => {
    const filePath = path.join(webDirectory, file);
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf8').replaceAll('__BUILD_VERSION__', version);
  };
  const worker = read('sw.js');
  const shell = read('index.html');

  const middleware = (req, res, next) => {
    if (req.path === '/sw.js' && worker !== null) {
      res.type('text/javascript');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      return res.send(worker);
    }
    if ((req.path === '/' || req.path === '/index.html') && shell !== null) {
      return middleware.sendShell(res);
    }
    return next();
  };

  middleware.sendShell = (res) => {
    if (shell === null) return res.status(503).type('text/plain').send('Web application is not installed.');
    res.type('text/html');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.send(shell);
  };
  middleware.version = version;
  return middleware;
}
