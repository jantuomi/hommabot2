# hommabot2

Rewrite of hommabot (Python3) in TS.

# Running

1. Set up DB. The `sql` directory is mounted inside the `db` container as `/sql`.

```
docker-compose up -d db  
docker-compose exec db psql postgresql://postgres:postgres@localhost/postgres -f /sql/001-init.sql
```

2. Set up `.env`
3. `npm run dev`

