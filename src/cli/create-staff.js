'use strict';

const { assertConfig } = require('../lib/config');
const db = require('../db');
const password = require('../lib/password');
const users = require('../repositories/user.repo');
const authRepo = require('../repositories/auth.repo');

async function main() {
  assertConfig();

  const [email, plain, name, role, realm] = process.argv.slice(2);
  if (!email || !plain) {
    console.error('Uso: npm run create-staff -- <email> <password> [nombre] [rol] [realm]');
    process.exit(1);
  }

  const resolvedRole = role || 'superadmin';
  const resolvedRealm = realm || 'crm';

  await db.withTransaction(async (tx) => {
    let user = await users.findByEmail(email, tx);
    if (!user) {
      const userId = await users.nextUserId(tx);
      user = await users.insert({ userId, email, name: name || email, role: resolvedRole }, tx);
    }

    const passwordHash = await password.hash(plain);
    const existing = await authRepo.findCredentialBySubject('staff', user.user_id, resolvedRealm, tx);
    if (existing) {
      await authRepo.updatePassword(existing.credential_id, passwordHash, tx);
    } else {
      await authRepo.insertCredential(
        {
          subjectType: 'staff',
          subjectId: user.user_id,
          email,
          passwordHash,
          realm: resolvedRealm,
          emailVerifiedAt: new Date(),
        },
        tx
      );
    }
  });

  console.log(`Staff listo: ${email} (rol ${resolvedRole}, realm ${resolvedRealm})`);
  await db.close();
}

main().catch((err) => {
  console.error(err);
  db.close().finally(() => process.exit(1));
});
