module.exports = {
  apps: [
    {
      name: 'maveran-api',
      script: './server.js',
      cwd: '/var/www/maveran-api',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      max_memory_restart: '350M',
      error_file: '/var/log/pm2/maveran-api-error.log',
      out_file: '/var/log/pm2/maveran-api-out.log',
      time: true,
    },
    {
      name: 'maveran-expire-pending-orders',
      script: './scripts/expire-pending-orders.js',
      cwd: '/var/www/maveran-api',
      instances: 1,
      exec_mode: 'fork',
      cron_restart: '*/10 * * * *',
      autorestart: false,
      env: {
        NODE_ENV: 'production',
      },
      error_file: '/var/log/pm2/maveran-expire-pending-orders-error.log',
      out_file: '/var/log/pm2/maveran-expire-pending-orders-out.log',
      time: true,
    },
  ],
};
