'use strict';

const { config, assertConfig } = require('./lib/config');
const { buildApp } = require('./app');

async function start() {
  assertConfig();
  const app = await buildApp();

  try {
    await app.listen({ host: config.host, port: config.port });
    app.log.info(`API lista en ${config.apiPublicUrl} (${config.env})`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async (signal) => {
    app.log.info(`Senal ${signal}: cerrando servidor...`);
    try {
      await app.close();
    } catch (err) {
      app.log.error(err);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start();
