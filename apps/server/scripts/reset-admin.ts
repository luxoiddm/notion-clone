/**
 * Аварийное создание/сброс пароля администратора в обход HTTP и браузера.
 *
 * Использование (из apps/server):
 *   npx tsx scripts/reset-admin.ts admin@fkviking.com "НовыйПароль123!" "Администратор"
 *
 * Или через npm-скрипт из корня репозитория:
 *   npm run admin:reset-password -w apps/server -- admin@fkviking.com "НовыйПароль123!"
 *
 * Скрипт использует тот же .env (найденный тем же способом, что и сам
 * сервер — относительно расположения файла, а не process.cwd()) и тот же
 * STORAGE_ROOT, так что результат гарантированно совпадает с тем, что
 * увидит запущенный сервер — никаких сюрпризов с несовпадающими путями.
 *
 * Полезно, когда:
 *  - логин не работает и непонятно почему — этот скрипт сразу скажет,
 *    существует ли STORAGE_ROOT, создался ли пользователь и куда;
 *  - забыт пароль администратора;
 *  - нужно сменить email администратора, не трогая веб-интерфейс.
 */
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AuthService } from '@core/auth';
import { FsEngine } from '@core/fs-engine';

const here = path.dirname(fileURLToPath(import.meta.url));
// `here` is this script's own directory (apps/server/scripts) — .env and
// STORAGE_ROOT both belong in apps/server itself, one level up.
const serverRoot = path.resolve(here, '..');
const envPath = path.resolve(serverRoot, '.env');
const loaded = loadEnv({ path: envPath });

console.log(loaded.error ? `[reset-admin] .env не найден по ${envPath} (${loaded.error.message})` : `[reset-admin] .env загружен из ${envPath}`);

const [, , emailArg, passwordArg, displayNameArg] = process.argv;

if (!emailArg || !passwordArg) {
  console.error('Использование: npx tsx scripts/reset-admin.ts <email> <пароль> [имя]');
  process.exit(1);
}

if (!process.env.ACCESS_TOKEN_SECRET || !process.env.REFRESH_TOKEN_SECRET) {
  console.error('[reset-admin] В .env нет ACCESS_TOKEN_SECRET/REFRESH_TOKEN_SECRET — сначала настрой .env (см. install.md).');
  process.exit(1);
}

const STORAGE_ROOT = path.resolve(serverRoot, process.env.STORAGE_ROOT ?? './storage');
console.log(`[reset-admin] STORAGE_ROOT = ${STORAGE_ROOT}`);

const auth = new AuthService({
  accessTokenSecret: process.env.ACCESS_TOKEN_SECRET,
  refreshTokenSecret: process.env.REFRESH_TOKEN_SECRET,
});
const fs = new FsEngine({ storageRoot: STORAGE_ROOT });

async function main() {
  const passwordHash = await auth.hashPassword(passwordArg);
  const existing = await fs.getCredentialByEmail(emailArg);

  if (existing) {
    // Пользователь уже есть — просто перезаписываем пароль на его текущий userId.
    await fs.setCredential(emailArg, existing.userId, passwordHash);
    console.log(`[reset-admin] Пароль обновлён для ${emailArg} (userId=${existing.userId}). Роль не менялась.`);
    return;
  }

  // Пользователя с таким email ещё нет — создаём нового администратора.
  const userId = randomUUID();
  const displayName = displayNameArg || 'Администратор';
  await fs.createUser(userId, { displayName, role: 'Admin' });
  await fs.setCredential(emailArg, userId, passwordHash);
  console.log(`[reset-admin] Создан новый администратор ${emailArg} (userId=${userId}).`);
}

main()
  .then(() => {
    console.log('[reset-admin] Готово. Можно логиниться этим email/паролем.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('[reset-admin] Ошибка:', err);
    process.exit(1);
  });
