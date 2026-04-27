# Roteiro de vídeo (2–4 min)

## Setup (pré-gravação)

- Terminais abertos:
  - API: `npm run dev`
  - Worker: `npm run dev:worker`
  - Frontend: `npm run dev:web`
  - (opcional) Redis/DB: `docker compose up -d`
- Browser no dashboard (frontend)
- Deixe o console do worker visível (logs com paymentId/jobId/attempt)

## Gravação

### 1) Mostrar dashboard e criar pagamento (30–45s)

- No frontend:
  - Preencher `userId` e `amount`
  - `idempotencyKey` visível (explicar: “se eu repetir a mesma key, não duplica”)
  - Clicar “Criar + Enfileirar”
- Mostrar que o payment aparece na lista com status `PENDING/PROCESSING`

### 2) Mostrar fila/worker processando (45–60s)

- Ir pro terminal do worker:
  - destacar log com `paymentId`, `jobId`, `attempt`
  - comentar retry quando ocorrer (gateway fake com timeout aleatório)
- Voltar pro frontend:
  - status muda para `SUCCESS` automaticamente (polling)

### 3) Demonstrar idempotência (30–45s)

- No frontend:
  - criar outro pagamento usando a mesma `idempotencyKey`
  - mostrar que o `paymentId` é o mesmo / não criou duplicado

### 4) Demonstrar refund (30–45s)

- Abrir o detalhe do payment (ledger visível)
- Clicar “Refund”
- Mostrar:
  - worker processando refund
  - status vira `REFUNDED`
  - ledger agora tem `DEBIT` + `CREDIT`

### 5) Fechamento (15–30s)

- Reforçar os pontos de arquitetura:
  - “saldo derivado do ledger”
  - “idempotência na API e no worker”
  - “retry + backoff + DLQ”

