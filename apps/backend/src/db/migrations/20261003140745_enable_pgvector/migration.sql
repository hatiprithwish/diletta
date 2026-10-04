-- Custom SQL migration (drizzle-kit generate --custom). pgvector provides halfvec for embeddings.
CREATE EXTENSION IF NOT EXISTS vector;
