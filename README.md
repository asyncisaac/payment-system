# Payment System (Stripe simplificado) — Fullstack

Sistema de pagamentos assíncrono com garantias de consistência (idempotência + ledger) e tolerância a falhas (retry + DLQ), com API + Worker + Dashboard.

## O que esse projeto demonstra

- Processamento assíncrono (API enfileira, worker executa)
- Idempotência real (API e worker)
- Consistência via ledger (saldo derivado, sem atualizar “balance” direto)
- Retry com backoff exponencial + DLQ
- Observabilidade mínima (requestId, jobId, attempt, paymentId)
- Testes de integração cobrindo cenários críticos

## Arquitetura (fluxo)

```
Frontend (React)
   |
   |  POST /payments
   v
API (Express)  ----> Postgres (Payment, LedgerEntry, Event, JobEffect)
   |
   |  add job (BullMQ)
   v
Redis (BullMQ)
   |
   v
Worker
   |
   |  Fake Gateway (timeout ~10–20%)
   v
DB transaction:
  - LedgerEntry (DEBIT/CREDIT)
  - Payment status (SUCCESS/FAILED/REFUNDED)
  - Event auditável
```

## Decisões técnicas (o “ouro”)

- **Ledger-first**: o sistema nunca atualiza saldo direto. O “saldo do usuário” é derivado do ledger.
- **Idempotência na API**: `Payment.idempotencyKey` é UNIQUE; mesma key retorna o mesmo Payment.
- **Idempotência no worker**: `JobEffect.jobId` é UNIQUE; side-effects são protegidos também por constraints (ex.: `LedgerEntry(paymentId,type)` UNIQUE).
- **Retry + backoff**: jobs têm tentativas e backoff exponencial para simular mundo real (timeouts do gateway).
- **DLQ**: ao esgotar tentativas, o job vai para `payments_dlq` para inspeção/replay.
- **Auditabilidade**: tabela `Event` registra mudanças relevantes (created/processed/failed/refunded).

## Stack

- API/Worker: Node.js + TypeScript + Express + BullMQ + Prisma
- Infra local: Postgres + Redis (Docker)
- Frontend: React + Vite + TypeScript

## Rodando local (API + Worker + Frontend)

### 1) Infra

```bash
docker compose up -d
```

Se você tiver portas ocupadas, ajuste no `.env`:

- `POSTGRES_PORT` (default 5432)
- `REDIS_PORT` (default 6379)

### 2) API/Worker

```bash
npm install
copy .env.example .env
npm run prisma:migrate
```

Em terminais separados:

```bash
npm run dev
```

```bash
npm run dev:worker
```

### 3) Frontend

```bash
npm --prefix web install
npm run dev:web
```

O frontend usa proxy do Vite para chamar a API em `http://localhost:3000`.

## Dashboard

- Lista de pagamentos com filtro por status
- Detalhe do pagamento com ledger
- Botão de refund (habilita quando status = SUCCESS)
- Polling para refletir processamento assíncrono em tempo real

## API

### POST /payments

```json
{ "userId": "uuid", "amount": 100, "idempotencyKey": "string" }
```

Regras:

- se `idempotencyKey` já existe → retorna o mesmo payment
- cria `Payment=PENDING` e enfileira job

### GET /payments

Query:

- `status=SUCCESS,FAILED` (opcional)

### GET /payments/:id

Retorna payment + `ledgerEntries`.

### POST /payments/:id/refund

Enfileira refund (worker cria `CREDIT` e marca `REFUNDED`).

## Testes

```bash
npm test
```

Cobertura mínima (integração):

- pagamento sucesso
- retry até sucesso
- falha → DLQ
- idempotência (mesmo key não duplica)
- concorrência (2 workers não duplicam ledger)
- refund (CREDIT + REFUNDED)
