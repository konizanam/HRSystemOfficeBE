-- Run once per Postgres cluster as a superuser (CI and fresh installs). Passwords come from psql
-- variables: psql -v owner_pw=... -v user_pw=... -v db=peoplehub -f scripts/db-roles.sql
SELECT 'CREATE ROLE app_owner LOGIN CREATEDB PASSWORD ' || quote_literal(:'owner_pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_owner') \gexec
SELECT 'CREATE ROLE app_user LOGIN PASSWORD ' || quote_literal(:'user_pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') \gexec
SELECT format('CREATE DATABASE %I OWNER app_owner', :'db')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec
SELECT format('GRANT CONNECT, CREATE ON DATABASE %I TO app_user', :'db') \gexec
