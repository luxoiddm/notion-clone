// PM2 ecosystem config — запускает apps/server и apps/web как управляемые
// процессы (автоперезапуск при падении, единый `pm2 logs`/`pm2 status`).
//
// Использование (из корня репозитория, после `npm run build`):
//   pm2 start deploy/ecosystem.config.cjs
//   pm2 save                  # чтобы pm2 resurrect восстановил после реролла
//   pm2 startup                # печатает команду для автозапуска при перезагрузке ОС — выполнить её отдельно
//
// Логи: pm2 logs workspace-server / pm2 logs workspace-web
// Перезапуск после обновления кода: pm2 restart workspace-server workspace-web

module.exports = {
  apps: [
    {
      name: 'workspace-server',
      cwd: __dirname + '/../apps/server',
      script: 'npm',
      args: 'run start',
      env: { NODE_ENV: 'production' },
      max_restarts: 10,
      restart_delay: 3000,
    },
    {
      name: 'workspace-web',
      cwd: __dirname + '/../apps/web',
      script: 'npm',
      args: 'run start',
      env: { NODE_ENV: 'production' },
      max_restarts: 10,
      restart_delay: 3000,
    },
  ],
};
