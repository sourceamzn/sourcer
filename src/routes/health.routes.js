'use strict';

const db = require('../db');

module.exports = async function healthRoutes(app) {
  app.get('/health', async () => {
    let database = 'down';
    try {
      await db.ping();
      database = 'up';
    } catch (err) {
      database = 'down';
    }
    return { status: 'ok', database, time: new Date().toISOString() };
  });
};
