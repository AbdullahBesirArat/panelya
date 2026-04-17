create database maveran;
create user maveran_user with password 'CHANGE_STRONG_PASSWORD';
alter database maveran owner to maveran_user;
grant all privileges on database maveran to maveran_user;
