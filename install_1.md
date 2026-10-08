# install_1.md — краткая инструкция по установке

Сокращённая версия. Подробности, объяснения «почему» и диагностика — в
`install.md`.

## Требования

- Node.js ≥ 18.17, npm ≥ 10
- Домен с DNS-записью на сервер (нужен для HTTPS — без него не работают
  камера/микрофон в браузере)
- nginx, coturn, PM2 (`npm install -g pm2`)

## 1. Клонирование и зависимости

```bash
git clone <repo>
cd notion-clone
npm install
```

## 2. `.env` файлы

```bash
cp apps/server/.env.example apps/server/.env
cp apps/web/.env.local.example apps/web/.env.local
```

**`apps/server/.env`:**

```env
PORT=4000
WEB_ORIGIN=http://localhost:3000
STORAGE_ROOT=./storage
ACCESS_TOKEN_SECRET=<случайная строка ≥32 символов>
REFRESH_TOKEN_SECRET=<другая случайная строка>
ADMIN_EMAIL=admin@company.com
ADMIN_PASSWORD=<сильный пароль>
ADMIN_DISPLAY_NAME=Администратор
```

Сгенерировать секреты:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

**`apps/web/.env.local`:**

```env
PORT=3000
NEXT_PUBLIC_API_URL=http://localhost:4000
```

`WEB_ORIGIN` (сервер) и `NEXT_PUBLIC_API_URL`+`PORT` (веб) должны
описывать один и тот же адрес.

## 3. Запуск в режиме разработки

```bash
npm run dev
```

Проверка:

```bash
curl http://localhost:4000/health
```

## 4. Первый администратор

Создаётся автоматически при первом старте сервера из
`ADMIN_EMAIL`/`ADMIN_PASSWORD`/`ADMIN_DISPLAY_NAME` в `apps/server/.env`.
Самостоятельной регистрации в системе нет — остальных пользователей
администратор добавляет через `/admin` (напрямую или по инвайт-ссылке).

## 5. Сборка для продакшена

```bash
npm run build
# проверь код выхода — должен быть 0, иначе не перезапускай процессы
npm run start -w apps/server
npm run start -w apps/web
```

## 6. PM2

```bash
npm install -g pm2
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 startup   # выполни команду из вывода
```

Управление:

```bash
pm2 status
pm2 logs workspace-server
pm2 logs workspace-web
pm2 restart workspace-server workspace-web
```

## 7. Nginx

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/workspace.conf
sudo ln -s /etc/nginx/sites-available/workspace.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d workspace.example.com
```

Поменять в `deploy/nginx.conf`: `server_name` (оба блока), пути к
сертификатам (если без certbot), порты `upstream` (если не 3000/4000).

После переезда на домен — обновить `.env`:

```env
# apps/server/.env
WEB_ORIGIN=https://workspace.example.com

# apps/web/.env.local
NEXT_PUBLIC_API_URL=https://workspace.example.com
```

## 8. Coturn (STUN/TURN для видеозвонков)

```bash
sudo apt install coturn
sudo cp deploy/turnserver.conf /etc/turnserver.conf
```

Отредактировать `/etc/turnserver.conf`:

- `realm` → свой домен
- `static-auth-secret` → случайная строка (`openssl rand -hex 32`),
  должна совпадать с `TURN_SECRET` в `apps/server/.env`
- при наличии TLS-сертификата — раскомментировать `cert`/`pkey`

Проверить, что порт `3478` свободен:

```bash
sudo ss -tulpn | grep 3478
```

Если занят — сменить `listening-port`/`tls-listening-port` в
`turnserver.conf` и продублировать в `TURN_PORT`/`TURN_TLS_PORT`.

Если сервер за NAT/floating IP (`curl ifconfig.me` ≠ `ip -4 addr show`):

```
external-ip=<публичный-IP>/<приватный-IP>
```

Включить и проверить:

```bash
sudo sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
sudo systemctl enable --now coturn
sudo systemctl status coturn
```

Открыть в файрволе: `listening-port` (UDP+TCP, обычно `3478`),
`tls-listening-port` (TCP, если настроен), диапазон `min-port`–`max-port`
(UDP, по умолчанию `49152`–`49452`).

Переменные `apps/server/.env`:

```env
TURN_HOST=194.0.2.10
TURN_PORT=3478
TURN_TLS_PORT=5349
TURN_SECRET=<тот же секрет, что static-auth-secret>
TURN_CREDENTIAL_TTL_SECONDS=3600
```

Если `TURN_HOST` — поддомен, убедиться, что у него есть отдельная
A-запись (`dig +short <поддомен>`).

## 9. Финальная проверка (на реальном домене)

```bash
curl https://workspace.example.com/health
```

1. Вход под администратором
2. Создать страницу, написать текст, обновить вкладку — текст сохранился
3. Открыть страницу в двух вкладках — видно presence (аватарки)
4. Перетащить файл в статью, проверить `/files`
5. Отправить сообщение в чате между двумя аккаунтами
6. Начать видеозвонок с одного устройства, присоединиться со второго
   (если видео/звук не работают — проверить coturn)
7. `/admin` открывается без `403`
