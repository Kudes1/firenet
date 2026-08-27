-- Confirmed history. Append-only, linear (no branches).
CREATE TABLE versions (
    id           BIGSERIAL PRIMARY KEY,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    confirmed_by UUID REFERENCES users(id),
    draft_id     UUID, -- which draft this version came from; no FK (see below)
    note         TEXT  -- e.g. "restored to v5"
);

-- One row per entity that changed in a given version.
CREATE TABLE entity_changes (
    id         BIGSERIAL PRIMARY KEY,
    version_id BIGINT NOT NULL REFERENCES versions(id),
    kind       TEXT NOT NULL,
    key        TEXT NOT NULL,
    change     TEXT NOT NULL CHECK (change IN ('added', 'modified', 'removed')),
    data       JSONB, -- NULL when change = 'removed'
    author     UUID NOT NULL REFERENCES users(id)
);
CREATE INDEX entity_changes_lookup ON entity_changes (kind, key, version_id DESC);

-- A personal draft: edits layered on top of a specific base version.
CREATE TABLE drafts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner           UUID NOT NULL REFERENCES users(id),
    name            TEXT NOT NULL,
    base_version_id BIGINT NOT NULL REFERENCES versions(id),
    status          TEXT NOT NULL DEFAULT 'open', -- open|conflict|merged|closed
    revision        BIGINT NOT NULL DEFAULT 0,     -- CAS token for WriteDraft
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (owner, name)
);

-- Current state of a draft's edits: one row per entity it touches (not a
-- history — overwritten on every save; the draft holds only real diffs
-- from its base version).
CREATE TABLE draft_entity_changes (
    draft_id UUID NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    kind     TEXT NOT NULL,
    key      TEXT NOT NULL,
    change   TEXT NOT NULL CHECK (change IN ('added', 'modified', 'removed')),
    data     JSONB,
    PRIMARY KEY (draft_id, kind, key)
);
