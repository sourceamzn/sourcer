'use strict';

const db = require('../db');

function runner(client) {
  return client || db.pool;
}

async function findCredentialByEmail(realm, email, client) {
  const { rows } = await runner(client).query(
    'SELECT * FROM credentials WHERE realm = $1 AND lower(email) = lower($2) LIMIT 1',
    [realm, email]
  );
  return rows[0] || null;
}

async function findCredentialBySubject(subjectType, subjectId, realm, client) {
  const { rows } = await runner(client).query(
    'SELECT * FROM credentials WHERE subject_type = $1 AND subject_id = $2 AND realm = $3 LIMIT 1',
    [subjectType, subjectId, realm]
  );
  return rows[0] || null;
}

async function insertCredential(data, client) {
  const { rows } = await runner(client).query(
    `INSERT INTO credentials
       (subject_type, subject_id, email, password_hash, realm, status, email_verified_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      data.subjectType,
      data.subjectId,
      data.email,
      data.passwordHash,
      data.realm,
      data.status || 'active',
      data.emailVerifiedAt || null,
    ]
  );
  return rows[0];
}

async function updatePassword(credentialId, passwordHash, client) {
  await runner(client).query(
    'UPDATE credentials SET password_hash = $2, updated_at = now() WHERE credential_id = $1',
    [credentialId, passwordHash]
  );
}

async function linkCredentialSubject(credentialId, subjectType, subjectId, client) {
  await runner(client).query(
    'UPDATE credentials SET subject_type = $2, subject_id = $3, updated_at = now() WHERE credential_id = $1',
    [credentialId, subjectType, subjectId]
  );
}

async function markEmailVerified(credentialId, client) {
  await runner(client).query(
    'UPDATE credentials SET email_verified_at = now(), updated_at = now() WHERE credential_id = $1',
    [credentialId]
  );
}

async function updateCredentialEmail(credentialId, email, client) {
  await runner(client).query(
    'UPDATE credentials SET email = $2, updated_at = now() WHERE credential_id = $1',
    [credentialId, email]
  );
}

async function deleteCredentialBySubject(subjectType, subjectId, realm, client) {
  await runner(client).query(
    'DELETE FROM credentials WHERE subject_type = $1 AND subject_id = $2 AND realm = $3',
    [subjectType, subjectId, realm]
  );
}

async function revokeSessionsByActor(actorType, actorId, client) {
  await runner(client).query(
    `UPDATE sessions SET revoked_at = now()
      WHERE actor_type = $1 AND actor_id = $2 AND revoked_at IS NULL`,
    [actorType, actorId]
  );
}

async function createSession(data, client) {
  await runner(client).query(
    `INSERT INTO sessions (token_id, actor_type, actor_id, realm, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [data.tokenId, data.actorType, data.actorId, data.realm, data.expiresAt]
  );
}

async function findSession(tokenId, client) {
  const { rows } = await runner(client).query(
    'SELECT * FROM sessions WHERE token_id = $1',
    [tokenId]
  );
  return rows[0] || null;
}

async function revokeSession(tokenId, client) {
  await runner(client).query(
    'UPDATE sessions SET revoked_at = now() WHERE token_id = $1 AND revoked_at IS NULL',
    [tokenId]
  );
}

async function createOneTimeToken(data, client) {
  await runner(client).query(
    `INSERT INTO one_time_tokens (token_hash, purpose, credential_id, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [data.tokenHash, data.purpose, data.credentialId, data.expiresAt]
  );
}

async function consumeOneTimeToken(tokenHash, purpose, client) {
  const { rows } = await runner(client).query(
    `UPDATE one_time_tokens
        SET used_at = now()
      WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
      RETURNING *`,
    [tokenHash, purpose]
  );
  return rows[0] || null;
}

module.exports = {
  findCredentialByEmail,
  findCredentialBySubject,
  insertCredential,
  updatePassword,
  linkCredentialSubject,
  updateCredentialEmail,
  deleteCredentialBySubject,
  markEmailVerified,
  revokeSessionsByActor,
  createSession,
  findSession,
  revokeSession,
  createOneTimeToken,
  consumeOneTimeToken,
};
