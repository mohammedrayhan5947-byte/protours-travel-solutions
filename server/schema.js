/* Database schema, applied statement by statement (Neon's HTTP driver runs
   one statement per call). Every statement is idempotent, so re-running
   `npm run db:migrate` is always safe. Money is stored in paise (integers). */
export const SCHEMA = [
  `create table if not exists bookings (
    id                text primary key,          -- unguessable: doubles as the draft's capability
    ref               text unique not null,      -- short reference shown to customers and staff
    status            text not null,
    version           int  not null default 0,   -- optimistic lock for edits to the JSON columns
    journey_type      int  not null,
    is_domestic       boolean not null,
    search            jsonb not null,
    legs              jsonb not null,            -- one entry per PNR (domestic return = 2)
    pax               jsonb,
    contact           jsonb,
    gst               jsonb,
    price             jsonb,
    amount_paise      integer,
    trace_id          text not null,
    trace_started_at  timestamptz not null,
    rzp_order_id      text unique,
    rzp_payment_id    text unique,               -- one payment can never pay for two bookings
    manage_token_hash text,
    claimed_by        text,
    claimed_at        timestamptz,
    attention         text,                      -- why staff need to look at it
    travel_end        date,
    pii_purged_at     timestamptz,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now()
  )`,
  `create index if not exists bookings_status_idx on bookings (status, updated_at)`,

  `create table if not exists booking_events (
    id          bigserial primary key,
    booking_id  text not null references bookings (id) on delete cascade,
    at          timestamptz not null default now(),
    type        text not null,
    data        jsonb
  )`,
  `create index if not exists booking_events_booking_idx on booking_events (booking_id, id)`,

  /* Every TBO request/response, kept for certification ("send API logs in
     JSON") and for disputes. Passwords are never written here. */
  `create table if not exists tbo_logs (
    id           bigserial primary key,
    at           timestamptz not null default now(),
    booking_id   text,
    trace_id     text,
    method       text not null,
    request      jsonb,
    response     jsonb,
    http_status  int,
    ms           int,
    error        text
  )`,
  `create index if not exists tbo_logs_trace_idx on tbo_logs (trace_id)`,
  `create index if not exists tbo_logs_booking_idx on tbo_logs (booking_id)`,

  /* idem_key is unique, so a refund can only ever be created once per
     reason (e.g. one per TBO change request), however many times the
     button is pressed or the job retries. */
  `create table if not exists refunds (
    id             bigserial primary key,
    booking_id     text not null references bookings (id),
    idem_key       text unique not null,
    reason         text not null,
    amount_paise   integer not null check (amount_paise > 0),
    status         text not null,               -- pending | processing | done | failed
    rzp_refund_id  text unique,
    error          text,
    created_by     text,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now()
  )`,

  /* Which payment a refund goes back to: null = the booking's own payment,
     otherwise a change's payment (each change is paid separately). */
  `alter table refunds add column if not exists payment_id text`,

  /* Changes to a ticketed booking, each paid separately:
     kind 'reissue' = date change (TBO re-issuance), 'addons' = seat/meal/
     baggage bought after ticketing (TBO Air Amendment).
     QUOTED → AWAITING_PAYMENT → PAID → PROCESSING → DONE, or ATTENTION (staff). */
  `create table if not exists changes (
    id               text primary key,
    booking_id       text not null references bookings (id) on delete cascade,
    kind             text not null,
    leg              int  not null,
    status           text not null,
    trace_id         text,
    trace_started_at timestamptz,
    quote            jsonb not null,
    summary          jsonb,
    price            jsonb,
    amount_paise     integer,
    rzp_order_id     text unique,
    rzp_payment_id   text unique,
    claimed_by       text,
    claimed_at       timestamptz,
    attempted_at     timestamptz,            -- set BEFORE the TBO call: never sent twice
    result           jsonb,
    attention        text,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now()
  )`,
  `create index if not exists changes_booking_idx on changes (booking_id, created_at)`,
  /* Only one change per booking can be paid for / applied at a time: two tabs
     (or a date change and an add-on) can't both change the same ticket. */
  `create unique index if not exists changes_one_open on changes (booking_id)
     where status in ('AWAITING_PAYMENT', 'PAID', 'PROCESSING')`,

  /* When each search's TraceId was issued: TBO expires it after 15 minutes,
     and the server (not the browser) decides whether there is time left. */
  `create table if not exists traces (
    trace_id    text primary key,
    created_at  timestamptz not null default now()
  )`,

  /* Small shared state: the daily TBO token and short leases that make sure
     only one request does a given job at a time. */
  `create table if not exists kv (
    key         text primary key,
    value       jsonb,
    expires_at  timestamptz
  )`,
]
