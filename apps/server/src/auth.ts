// Logins. Better Auth (a library) keeps the passwords and the login cookies, in our own database.
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { username } from 'better-auth/plugins/username';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Db } from './db.ts';
import { account, session, threads, user, verification } from './schema.ts';

// What the first admin logs in with. The password has to be changed right after.
export const FIRST_ADMIN = { username: 'admin', name: 'Admin', password: 'changeme' };

// Set by us only, never by what a browser sends.
const ours = (defaultValue: boolean) => ({ type: 'boolean', defaultValue, input: false }) as const;

// `secret` signs the login cookies. Whoever has it can make a cookie for anyone.
// `https` says people only reach the server over https. The login cookie is then marked so that the browser
// never sends it over plain http, where anyone on the network could read it.
export function createAuth(db: Db, secret: string, https: boolean) {
  return betterAuth({
    secret,
    database: drizzleAdapter(db, { provider: 'sqlite', schema: { user, session, account, verification } }),
    // A new account does not log itself in: an admin makes it for someone else.
    emailAndPassword: { enabled: true, autoSignIn: false },
    plugins: [username({ displayUsername: false })],
    user: { additionalFields: { admin: ours(false), mustChangePassword: ours(true), deleted: ours(false) } },
    // The server already turned away requests from other sites (see server.ts), so the site asking is ours.
    trustedOrigins: (request) => [request?.headers.get('origin') ?? ''],
    // Said out loud, because Better Auth would skip its own check of that when it runs under tests.
    advanced: { disableOriginCheck: false, useSecureCookies: https },
    // Better Auth can limit login attempts per caller address, and switches that on by itself in production
    // mode. Without the address (a tunnel has to pass it on in a header) the whole team would share one
    // limit, so it stays off until that is set up.
    rateLimit: { enabled: false },
    telemetry: { enabled: false },
    // Only real problems are logged. Otherwise every start warns that no address was set for the server,
    // which it does not need: it is reached under whatever address the tunnel in front of it has.
    logger: { level: 'error' },
  });
}

export type Auth = ReturnType<typeof createAuth>;

// The columns of a user that everyone logged in sees.
export const personCols = {
  id: user.id,
  name: user.name,
  username: user.username,
  admin: user.admin,
  deleted: user.deleted,
};
export const listPeople = (db: Db) => db.select(personCols).from(user).orderBy(asc(user.createdAt)).all();
export const findPerson = (db: Db, id: string) => db.select(personCols).from(user).where(eq(user.id, id)).get();

// Makes an account that has to change its password on first login. Better Auth checks the username and the
// password and says what is wrong with them. The email is made up, since Better Auth wants one.
export async function createUser(auth: Auth, body: { username: string; name: string; password: string }) {
  const made = await auth.api.signUpEmail({ body: { ...body, email: `${randomUUID()}@acocrew.local` } });
  return made.user.id;
}

// Gives an account a new password that has to be changed on the next login, and logs it out everywhere.
export async function resetPassword(auth: Auth, db: Db, id: string, password: string) {
  const { hash, config } = (await auth.$context).password;
  if (password.length < config.minPasswordLength) throw new Error('Password is too short.');
  if (password.length > config.maxPasswordLength) throw new Error('Password is too long.');
  const hashed = await hash(password);
  db.transaction((tx) => {
    tx.update(account)
      .set({ password: hashed })
      .where(and(eq(account.userId, id), eq(account.providerId, 'credential')))
      .run();
    tx.delete(session).where(eq(session.userId, id)).run();
    tx.update(user).set({ mustChangePassword: true }).where(eq(user.id, id)).run();
  });
}

// The account can no longer log in and its username is free again. The row stays for its name.
export function deleteUser(db: Db, id: string) {
  db.transaction((tx) => {
    tx.delete(session).where(eq(session.userId, id)).run();
    tx.delete(account).where(eq(account.userId, id)).run();
    tx.update(user).set({ deleted: true, admin: false, username: null }).where(eq(user.id, id)).run();
  });
}

// On the very first start there are no users. One admin is made, and everything from before there were
// logins (threads, and the messages people wrote in them) becomes theirs.
export async function seedAdmin(auth: Auth, db: Db) {
  if (db.select({ id: user.id }).from(user).limit(1).get()) return;
  const id = await createUser(auth, FIRST_ADMIN);
  db.transaction((tx) => {
    tx.update(user).set({ admin: true }).where(eq(user.id, id)).run();
    tx.update(threads)
      .set({ createdBy: id, people: [id] })
      .where(isNull(threads.createdBy))
      .run();
    tx.run(
      sql`update events set item = json_set(item, '$.userId', ${id})
          where item ->> 'kind' = 'message' and item ->> 'by' = 'user'`,
    );
  });
}
