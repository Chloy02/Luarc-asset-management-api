import path from 'node:path';
import type { Express } from 'express';
import swaggerUi from 'swagger-ui-express';

const specPath = path.join(import.meta.dirname, '..', 'openapi.yaml');

export function registerDocs(app: Express): void {
  app.get('/openapi.yaml', (_req, res) => {
    res.type('application/yaml').sendFile(specPath);
  });
  // Swagger UI fetches the YAML itself, so no YAML parser is needed server-side.
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(null, { swaggerOptions: { url: '/openapi.yaml' } }));
}
