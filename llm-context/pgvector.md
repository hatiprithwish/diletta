# pgvector and Postgres Search Documentation Links

No llms.txt for pgvector or postgresql.org; Neon's is [neon.com/docs/llms.txt](https://neon.com/docs/llms.txt).

## pgvector

- [pgvector README](https://github.com/pgvector/pgvector) — see `#half-precision-vectors`, `#half-precision-indexing`, `#hnsw`, `#iterative-index-scans`, `#filtering`, `#hybrid-search`
- [Neon: the pgvector extension](https://neon.com/docs/extensions/pgvector)
- [Neon: optimize pgvector search](https://neon.com/docs/ai/ai-vector-search-optimization)
- [Neon: supported extensions and versions](https://neon.com/docs/extensions/pg-extensions)
- [Neon: production RAG in Postgres (hybrid, RRF)](https://neon.com/guides/hybrid-rag-postgres-agent)

## Postgres full-text search

- [Full text search (ch. 12)](https://www.postgresql.org/docs/current/textsearch.html)
- [Tables and indexes](https://www.postgresql.org/docs/current/textsearch-tables.html)
- [Controlling text search (ranking)](https://www.postgresql.org/docs/current/textsearch-controls.html)
- [Preferred index types (GIN/GiST)](https://www.postgresql.org/docs/current/textsearch-indexes.html)
- [Neon: full text search with tsvector](https://neon.com/guides/full-text-search)

## Postgres RLS and settings

- [Row security policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [CREATE POLICY](https://www.postgresql.org/docs/current/sql-createpolicy.html)
- [System administration functions (`set_config`)](https://www.postgresql.org/docs/current/functions-admin.html)

## How Diletta uses it

- Embeddings are `halfvec(1024)` from Workers AI. The `vector` extension is a custom SQL migration (`20261003140745_enable_pgvector`). The column and the HNSW index are declared in `tables.ts`, which drizzle-orm `1.0.0-rc.4` supports: `t.halfvec("embedding", { dimensions: 1024 })` and `t.index(...).using("hnsw", table.embedding.op("halfvec_cosine_ops"))`. Columns: `knowledge_chunks.embedding` (HNSW), `doc_gaps.embedding`, `doc_gap_clusters.centroid`.
- `knowledge_chunks.tsv` is a generated `tsvector` (heading weighted A, text B, `english` config) with a GIN index; the type is a `customType` in `tables.ts`.
- HNSW indexes `halfvec` up to 4,000 dimensions, so 1024 fits.
- Hybrid search (M2-6) = `tsvector` + GIN for keywords plus HNSW for vectors, merged by rank. Filters (company, source list) apply after the index scan, so turn on iterative scans (`SET LOCAL hnsw.iterative_scan = relaxed_order` inside the `withTenant` transaction) to keep recall.
- `set_config(name, value, true)` applies only to the current transaction, which is what `withTenant` relies on.
