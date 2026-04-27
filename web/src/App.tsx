import { type FormEvent, useEffect, useMemo, useState } from "react";
import "./App.css";

type PaymentStatus = "PENDING" | "PROCESSING" | "SUCCESS" | "FAILED" | "REFUNDED";

type Payment = {
  id: string;
  userId: string;
  amount: number;
  status: PaymentStatus;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
};

type LedgerEntry = {
  id: string;
  paymentId: string;
  userId: string;
  type: "DEBIT" | "CREDIT";
  amount: number;
  createdAt: string;
};

type PaymentWithLedger = Payment & { ledgerEntries: LedgerEntry[] };

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : "{}"
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

function formatDate(value: string) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

function StatusPill({ status }: { status: PaymentStatus }) {
  return <span className={`status status--${status.toLowerCase()}`}>{status}</span>;
}

export default function App() {
  const [filter, setFilter] = useState<PaymentStatus | "ALL">("ALL");
  const [payments, setPayments] = useState<Payment[]>([]);
  const [selectedPaymentId, setSelectedPaymentId] = useState<string | null>(null);
  const [selectedPayment, setSelectedPayment] = useState<PaymentWithLedger | null>(null);
  const [isLoadingList, setIsLoadingList] = useState(false);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const listUrl = useMemo(() => {
    if (filter === "ALL") return "/payments";
    return `/payments?status=${filter}`;
  }, [filter]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setIsLoadingList(true);
      try {
        const data = await apiGet<Payment[]>(listUrl);
        if (!cancelled) setPayments(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "unknown_error");
      } finally {
        if (!cancelled) setIsLoadingList(false);
      }
    }

    void load();
    const id = window.setInterval(() => void load(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [listUrl]);

  useEffect(() => {
    if (!selectedPaymentId) return;
    let cancelled = false;

    async function load() {
      setIsLoadingDetail(true);
      try {
        const data = await apiGet<PaymentWithLedger>(`/payments/${selectedPaymentId}`);
        if (!cancelled) setSelectedPayment(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "unknown_error");
      } finally {
        if (!cancelled) setIsLoadingDetail(false);
      }
    }

    void load();
    const id = window.setInterval(() => void load(), 1500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [selectedPaymentId]);

  async function handleCreatePayment(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const form = e.target as HTMLFormElement;
    const formData = new FormData(form);
    const userId = String(formData.get("userId") ?? "");
    const amount = Number(formData.get("amount"));
    const idempotencyKey = String(formData.get("idempotencyKey") ?? "");

    try {
      const payment = await apiPost<Payment>("/payments", { userId, amount, idempotencyKey });
      setSelectedPaymentId(payment.id);
      form.reset();
      (form.elements.namedItem("userId") as HTMLInputElement | null)?.focus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "unknown_error");
    }
  }

  async function handleRefund(paymentId: string) {
    setError(null);
    try {
      await apiPost<{ ok: boolean }>(`/payments/${paymentId}/refund`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "unknown_error");
    }
  }

  return (
    <div className="page">
      <header className="header">
        <div className="header__left">
          <h1>Payment System</h1>
          <div className="muted">Dashboard (polling a cada ~2s)</div>
        </div>
        <div className="header__right">
          <label className="field">
            <div className="field__label">Filtro</div>
            <select value={filter} onChange={(e) => setFilter(e.target.value as any)}>
              <option value="ALL">ALL</option>
              <option value="PENDING">PENDING</option>
              <option value="PROCESSING">PROCESSING</option>
              <option value="SUCCESS">SUCCESS</option>
              <option value="FAILED">FAILED</option>
              <option value="REFUNDED">REFUNDED</option>
            </select>
          </label>
        </div>
      </header>

      {error ? <div className="error">{error}</div> : null}

      <main className="grid">
        <section className="card">
          <h2>Criar pagamento</h2>
          <form className="form" onSubmit={handleCreatePayment}>
            <label className="field">
              <div className="field__label">userId</div>
              <input
                name="userId"
                required
                defaultValue={crypto.randomUUID()}
                placeholder="uuid"
                autoComplete="off"
              />
            </label>
            <label className="field">
              <div className="field__label">amount</div>
              <input name="amount" type="number" required defaultValue={100} min={1} step={1} />
            </label>
            <label className="field">
              <div className="field__label">idempotencyKey</div>
              <input
                name="idempotencyKey"
                required
                defaultValue={`k_${crypto.randomUUID()}`}
                autoComplete="off"
              />
            </label>
            <button type="submit">Criar + Enfileirar</button>
          </form>
        </section>

        <section className="card card--wide">
          <div className="card__header">
            <h2>Pagamentos</h2>
            <div className="muted">{isLoadingList ? "atualizando..." : `${payments.length} itens`}</div>
          </div>

          <div className="table">
            <div className="row row--head">
              <div>ID</div>
              <div>Status</div>
              <div>Amount</div>
              <div>Atualizado</div>
            </div>
            {payments.map((p) => (
              <button
                key={p.id}
                className={`row row--button ${selectedPaymentId === p.id ? "row--selected" : ""}`}
                onClick={() => setSelectedPaymentId(p.id)}
                type="button"
              >
                <div className="mono">{p.id.slice(0, 8)}…</div>
                <div>
                  <StatusPill status={p.status} />
                </div>
                <div>{p.amount}</div>
                <div className="muted">{formatDate(p.updatedAt)}</div>
              </button>
            ))}
          </div>
        </section>

        <section className="card card--wide">
          <div className="card__header">
            <h2>Detalhe</h2>
            <div className="muted">{isLoadingDetail ? "atualizando..." : null}</div>
          </div>

          {!selectedPaymentId ? (
            <div className="muted">Selecione um payment na lista.</div>
          ) : !selectedPayment ? (
            <div className="muted">Carregando…</div>
          ) : (
            <div className="detail">
              <div className="detail__top">
                <div>
                  <div className="muted">paymentId</div>
                  <div className="mono">{selectedPayment.id}</div>
                </div>
                <div>
                  <div className="muted">status</div>
                  <StatusPill status={selectedPayment.status} />
                </div>
                <div>
                  <div className="muted">amount</div>
                  <div>{selectedPayment.amount}</div>
                </div>
                <div>
                  <div className="muted">userId</div>
                  <div className="mono">{selectedPayment.userId}</div>
                </div>
              </div>

              <div className="detail__actions">
                <button
                  type="button"
                  onClick={() => void handleRefund(selectedPayment.id)}
                  disabled={selectedPayment.status !== "SUCCESS"}
                >
                  Refund
                </button>
                <div className="muted">
                  Só habilita quando status = SUCCESS (worker cria CREDIT e marca REFUNDED).
                </div>
              </div>

              <h3>Ledger</h3>
              {selectedPayment.ledgerEntries.length === 0 ? (
                <div className="muted">Sem entradas.</div>
              ) : (
                <div className="table">
                  <div className="row row--head">
                    <div>Type</div>
                    <div>Amount</div>
                    <div>Criado</div>
                  </div>
                  {selectedPayment.ledgerEntries.map((l) => (
                    <div className="row" key={l.id}>
                      <div>
                        <span className={`status status--${l.type.toLowerCase()}`}>{l.type}</span>
                      </div>
                      <div>{l.amount}</div>
                      <div className="muted">{formatDate(l.createdAt)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
