#!/usr/bin/env bash
set -euo pipefail

# Run as a sudo-enabled user on Ubuntu 24.04.
# Replace DOMAIN values in deploy/nginx/maveran.conf before enabling SSL.

sudo apt update
sudo apt install -y nginx postgresql postgresql-contrib curl git ufw

curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2

sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw --force enable

sudo mkdir -p /var/www/maveran /var/www/maveran-api /var/www/maveran/uploads /var/log/pm2
sudo chown -R "$USER":"$USER" /var/www/maveran /var/www/maveran-api /var/www/maveran/uploads /var/log/pm2

echo "Base packages installed."
echo "Next: copy frontend files to /var/www/maveran and API files to /var/www/maveran-api."
