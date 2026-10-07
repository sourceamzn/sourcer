'use strict';

const db = require('../db');
const { config } = require('../lib/config');
const { AppError } = require('../lib/errors');
const password = require('../lib/password');
const token = require('../lib/token');
const serialize = require('../domain/serialize');
const clients = require('../repositories/client.repo');
const leads = require('../repositories/lead.repo');
const users = require('../repositories/user.repo');
const authRepo = require('../repositories/auth.repo');
const audit = require('../repositories/audit.repo');
const mailer = require('../mail/mailer');
const templates = require('../mail/templates');

const REALMS = ['client-area', 'crm', 'terminal'];
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

function actorTypeFor(credential, user) {
  if (credential.subject_type === 'staff') {
    if (user && user.role === 'tm') return 'tm';
    if (user && user.role === 'system') return 'system';
    return 'staff';
  }
  return 'client';
}

async function register(input) {
  const passwordHash = await password.hash(input.password);

  const result = await db.withTransaction(async (tx) => {
    let client = await clients.findByEmail(input.email, tx);
    let created = false;

    if (!client) {
      const clientId = await clients.nextClientId(tx);
      client = await clients.insert(
        {
          clientId,
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email,
          phone: input.phone,
          country: input.country,
          source: input.source || 'web',
          status: 'active',
          kycStatus: 'pending',
        },
        tx
      );
      created = true;
    }

    if (created) {
      const leadId = await leads.nextLeadId(tx);
      await leads.insert(
        {
          leadId,
          firstName: client.first_name,
          lastName: client.last_name,
          email: client.email,
          phone: client.phone,
          source: client.source || 'web',
          description: 'Alta web desde el área de clientes',
          statusId: 'st-new',
          clientId: client.client_id,
        },
        tx
      );
    }

    const existingCredential = await authRepo.findCredentialBySubject('client', client.client_id, 'client-area', tx);
    if (existingCredential) throw AppError.conflict('Ya existe una cuenta para este correo');

    const credential = await authRepo.insertCredential(
      {
        subjectType: 'client',
        subjectId: client.client_id,
        email: input.email,
        passwordHash,
        realm: 'client-area',
      },
      tx
    );

    const verify = token.randomToken();
    await authRepo.createOneTimeToken(
      {
        tokenHash: verify.hash,
        purpose: 'email_verify',
        credentialId: credential.credential_id,
        expiresAt: new Date(Date.now() + VERIFY_TTL_MS),
      },
      tx
    );

    await audit.record(
      { actorType: 'client', actorId: client.client_id, action: 'auth.register', object: client.client_id },
      tx
    );

    return { client, verifyToken: verify.raw, created };
  });

  const url = `${config.clientAreaUrl}/verify-email?token=${result.verifyToken}`;
  const message = templates.verifyEmail({ name: result.client.first_name, url });
  /* El correo se envia en segundo plano: el alta del cliente ya esta
     confirmada y no debe esperar a la salida SMTP (bloqueada en Railway). */
  mailer
    .send({ to: result.client.email, ...message })
    .catch((err) => console.error('[mail] No se pudo enviar el correo de verificacion:', err && err.message));

  return { client: serialize.toClient(result.client), created: result.created, verificationSent: mailer.isConfigured() };
}

async function login(input) {
  const realm = REALMS.includes(input.realm) ? input.realm : 'client-area';
  let credential = await authRepo.findCredentialByEmail(realm, input.email);
  /* Los empleados del CRM pueden entrar con su nombre de usuario además del
     email: se resuelve el usuario y, desde ahí, su credencial. */
  if (!credential) {
    const byUsername = await users.findByUsername(input.email);
    if (byUsername) credential = await authRepo.findCredentialByEmail(realm, byUsername.email);
  }
  if (!credential) throw AppError.invalidCredentials();
  if (credential.status !== 'active') throw AppError.forbidden('Credencial inactiva');

  const ok = await password.verify(input.password, credential.password_hash);
  if (!ok) throw AppError.invalidCredentials();

  const user = credential.subject_type === 'staff' ? await users.findById(credential.subject_id) : null;
  if (user) await users.touchLogin(user.user_id);
  const actorType = actorTypeFor(credential, user);
  const claims = {
    actorType,
    actorId: credential.subject_id,
    realm,
    clientId: actorType === 'client' ? credential.subject_id : undefined,
    role: user ? user.role : undefined,
    permissions: user ? user.permissions : undefined,
  };

  const signed = token.sign(claims);
  await authRepo.createSession({
    tokenId: signed.jti,
    actorType,
    actorId: credential.subject_id,
    realm,
    expiresAt: signed.expiresAt,
  });

  return {
    token: signed.token,
    expiresAt: signed.expiresAt.toISOString(),
    actor: actorView(claims, credential, user),
  };
}

async function logout(actor) {
  if (actor && actor.jti) await authRepo.revokeSession(actor.jti);
  return { ok: true };
}

async function me(actor) {
  if (!actor) throw AppError.unauthorized();

  if (actor.type === 'client') {
    const client = await clients.findById(actor.clientId);
    if (!client) throw AppError.unauthorized();
    const name = [client.first_name, client.last_name].filter(Boolean).join(' ');
    return { actorType: 'client', clientId: client.client_id, userId: null, email: client.email, name, role: null };
  }

  const user = await users.findById(actor.id);
  return {
    actorType: actor.type,
    clientId: null,
    userId: actor.id,
    email: user ? user.email : null,
    name: user ? user.name : null,
    role: actor.role,
  };
}

function actorView(claims, credential, user) {
  return {
    actorType: claims.actorType,
    realm: claims.realm,
    clientId: claims.clientId || null,
    userId: claims.actorType === 'client' ? null : credential.subject_id,
    email: credential.email,
    name: user ? user.name : null,
    role: user ? user.role : null,
  };
}

async function forgotPassword(input) {
  const credential = await authRepo.findCredentialByEmail('client-area', input.email);
  if (!credential) return { ok: true };

  const reset = token.randomToken();
  await authRepo.createOneTimeToken({
    tokenHash: reset.hash,
    purpose: 'password_reset',
    credentialId: credential.credential_id,
    expiresAt: new Date(Date.now() + RESET_TTL_MS),
  });

  const url = `${config.clientAreaUrl}/reset-password?token=${reset.raw}`;
  const message = templates.passwordReset({ name: credential.email, url });
  /* Envio en segundo plano: la recuperacion responde al instante. */
  mailer
    .send({ to: credential.email, ...message })
    .catch((err) => console.error('[mail] No se pudo enviar el correo de restablecimiento:', err && err.message));

  return { ok: true };
}

async function resetPassword(input) {
  const tokenHash = token.sha256(input.token);
  const record = await authRepo.consumeOneTimeToken(tokenHash, 'password_reset');
  if (!record) throw AppError.validation('Token invalido o expirado');

  const passwordHash = await password.hash(input.password);
  await authRepo.updatePassword(record.credential_id, passwordHash);
  await audit.record({ actorType: 'client', action: 'auth.password.reset', object: String(record.credential_id) });
  return { ok: true };
}

async function changePassword(actor, input) {
  if (!actor) throw AppError.unauthorized();
  const realm = actor.realm || 'client-area';
  const credential = await authRepo.findCredentialBySubject(
    actor.type === 'client' ? 'client' : 'staff',
    actor.id,
    realm
  );
  if (!credential) throw AppError.notFound('Credencial no encontrada');

  const ok = await password.verify(input.currentPassword, credential.password_hash);
  if (!ok) throw AppError.invalidCredentials('Contrasena actual incorrecta');

  const passwordHash = await password.hash(input.newPassword);
  await authRepo.updatePassword(credential.credential_id, passwordHash);
  await audit.record({ actorType: actor.type, actorId: actor.id, action: 'auth.password.change', object: actor.id });
  return { ok: true };
}

async function verifyEmail(input) {
  const tokenHash = token.sha256(input.token);
  const record = await authRepo.consumeOneTimeToken(tokenHash, 'email_verify');
  if (!record) throw AppError.validation('Token invalido o expirado');
  await authRepo.markEmailVerified(record.credential_id);
  return { ok: true };
}

module.exports = {
  register,
  login,
  logout,
  me,
  forgotPassword,
  resetPassword,
  changePassword,
  verifyEmail,
};
