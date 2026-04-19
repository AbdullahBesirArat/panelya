create database panelya;
create user panelya_user with password 'CHANGE_STRONG_PASSWORD';
alter database panelya owner to panelya_user;
grant all privileges on database panelya to panelya_user;
