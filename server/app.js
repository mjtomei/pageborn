import express from 'express';

// Development hosting only. No document, authentication, upload, or control API.
export function createApp({ distDir }) {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
    next();
  });
  app.use(express.static(distDir, { dotfiles: 'deny', etag: false, lastModified: false }));
  app.use((_req, res) => res.sendStatus(404));
  return app;
}
