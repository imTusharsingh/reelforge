-- V10 only. No changes to existing tables or frozen V1 contracts.
CREATE TABLE discovery_records (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL, channel_id UUID NOT NULL,
 schema_version TEXT NOT NULL DEFAULT '1.0', kind TEXT NOT NULL, key TEXT NOT NULL,
 document JSONB NOT NULL, created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX discovery_records_workspace_id_channel_id_kind_key_key ON discovery_records(workspace_id, channel_id, kind, key);
CREATE INDEX discovery_records_workspace_id_channel_id_kind_created_at_idx ON discovery_records(workspace_id, channel_id, kind, created_at);
CREATE TABLE discovery_quotas (
 id TEXT PRIMARY KEY, workspace_id UUID NOT NULL,
 schema_version TEXT NOT NULL DEFAULT '1.0', used INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
 created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE discovery_records ADD CONSTRAINT discovery_records_workspace_id_fkey
 FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE discovery_records ADD CONSTRAINT discovery_records_workspace_id_channel_id_fkey
 FOREIGN KEY (workspace_id, channel_id) REFERENCES channels(workspace_id, id) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE discovery_quotas ADD CONSTRAINT discovery_quotas_workspace_id_fkey
 FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE ON UPDATE CASCADE;
