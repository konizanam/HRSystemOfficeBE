#!/bin/sh
# Creates the app_owner/app_user roles and the peoplehub database on first container start.
set -e
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres \
  -v owner_pw=app_owner -v user_pw=app_user -v db=peoplehub -f /scripts/db-roles.sql
