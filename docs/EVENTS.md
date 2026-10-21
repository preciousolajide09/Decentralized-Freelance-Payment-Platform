# Contract event catalogue

Every event emitted by the three Soroban contracts, for indexers and clients.
This matches the `#[contractevent]` structs in
`contracts/{escrow,dispute,reputation}/src/lib.rs`.

## How events are shaped

Each event is a struct annotated with `#[contractevent]`, which produces:

- **topic0** — the event name as a `Symbol`, the struct name in `snake_case`
  (e.g. `MilestoneReleased` → `milestone_released`). A subscriber filters on
  this symbol.
- **topic1** — the field annotated `#[topic]`, serialized with its declared type
  (`Address` or `u64`). Each event has exactly one such field.
- **data** — a `ScMap` of the remaining fields, keyed by field-name symbols.

So an RPC `getEvents` filter can match `contractId` + `topics: [[<event symbol>]]`
and, if desired, a second topic for the id/address in the `#[topic]` field.

The backend indexer applies these events to the mirrored state *and* stores every
recognised one in the `ChainEvent` table — the escrow id, the event name, the
amount it moved (in base units), the ledger, and the transaction hash. That table
is what a per-user transaction history (`GET /api/users/:address/transactions`)
and an escrow receipt (`GET /api/escrow/:escrowId/receipt`) read from, since none
of the state tables keeps a transaction hash.

## Escrow — `contracts/escrow`

| Rust type | topic0 (`Symbol`) | topic1 (`#[topic]`) | data fields |
|-----------|-------------------|---------------------|-------------|
| `Created` | `created` | `client: Address` | `escrow_id: u64`, `freelancer: Address`, `total_amount: i128` |
| `Funded` | `funded` | `client: Address` | `escrow_id: u64`, `amount: i128`, `freelancer: Address` |
| `MilestoneReleased` | `milestone_released` | `escrow_id: u64` | `index: u32`, `amount: i128` |

> `MilestoneReleased` is emitted by **both** `release_milestone` and
> `release_partial`, and its `amount` is the sum paid by *that* call — not the
> milestone's total. A consumer must accumulate the amounts for a milestone (and
> compare them against the milestone's amount) to tell a partial release from a
> complete one; the indexer stores that running total in `Milestone.releasedAmount`.
>
> `escrow.resolve` emits only `resolved`, and it sets every milestone's on-chain
> `released_amount` to its full `amount`; the indexer writes the same full amount
> to each milestone when it handles that event.
| `DisputeOpened` | `dispute_opened` | `escrow_id: u64` | `initiator: Address` |
| `Resolved` | `resolved` | `escrow_id: u64` | `client_share: i128`, `freelancer_share: i128` |
| `Refunded` | `refunded` | `escrow_id: u64` | `client: Address`, `amount: i128` |
| `MilestonesUpdated` | `milestones_updated` | `escrow_id: u64` | `count: u32`, `total_amount: i128` |
| `DisputeContractUpdated` | `dispute_contract_updated` | `admin: Address` | `old_contract: Address`, `new_contract: Address` |

## Dispute — `contracts/dispute`

| Rust type | topic0 (`Symbol`) | topic1 (`#[topic]`) | data fields |
|-----------|-------------------|---------------------|-------------|
| `Raised` | `raised` | `escrow_id: u64` | `dispute_id: u64`, `raised_by: Address` |
| `Approved` | `approved` | `dispute_id: u64` | `arbitrator: Address` |
| `DisputeResolved` | `dispute_resolved` | `escrow_id: u64` | `dispute_id: u64`, `client_share: i128`, `freelancer_share: i128` |

## Reputation — `contracts/reputation`

| Rust type | topic0 (`Symbol`) | topic1 (`#[topic]`) | data fields |
|-----------|-------------------|---------------------|-------------|
| `Rated` | `rated` | `escrow_id: u64` | `rater: Address`, `ratee: Address`, `score: u32`, `count: u64`, `total_score: u64` |

`count` and `total_score` are the ratee's **weighted** aggregate after this rating
(see [`REPUTATION.md`](./REPUTATION.md)); `total_score` is `sum(score * weight)`
and `count` the number of ratings that counted.

## Verifying this list against the source

```bash
grep -rn "contractevent" contracts/*/src/lib.rs
```

Each struct listed above should have exactly one corresponding `#[contractevent]`
declaration.
