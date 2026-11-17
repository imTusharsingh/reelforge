CREATE TABLE v9_publish_slots (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, schema_version text NOT NULL DEFAULT '1.0',
 run_id uuid NOT NULL, channel_id uuid NOT NULL, social_account_id uuid NOT NULL,
 scheduled_post_id uuid, scheduled_at timestamptz(6) NOT NULL, timezone text NOT NULL,
 package jsonb NOT NULL, status text NOT NULL DEFAULT 'QUEUED', last_error text,
 created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,run_id), UNIQUE(workspace_id,scheduled_post_id), UNIQUE(workspace_id,channel_id,scheduled_at),
 FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE ON UPDATE CASCADE,
 FOREIGN KEY(workspace_id,channel_id) REFERENCES channels(workspace_id,id) ON DELETE CASCADE ON UPDATE CASCADE,
 FOREIGN KEY(workspace_id,run_id) REFERENCES video_runs(workspace_id,id) ON DELETE CASCADE ON UPDATE CASCADE,
 FOREIGN KEY(workspace_id,scheduled_post_id) REFERENCES scheduled_posts(workspace_id,id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE v9_insert_leases (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, schema_version text NOT NULL DEFAULT '1.0',
 slot_id uuid NOT NULL, project_key text NOT NULL, quota_day text NOT NULL, status text NOT NULL DEFAULT 'RESERVED',
 UNIQUE(workspace_id,slot_id),
 FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE ON UPDATE CASCADE,
 FOREIGN KEY(workspace_id,slot_id) REFERENCES v9_publish_slots(workspace_id,id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX v9_insert_leases_project_key_quota_day_idx ON v9_insert_leases(project_key,quota_day);
