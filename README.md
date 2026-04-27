# Payment System (Stripe simplificado)

## Rodando local

1. Suba infra:

```bash
docker compose up -d
```

2. Instale dependências:

```bash
npm install
```

3. Configure env:

```bash
copy .env.example .env
```

4. Migre o banco:

```bash
npm run prisma:migrate
```

5. API:

```bash
npm run dev
```

6. Worker:

```bash
npm run dev:worker
```
