import path from 'node:path';
import type { Express } from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';

const specPath = path.join(import.meta.dirname, '..', 'openapi.yaml');

export function registerDocs(app: Express): void {
  app.get('/openapi.yaml', (_req, res) => {
    res.type('application/yaml').sendFile(specPath);
  });
  // Swagger UI fetches the YAML itself, so no YAML parser is needed server-side. Its inline
  // script and style need a looser CSP than the rest of the API; this helmet call re-sets the
  // header for /docs only, leaving every other route on helmet's defaults.
  app.use(
    '/docs',
    helmet({
      contentSecurityPolicy: {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          'script-src': ["'self'", "'unsafe-inline'"],
          'style-src': ["'self'", "'unsafe-inline'"],
        },
      },
    }),
    swaggerUi.serve,
    swaggerUi.setup(null, { swaggerOptions: { url: '/openapi.yaml' } }),
  );
}
